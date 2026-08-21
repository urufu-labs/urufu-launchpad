// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    NFT launch factory.  deploys a whole collection in one tx:
 *    ERC721 + mint module + optional WL module, wires ownership,
 *    charges launch fee in URU  ❤  everything to the flywheel.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function balanceOf(
        address who
    ) external view returns (uint256);
}

interface ILoyaltyOracleLike {
    function discountBpsFor(
        address holder
    ) external view returns (uint16);
}

interface IInitializable {
    function initialize(
        bytes calldata data
    ) external;
}

/// @title  NftLaunchFactory
/// @notice One-tx NFT-collection deploy. Charges URU launch fee (with
///         LoyaltyOracle discount), clones the ERC-721 impl + mint
///         module + optional WL module, wires ownership, emits a
///         single `CollectionLaunched` event indexers subscribe to.
///
///         Bypasses `Router` entirely. Router is ERC-20-only and
///         doesn't need to change for the NFT stack — that's a
///         deliberate architectural call to avoid a Router redeploy.
///
///         Launch-time knobs (all in one call):
///           - name / symbol / baseURI / maxSupply
///           - mintMode (Fixed | LinearStep) + prices
///           - discountFloorBps + perWalletMintCap
///           - discount tier list (0..N)
///           - WL flavor + config (Off | Holders | WalletList)
///
///         URU fee: `SafeTransferFrom` from launcher to `uruSink`.
///         Launcher must `approve(this, uruAmount)` beforehand.
///         Amount is validated against `minUruFee - loyaltyDiscount`.
///
/// @dev    Owner (multisig) manages impl slots + fee params. Slots
///         are one-shot (set once, cannot rotate) — matches URU-A08
///         posture on the ERC-20 side. Rotation requires deploying a
///         new factory, which is fine — the previous one keeps
///         serving its already-launched collections forever.
contract NftLaunchFactory is Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error NftLaunchFactory__ZeroAddress();
    error NftLaunchFactory__AlreadySet();
    error NftLaunchFactory__NotAContract();
    error NftLaunchFactory__CodeHashMismatch(bytes32 expected, bytes32 actual);
    error NftLaunchFactory__CodeHashNotPinned();
    error NftLaunchFactory__ImplsNotSet();
    error NftLaunchFactory__NameEmpty();
    error NftLaunchFactory__TickerEmpty();
    error NftLaunchFactory__MaxSupplyZero();
    error NftLaunchFactory__BasePriceZeroForFree();
    error NftLaunchFactory__DiscountFloorTooHigh(uint256 bps);
    error NftLaunchFactory__FreeMintRequiresCap();
    error NftLaunchFactory__InsufficientUru(uint256 required, uint256 provided);
    error NftLaunchFactory__NameTaken();

    // ============================================================
    // Events
    // ============================================================
    event ImplsRegistered(address erc721Impl, address mintModuleImpl, address wlModuleImpl);
    event ExpectedCodeHashesSet(bytes32 erc721Hash, bytes32 mintModuleHash, bytes32 wlModuleHash);
    event UruConfigSet(address uru, address uruSink, uint256 minUruFee, address loyaltyOracle);
    event FeeSplitterSet(address feeSplitter);
    event AttestationSignerSet(address signer);
    event CollectionLaunched(
        address indexed token,
        address indexed launcher,
        address mintModule,
        address whitelistModule,
        bytes32 configHash,
        uint256 uruPaid,
        string name,
        string ticker
    );

    // ============================================================
    // Impl slots — set once via owner-only setters
    // ============================================================
    address public erc721Impl;
    address public mintModuleImpl;
    address public wlModuleImpl;

    /// URU-A08 posture: pin the exact expected code hash for each impl
    /// BEFORE `setImpls` is allowed to bind them. Prevents a rogue
    /// owner from binding compromised bytecode.
    bytes32 public expectedErc721Hash;
    bytes32 public expectedMintModuleHash;
    bytes32 public expectedWlModuleHash;

    // ============================================================
    // URU fee wiring
    // ============================================================
    IERC20 public uru;
    address public uruSink;
    uint256 public minUruFee;
    ILoyaltyOracleLike public loyaltyOracle;

    address public feeSplitter;
    address public attestationSigner;

    // ============================================================
    // Name registry (per-factory only; separate from ERC-20 registry).
    // A collection name is namespaced by launcher+name, matching the
    // ERC-20 factory's salt-collision guard.
    // ============================================================
    mapping(bytes32 => bool) public nameSaltTaken;

    // ============================================================
    // Constructor
    // ============================================================
    constructor(
        address initialOwner
    ) {
        if (initialOwner == address(0)) revert NftLaunchFactory__ZeroAddress();
        _initializeOwner(initialOwner);
    }

    // ============================================================
    // Owner config — one-shot setters (impls), rotatable setters (fee)
    // ============================================================

    /// @notice Pin the expected code hashes for each impl. Must be
    ///         called BEFORE `setImpls`. One-shot per hash (pin once,
    ///         cannot rotate).
    function setExpectedCodeHashes(
        bytes32 erc721Hash,
        bytes32 mintModuleHash,
        bytes32 wlModuleHash
    ) external onlyOwner {
        if (expectedErc721Hash != bytes32(0)) revert NftLaunchFactory__AlreadySet();
        if (erc721Hash == bytes32(0) || mintModuleHash == bytes32(0) || wlModuleHash == bytes32(0)) {
            revert NftLaunchFactory__CodeHashNotPinned();
        }
        expectedErc721Hash = erc721Hash;
        expectedMintModuleHash = mintModuleHash;
        expectedWlModuleHash = wlModuleHash;
        emit ExpectedCodeHashesSet(erc721Hash, mintModuleHash, wlModuleHash);
    }

    /// @notice Bind the impl addresses. One-shot; matches URU-A08
    ///         posture on the ERC-20 side.
    function setImpls(
        address erc721Impl_,
        address mintModuleImpl_,
        address wlModuleImpl_
    ) external onlyOwner {
        if (erc721Impl != address(0)) revert NftLaunchFactory__AlreadySet();
        if (expectedErc721Hash == bytes32(0)) revert NftLaunchFactory__CodeHashNotPinned();
        if (erc721Impl_ == address(0) || mintModuleImpl_ == address(0) || wlModuleImpl_ == address(0)) {
            revert NftLaunchFactory__ZeroAddress();
        }
        if (erc721Impl_.code.length == 0 || mintModuleImpl_.code.length == 0 || wlModuleImpl_.code.length == 0) {
            revert NftLaunchFactory__NotAContract();
        }
        _requireCodeHash(erc721Impl_, expectedErc721Hash);
        _requireCodeHash(mintModuleImpl_, expectedMintModuleHash);
        _requireCodeHash(wlModuleImpl_, expectedWlModuleHash);
        erc721Impl = erc721Impl_;
        mintModuleImpl = mintModuleImpl_;
        wlModuleImpl = wlModuleImpl_;
        emit ImplsRegistered(erc721Impl_, mintModuleImpl_, wlModuleImpl_);
    }

    function setUruConfig(
        IERC20 uru_,
        address uruSink_,
        uint256 minUruFee_,
        ILoyaltyOracleLike loyaltyOracle_
    ) external onlyOwner {
        if (address(uru_) == address(0) || uruSink_ == address(0)) revert NftLaunchFactory__ZeroAddress();
        uru = uru_;
        uruSink = uruSink_;
        minUruFee = minUruFee_;
        loyaltyOracle = loyaltyOracle_;
        emit UruConfigSet(address(uru_), uruSink_, minUruFee_, address(loyaltyOracle_));
    }

    function setFeeSplitter(
        address feeSplitter_
    ) external onlyOwner {
        if (feeSplitter_ == address(0)) revert NftLaunchFactory__ZeroAddress();
        feeSplitter = feeSplitter_;
        emit FeeSplitterSet(feeSplitter_);
    }

    function setAttestationSigner(
        address signer
    ) external onlyOwner {
        if (signer == address(0)) revert NftLaunchFactory__ZeroAddress();
        attestationSigner = signer;
        emit AttestationSignerSet(signer);
    }

    // ============================================================
    // Views
    // ============================================================
    function minUruFeeFor(
        address launcher
    ) external view returns (uint256) {
        return _minUruFeeFor(launcher);
    }

    // ============================================================
    // Launch
    // ============================================================

    /// User-facing launch params. Struct kept here (not in a shared
    /// types file) so this factory is self-contained.
    struct LaunchParams {
        string name;
        string ticker;
        string baseURI;
        uint256 maxSupply;

        // Mint mechanic
        NftMintModule.MintMode mintMode;
        uint256 basePriceWei; // per-mint price in payment-token smallest unit
        uint256 priceStepWei;
        uint256 discountFloorBps;
        uint256 perWalletMintCap;

        // Payment mode
        //   payWithUru == false → paymentToken = address(0)  (ETH-priced)
        //   payWithUru == true  → paymentToken = URU addr    (URU-priced)
        // Deployer picks ONE per collection; can't be changed after launch.
        bool payWithUru;

        // Discount tiers
        NftMintModule.DiscountTier[] tiers;

        // Whitelist config
        NftWhitelistModule.Flavor wlFlavor;
        address wlHoldersTarget;
        uint256 wlHoldersTargetChainId;
        uint256 wlHoldersMinCount;
        bytes32 wlWalletListRoot;
        uint256 wlWindowEnd;

        // URU launch fee (paid at collection deploy — separate from mint
        // payment mode above; on-chain recomputed + rejected if too low)
        uint256 uruAmount;
    }

    /// @notice Launch a full NFT collection in one tx.
    /// @dev    Sequence:
    ///           1. Sanity + fee gates (fail fast, no state changes yet).
    ///           2. Pull URU from launcher to sink.
    ///           3. Clone ERC-721 impl → initialize with (this) as owner
    ///              so we can transferOwnership to the mint module.
    ///           4. Clone WL module (if flavor != Off) → initialize.
    ///           5. Clone mint module → initialize.
    ///           6. transferOwnership(erc721 → mintModule).
    ///           7. Emit event.
    function launch(
        LaunchParams calldata p
    ) external returns (address token, address mintModule, address whitelistModule) {
        // Non-payable by design — Solidity rejects any msg.value at the
        // ABI dispatch layer, so a `NftLaunchFactory__UnexpectedETH`
        // guard is unreachable and omitted. URU is the only payment.

        // -- 1. Sanity gates.
        if (erc721Impl == address(0)) revert NftLaunchFactory__ImplsNotSet();
        if (bytes(p.name).length == 0) revert NftLaunchFactory__NameEmpty();
        if (bytes(p.ticker).length == 0) revert NftLaunchFactory__TickerEmpty();
        if (p.maxSupply == 0) revert NftLaunchFactory__MaxSupplyZero();
        if (p.discountFloorBps > 10_000) revert NftLaunchFactory__DiscountFloorTooHigh(p.discountFloorBps);
        // If discountFloor == 0 (free-mint enabler), perWalletCap MUST be
        // set — otherwise the mint module init will revert anyway, but
        // failing here saves the launcher an ineffective URU payment.
        if (p.discountFloorBps == 0 && p.perWalletMintCap == 0) {
            revert NftLaunchFactory__FreeMintRequiresCap();
        }

        // -- 2. URU launch fee.
        uint256 required = _minUruFeeFor(msg.sender);
        if (p.uruAmount < required) revert NftLaunchFactory__InsufficientUru(required, p.uruAmount);
        if (p.uruAmount > 0) {
            SafeTransferLib.safeTransferFrom(address(uru), msg.sender, uruSink, p.uruAmount);
        }

        // -- 3. Name-salt uniqueness. Namespaced by launcher so two
        //     different launchers can pick the same name.
        bytes32 saltKey = keccak256(abi.encode(msg.sender, p.name, p.ticker));
        if (nameSaltTaken[saltKey]) revert NftLaunchFactory__NameTaken();
        nameSaltTaken[saltKey] = true;

        // -- 4. Clone the ERC-721 with `this` as initial owner. We
        //     transfer ownership to the mint module at the end.
        token = LibClone.cloneDeterministic(erc721Impl, saltKey);
        {
            // ERC721ATemplate.initialize(data) expects:
            //   (address initialOwner, string name, string symbol,
            //    string baseURI, uint256 maxSupply, bytes[] moduleData)
            bytes[] memory noModules = new bytes[](0);
            bytes memory initErc = abi.encode(address(this), p.name, p.ticker, p.baseURI, p.maxSupply, noModules);
            IInitializable(token).initialize(initErc);
        }

        // -- 5. Whitelist module (if flavor != Off).
        if (p.wlFlavor != NftWhitelistModule.Flavor.Off) {
            whitelistModule = LibClone.cloneDeterministic(wlModuleImpl, keccak256(abi.encode(saltKey, "wl")));
            bytes memory initWl = abi.encode(
                p.wlFlavor,
                p.wlHoldersTarget,
                p.wlHoldersTargetChainId,
                p.wlHoldersMinCount,
                p.wlWalletListRoot,
                p.wlWindowEnd,
                attestationSigner,
                token
            );
            IInitializable(whitelistModule).initialize(initWl);
        }

        // -- 6. Mint module.
        mintModule = LibClone.cloneDeterministic(mintModuleImpl, keccak256(abi.encode(saltKey, "mint")));
        {
            // Payment routing:
            //   ETH-priced  → paymentToken=0, feeSplitter=<factory's>, uruDepositSink=0
            //   URU-priced  → paymentToken=<uru addr>, feeSplitter=0, uruDepositSink=<factory's>
            address ptForMint = p.payWithUru ? address(uru) : address(0);
            address feeSplitterForMint = p.payWithUru ? address(0) : feeSplitter;
            address uruSinkForMint = p.payWithUru ? uruSink : address(0);
            NftMintModule.InitParams memory mp = NftMintModule.InitParams({
                token: token,
                launcher: msg.sender,
                feeSplitter: feeSplitterForMint,
                attestationSigner: attestationSigner,
                whitelistModule: whitelistModule,
                mintMode: p.mintMode,
                basePriceWei: p.basePriceWei,
                priceStepWei: p.priceStepWei,
                discountFloorBps: p.discountFloorBps,
                perWalletMintCap: p.perWalletMintCap,
                tiers: p.tiers,
                paymentToken: ptForMint,
                uruDepositSink: uruSinkForMint
            });
            IInitializable(mintModule).initialize(abi.encode(mp));
        }

        // -- 7. Hand ownership of the ERC-721 to the mint module.
        ERC721ATemplate(token).transferOwnership(mintModule);

        emit CollectionLaunched(token, msg.sender, mintModule, whitelistModule, saltKey, p.uruAmount, p.name, p.ticker);
    }

    // ============================================================
    // Internal
    // ============================================================
    function _minUruFeeFor(
        address launcher
    ) internal view returns (uint256) {
        uint256 floor = minUruFee;
        if (floor == 0) return 0;
        ILoyaltyOracleLike oracle = loyaltyOracle;
        if (address(oracle) == address(0)) return floor;
        uint16 discountBps = oracle.discountBpsFor(launcher);
        if (discountBps >= 10_000) return 0;
        return floor - (floor * discountBps) / 10_000;
    }

    function _requireCodeHash(
        address impl,
        bytes32 expected
    ) internal view {
        bytes32 actual = keccak256(impl.code);
        if (actual != expected) revert NftLaunchFactory__CodeHashMismatch(expected, actual);
    }
}
