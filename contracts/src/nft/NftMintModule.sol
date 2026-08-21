// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    per-collection mint module.  fixed price OR linear step,
 *    optional WL (via NftWhitelistModule), optional discount
 *    tiers  ❤  every mint auto-splits 90% launcher / 10% flywheel.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {NftDiscountVerifier} from "src/nft/NftDiscountVerifier.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

interface IErc721Mintable {
    function mintBatch(
        address to,
        uint256 quantity
    ) external;
    function totalMinted() external view returns (uint256);
    function maxSupply() external view returns (uint256);
    function transferOwnership(
        address newOwner
    ) external;
    function balanceOf(
        address owner
    ) external view returns (uint256);
}

/// Minimal ERC-20 shape used for URU push transfers. We use direct
/// `transfer(...)` (not `safeTransfer`) so we can distinguish
/// non-standard `return false` from a hard revert, matching the ETH-path
/// try/catch posture — either failure mode routes into `platformStuckUru`.
interface IERC20Min {
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);
}

/// @title  NftMintModule
/// @notice Per-collection mint controller. One clone per launched
///         collection; owns the ERC-721 token contract (has exclusive
///         mint rights via `mintBatch`). Initialized once by
///         `NftLaunchFactory`, then immutable.
///
///         Pricing:
///           - Fixed:  price(n) = basePrice  for all n
///           - Linear: price(n) = basePrice + step * n
///                     where n = number of tokens minted so far
///                     (BEFORE this mint tx). Multi-quantity mints
///                     charge the sum of prices at ids n..n+qty-1.
///
///         Revenue split per mint (post-discount, gross paid ETH):
///           - 90% → accrued to launcher balance (pull via `withdraw`)
///           - 10% → pushed to FeeSplitter (auto-splits into gemu
///                   rewards / URU buyback / treasury per its config)
///
///         Discounts:
///           - Deployer configures 0-N tiers at launch. Each tier is
///             either a walletList (merkle root) or an external-NFT
///             attestation (signed by the platform's attestation
///             signer). Buyer stacks any tiers they qualify for; total
///             discount is capped at `100% - discountFloorBps`. If
///             `discountFloorBps == 0` the launcher must set a
///             `perWalletMintCap > 0` (enforced at initialize time)
///             so free-mint griefers can't drain the supply.
///
///         Pull payout deliberately: eliminates reentrancy surface on
///         the mint path entirely, and stops a malicious launcher
///         from griefing mints by making their receive() revert.
/// @dev    Non-upgradeable. Any per-collection config change requires
///         redeploying the collection.
///
///         Reentrancy: mint() is guarded by a status flag. Even though
///         we use `_mint` (not `_safeMint`) on the ERC-721 side, the
///         FeeSplitter is a trusted contract we control and CANNOT
///         reenter mint() usefully (it only accepts ETH and never
///         calls back into this module). The guard is defense-in-depth
///         against future FeeSplitter changes.
contract NftMintModule {
    // ============================================================
    // Errors
    // ============================================================
    error NftMintModule__AlreadyInitialized();
    error NftMintModule__NotInitialized();
    error NftMintModule__ZeroAddress();
    error NftMintModule__ZeroQuantity();
    /// qty > MAX_MINTS_PER_TX. Enforced against a hardcoded platform cap
    /// (50), tested to fit in a single RH block by fork tests. Buyers
    /// wanting more mint in multiple txs.
    error NftMintModule__QuantityExceedsMax(uint256 requested, uint256 max);
    error NftMintModule__BadMintMode();
    error NftMintModule__BadDiscountFloor(uint256 floorBps);
    error NftMintModule__FreeMintRequiresCap();
    error NftMintModule__MaxSupplyExceeded(uint256 requested, uint256 remaining);
    error NftMintModule__PerWalletCapExceeded(uint256 wouldOwn, uint256 cap);
    error NftMintModule__InsufficientPayment(uint256 required, uint256 provided);
    error NftMintModule__NotWhitelisted();
    error NftMintModule__DiscountExceedsCeiling(uint256 discountBps, uint256 ceilingBps);
    error NftMintModule__AttestationExpired(uint256 expiry, uint256 now_);
    error NftMintModule__BadAttestationSigner();
    error NftMintModule__TierIdOutOfRange(uint256 tierId, uint256 tierCount);
    error NftMintModule__TierKindMismatch(uint256 tierId);
    error NftMintModule__DuplicateTierProof(uint256 tierId);
    error NftMintModule__NotLauncher();
    error NftMintModule__NoBalance();
    error NftMintModule__Reentrancy();
    error NftMintModule__TransferFailed();
    error NftMintModule__OverflowPrice();
    // URU-payment errors
    error NftMintModule__PaymentTokenMismatch();
    error NftMintModule__UruNotConfigured();
    error NftMintModule__EthNotConfigured();
    error NftMintModule__UnexpectedEthSent();
    error NftMintModule__ZeroSink();

    // ============================================================
    // Events
    // ============================================================
    event Initialized(
        address indexed token,
        address indexed launcher,
        MintMode mintMode,
        uint256 basePriceWei,
        uint256 priceStepWei,
        uint256 discountFloorBps,
        uint256 perWalletMintCap,
        address whitelistModule,
        address feeSplitter,
        address attestationSigner,
        address paymentToken, // address(0) = ETH; else ERC-20 addr
        address uruDepositSink // where URU platform slice goes (unused for ETH)
    );
    event Minted(
        address indexed minter,
        uint256 startTokenId,
        uint256 quantity,
        uint256 grossPaidWei, // amount in payment token's smallest unit
        uint256 discountBps,
        bool wlUsed,
        bool paidInUru // false = ETH, true = URU
    );
    event LauncherWithdrew(address indexed to, uint256 amount);
    event LauncherWithdrewUru(address indexed to, uint256 amount);
    event PlatformSlicePushed(address indexed feeSplitter, uint256 amount);
    event PlatformSlicePushedUru(address indexed sink, uint256 amount);
    event PlatformSliceStuck(uint256 amount); // if push failed; safe-swept via `sweepPlatformStuck`
    event PlatformSliceStuckUru(uint256 amount);

    // ============================================================
    // Types
    // ============================================================
    enum MintMode {
        Fixed,
        LinearStep
    }

    /// A discount tier is either walletList (merkle-based) or external
    /// NFT holdings (attestation-based). Deployer configures 0..N tiers.
    enum TierKind {
        WalletList,
        ExternalNft
    }

    struct DiscountTier {
        TierKind kind;
        // For WalletList: the merkle root of eligible wallets.
        // For ExternalNft: unused.
        bytes32 walletListRoot;
        // For ExternalNft only:
        address externalCollection;
        uint256 externalChainId;
        uint256 percentPerNftBps; // e.g. 500 = 5% off per NFT held
        uint256 maxCountedNfts; // cap on NFTs that count toward the discount
        // For WalletList only:
        uint256 fixedDiscountBps; // e.g. 2000 = 20% off
    }

    /// A proof matches a specific tier index the buyer is claiming.
    /// Two-shape struct: `merkleProof` populated for WalletList tiers,
    /// (`count`, `expiry`, `sig`) populated for ExternalNft tiers.
    struct TierProof {
        uint256 tierId;
        bytes32[] merkleProof;
        uint256 count;
        uint256 expiry;
        bytes sig;
    }

    // ============================================================
    // Constants
    // ============================================================
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// 90/10 launcher/platform split. Immutable across all collections
    /// so buyers know what they're paying for at a glance.
    uint256 public constant PLATFORM_SLICE_BPS = 1000; // 10%
    uint256 public constant LAUNCHER_SLICE_BPS = 9000; // 90%
    /// Absolute floor on any individual mint's discount ceiling.
    /// Even a deployer that sets `discountFloorBps == 0` (free-mint
    /// allowed) still can't accidentally overflow past 100%.
    uint256 public constant HARD_DISCOUNT_CEILING_BPS = 10_000;
    /// Max NFTs per single mint tx. Chosen because 50-tok batch fits
    /// comfortably in a single RH block per fork test
    /// (`test_Gap_BatchMint_50Tokens_Fits`). Higher counts risk OOG.
    /// Buyers wanting more mint in multiple txs — no impact on total
    /// they can accumulate (that's `perWalletMintCap`'s job).
    uint256 public constant MAX_MINTS_PER_TX = 50;

    // ============================================================
    // Reentrancy status (defense-in-depth)
    // ============================================================
    uint256 private _reentrancyStatus;

    // ============================================================
    // Init-once state
    // ============================================================
    uint8 private _initialized;

    address public token; // the ERC-721 clone we own
    address public launcher; // who gets 90% (pull withdraw)
    address public feeSplitter; // gets 10% (push each mint)  — ETH path
    address public attestationSigner; // signer for ExternalNft tier proofs
    NftWhitelistModule public whitelistModule; // zero if no WL

    /// Payment token. address(0) means ETH-priced. Any other address
    /// means the collection is ERC-20-priced (typically URU). Set once
    /// at initialize; frozen for the life of the collection.
    address public paymentToken;
    /// Where the URU platform slice flows (typically UruDepositSink).
    /// Zero when `paymentToken == address(0)`.
    address public uruDepositSink;
    /// URU-side balances (accrued for launcher, stuck for platform on
    /// SafeTransferLib failure). Separate from ETH balances so
    /// accounting stays clean when we ever run the same module on both
    /// token types (we don't today — one per collection — but this
    /// keeps the ETH accounting insulated from a URU-path bug).
    uint256 public launcherBalanceUru;
    uint256 public platformStuckUru;

    MintMode public mintMode;
    uint256 public basePriceWei;
    uint256 public priceStepWei; // 0 for Fixed mode
    uint256 public discountFloorBps; // 0 to 10_000; buyer never pays less than this % of base
    uint256 public perWalletMintCap; // 0 = no cap. Enforced by balanceOf(minter) after mint.

    DiscountTier[] private _tiers;

    /// Accrued 90% for the launcher — withdrawn via `withdraw()`.
    uint256 public launcherBalance;
    /// Slice that failed to push to FeeSplitter (should be very rare;
    /// FeeSplitter.receive() distributes and is battle-tested). Owner-
    /// sweepable via `sweepPlatformStuck`. Kept as a separate slot from
    /// `launcherBalance` so a stuck slice CANNOT be withdrawn by the
    /// launcher — it belongs to the platform.
    uint256 public platformStuckBalance;

    // ============================================================
    // Init
    // ============================================================

    struct InitParams {
        address token;
        address launcher;
        address feeSplitter;
        address attestationSigner;
        address whitelistModule; // zero if flavor==Off / no WL module deployed
        MintMode mintMode;
        uint256 basePriceWei; // per-mint price in payment-token smallest unit
        uint256 priceStepWei;
        uint256 discountFloorBps;
        uint256 perWalletMintCap;
        DiscountTier[] tiers;
        address paymentToken; // address(0) = ETH; else ERC-20 addr
        address uruDepositSink; // sink for URU platform slice; zero for ETH
    }

    /// @notice Called once, by `NftLaunchFactory`, immediately after
    ///         clone. All state below is frozen after this returns.
    /// @dev    `data` is `abi.encode(InitParams)` so the factory can
    ///         pass every field in one shot without positional
    ///         parameter drift as fields are added.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert NftMintModule__AlreadyInitialized();
        _initialized = 1;
        _reentrancyStatus = 1;

        InitParams memory p = abi.decode(data, (InitParams));

        if (p.token == address(0)) revert NftMintModule__ZeroAddress();
        if (p.launcher == address(0)) revert NftMintModule__ZeroAddress();
        if (p.attestationSigner == address(0)) revert NftMintModule__ZeroAddress();
        // Payment-mode wiring:
        //   ETH mode  → paymentToken == 0, feeSplitter required, uruDepositSink=0 (ignored)
        //   URU mode  → paymentToken != 0, uruDepositSink required, feeSplitter=0 (unused
        //               on mint path but keep it as 0 to make misconfig loud)
        if (p.paymentToken == address(0)) {
            if (p.feeSplitter == address(0)) revert NftMintModule__ZeroAddress();
        } else {
            if (p.uruDepositSink == address(0)) revert NftMintModule__ZeroSink();
        }
        // whitelistModule is allowed to be zero (means no WL at all)
        if (p.discountFloorBps > BPS_DENOMINATOR) {
            revert NftMintModule__BadDiscountFloor(p.discountFloorBps);
        }
        // Free-mint enabler MUST also set a per-wallet cap.
        if (p.discountFloorBps == 0 && p.perWalletMintCap == 0) {
            revert NftMintModule__FreeMintRequiresCap();
        }
        // Defensive enum bounds; abi.decode of a rogue enum could carry
        // an out-of-range value.
        if (uint8(p.mintMode) > uint8(MintMode.LinearStep)) revert NftMintModule__BadMintMode();

        token = p.token;
        launcher = p.launcher;
        feeSplitter = p.feeSplitter;
        attestationSigner = p.attestationSigner;
        whitelistModule = NftWhitelistModule(p.whitelistModule);
        mintMode = p.mintMode;
        basePriceWei = p.basePriceWei;
        priceStepWei = p.mintMode == MintMode.Fixed ? 0 : p.priceStepWei;
        discountFloorBps = p.discountFloorBps;
        perWalletMintCap = p.perWalletMintCap;
        paymentToken = p.paymentToken;
        uruDepositSink = p.uruDepositSink;

        // Copy tiers into storage. abi.decode into memory then copy
        // one-by-one is the only way to move a struct[] into a
        // storage array in Solidity.
        uint256 n = p.tiers.length;
        for (uint256 i; i < n; ++i) {
            DiscountTier memory t = p.tiers[i];
            // Validate per-tier fields to catch config errors at
            // launch time rather than at first mint.
            if (t.kind == TierKind.WalletList) {
                if (t.walletListRoot == bytes32(0)) revert NftMintModule__ZeroAddress();
                if (t.fixedDiscountBps > BPS_DENOMINATOR) {
                    revert NftMintModule__BadDiscountFloor(t.fixedDiscountBps);
                }
            } else {
                if (t.externalCollection == address(0)) revert NftMintModule__ZeroAddress();
                if (t.percentPerNftBps > BPS_DENOMINATOR) {
                    revert NftMintModule__BadDiscountFloor(t.percentPerNftBps);
                }
                // maxCountedNfts == 0 would make the tier useless (0
                // discount always) but not unsafe. Allow it — deployer's
                // problem.
            }
            _tiers.push(t);
        }

        emit Initialized(
            p.token,
            p.launcher,
            p.mintMode,
            p.basePriceWei,
            p.priceStepWei,
            p.discountFloorBps,
            p.perWalletMintCap,
            p.whitelistModule,
            p.feeSplitter,
            p.attestationSigner,
            p.paymentToken,
            p.uruDepositSink
        );
    }

    // ============================================================
    // Views
    // ============================================================
    function tiersCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tierAt(
        uint256 i
    ) external view returns (DiscountTier memory) {
        return _tiers[i];
    }

    /// @notice Gross ETH cost for `quantity` mints starting from the
    ///         current mint count. Excludes any discount.
    function grossPriceFor(
        uint256 quantity
    ) public view returns (uint256) {
        if (quantity == 0) return 0;
        return _grossPriceFor(quantity, IErc721Mintable(token).totalMinted());
    }

    /// @notice Given a computed discount in bps, compute the net ETH
    ///         cost. Discount is clamped at the module ceiling
    ///         (100% - discountFloorBps).
    function netPriceFor(
        uint256 quantity,
        uint256 discountBps
    ) public view returns (uint256) {
        uint256 gross = grossPriceFor(quantity);
        uint256 clamped = _clampDiscount(discountBps);
        return gross - (gross * clamped) / BPS_DENOMINATOR;
    }

    /// @notice The maximum discount this module will honor.
    ///         (100% - discountFloorBps). Callers sum tier discounts
    ///         then get clamped down to this. Never exceeds
    ///         HARD_DISCOUNT_CEILING_BPS.
    function discountCeilingBps() public view returns (uint256) {
        return BPS_DENOMINATOR - discountFloorBps;
    }

    /// @notice Pure preview — compute total discount bps for a set of
    ///         tier claims. Reverts on invalid claims (out-of-range
    ///         tierId, wrong tier kind, duplicate tierId, bad proof,
    ///         expired attestation). Doesn't check WL — mint() does
    ///         that separately.
    function previewDiscountBps(
        address wallet,
        TierProof[] calldata proofs
    ) external view returns (uint256) {
        return _computeAndVerifyDiscountBps(wallet, proofs);
    }

    // ============================================================
    // Reentrancy guard — modifier form so state acquire/release
    // lives OUTSIDE the function body. Slither's reentrancy-eth
    // detector correctly recognizes this pattern and does not fire
    // on state writes that happen inside the modifier's release.
    // ============================================================
    modifier nonReentrant() {
        if (_reentrancyStatus != 1) revert NftMintModule__Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ============================================================
    // Mint
    // ============================================================

    /// @notice Public entrypoint. Buyer pays ETH, receives `qty` NFTs,
    ///         90% of paid ETH accrues to launcher, 10% flows to
    ///         FeeSplitter for the flywheel.
    /// @param  qty              Number of NFTs to mint. > 0.
    /// @param  wlProof          If WL is walletList flavor, the merkle
    ///                          proof. Empty if no WL or holders flavor.
    /// @param  wlCount          If WL is holders flavor, the buyer's
    ///                          external-NFT balance as signed by the
    ///                          attestation. Zero otherwise.
    /// @param  wlExpiry         Attestation expiry (unix seconds).
    /// @param  wlSig            Attestation signature bytes.
    /// @param  discountProofs   Tier claims — buyer stacks any tiers
    ///                          they qualify for.
    function mint(
        uint256 qty,
        bytes32[] calldata wlProof,
        uint256 wlCount,
        uint256 wlExpiry,
        bytes calldata wlSig,
        TierProof[] calldata discountProofs
    ) external payable nonReentrant {
        // ETH-only path. URU-priced collections use `mintWithUru`.
        if (paymentToken != address(0)) revert NftMintModule__EthNotConfigured();
        if (qty == 0) revert NftMintModule__ZeroQuantity();
        if (qty > MAX_MINTS_PER_TX) revert NftMintModule__QuantityExceedsMax(qty, MAX_MINTS_PER_TX);

        IErc721Mintable tokenC = IErc721Mintable(token);

        // -- 1. Supply cap
        uint256 minted = tokenC.totalMinted();
        uint256 maxS = tokenC.maxSupply();
        if (maxS != 0) {
            uint256 remaining = maxS > minted ? maxS - minted : 0;
            if (qty > remaining) revert NftMintModule__MaxSupplyExceeded(qty, remaining);
        }

        // -- 2. Whitelist gate (if module set + window open)
        bool wlUsed;
        NftWhitelistModule wl = whitelistModule;
        if (address(wl) != address(0)) {
            bool eligible = wl.isEligible(msg.sender, wlProof, wlCount, wlExpiry, wlSig);
            if (!eligible) revert NftMintModule__NotWhitelisted();
            // Whether the WL window is still open — needed for the
            // Minted event so indexers can distinguish WL-phase vs
            // public-phase mints.
            wlUsed = block.timestamp <= wl.wlWindowEnd();
        }

        // -- 3. Discount tiers → total discount bps
        uint256 discountBps = _computeAndVerifyDiscountBps(msg.sender, discountProofs);
        uint256 ceiling = discountCeilingBps();
        // Clamp — deployer's floor wins. This is intentional: buyer
        // sees a valid stacked discount below their raw claim, but
        // NEVER pays less than the floor.
        if (discountBps > ceiling) discountBps = ceiling;

        // -- 4. Compute net cost. Overflow-check the multiplication
        //     inside `_grossPriceFor` — Solidity 0.8 checked math
        //     handles the rest.
        uint256 gross = _grossPriceFor(qty, minted);
        uint256 net = gross - (gross * discountBps) / BPS_DENOMINATOR;
        if (msg.value < net) revert NftMintModule__InsufficientPayment(net, msg.value);

        // -- 5. Mint FIRST (checks-effects-interactions: state change
        //     before external calls). ERC721A `_mint` uses `_mint`
        //     not `_safeMint`, so no receiver hook → no reentrancy.
        tokenC.mintBatch(msg.sender, qty);

        // -- 6. Per-wallet cap check (post-mint, based on balance).
        //     Enforces the cap regardless of whether the buyer
        //     acquired tokens across multiple txs. Cap of 0 means "no cap".
        uint256 cap = perWalletMintCap;
        if (cap != 0) {
            uint256 owns = tokenC.balanceOf(msg.sender);
            if (owns > cap) revert NftMintModule__PerWalletCapExceeded(owns, cap);
        }

        // -- 7. Refund excess ETH (buyer over-paid).
        uint256 refund = msg.value - net;
        // -- 8. Split net into launcher (accrue) + platform (push).
        //     Compute platform slice first for exactness — launcher
        //     absorbs the wei-rounding residue (favors launcher; only
        //     a couple wei per mint, mathematically bounded).
        uint256 platformSlice = (net * PLATFORM_SLICE_BPS) / BPS_DENOMINATOR;
        uint256 launcherSlice = net - platformSlice;
        launcherBalance += launcherSlice;

        // -- 9. External calls in a fixed, safe order.
        //      (a) refund excess to buyer (safeTransferETH handles
        //          reverting-receiver → revert whole tx, which is
        //          acceptable here since it's the buyer's own contract);
        //      (b) push platform slice to FeeSplitter (gas-capped
        //          low-level call — if FeeSplitter reverts, stuck
        //          balance accrues for owner sweep, mint still
        //          succeeds so the buyer keeps their NFTs).
        if (refund > 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
        if (platformSlice > 0) {
            // Call FeeSplitter.receiveFee with proper attribution so
            // indexers can bucket NFT-mint fees separately from ERC-20
            // trade fees. try/catch (not gas-capped low-level call) so
            // FeeSplitter's own 3 downstream sink calls have enough gas
            // (each 100k, plus splitter overhead ≈ 350k total). Trusted
            // target (multisig-owned, one-shot bound at launch), so
            // capping gas would be worse than useless.
            try IFeeReceiver(feeSplitter).receiveFee{value: platformSlice}(launcher, BaseType.ERC721A) {
                emit PlatformSlicePushed(feeSplitter, platformSlice);
            } catch {
                // Stash for owner sweep; don't unwind the mint. The
                // launcher's 90% is safe in `launcherBalance` regardless.
                platformStuckBalance += platformSlice;
                emit PlatformSliceStuck(platformSlice);
            }
        }

        emit Minted(msg.sender, minted, qty, net, discountBps, wlUsed, false);
    }

    /// @notice URU-paid mint entrypoint. Same shape as `mint()` except:
    ///           - not payable (no ETH accepted)
    ///           - caller passes the URU amount they're paying instead of msg.value
    ///           - caller MUST have approved this contract for at least `uruAmount`
    ///           - 90% accrues as URU to launcher (pull `withdrawUru()`)
    ///           - 10% pushed as URU to `uruDepositSink` (keeper drains
    ///             sink→ETH→FeeSplitter, same as ERC-20 launches)
    ///
    /// @dev    URU is priced by the launcher at launch time — buyers should
    ///         see the URU price in the UI just like ETH price. Over-paying
    ///         reverts (unlike ETH we can't refund inside safeTransferFrom;
    ///         easier to make the buyer pass exact amount).
    function mintWithUru(
        uint256 qty,
        uint256 uruAmount,
        bytes32[] calldata wlProof,
        uint256 wlCount,
        uint256 wlExpiry,
        bytes calldata wlSig,
        TierProof[] calldata discountProofs
    ) external nonReentrant {
        address pt = paymentToken;
        if (pt == address(0)) revert NftMintModule__UruNotConfigured();
        if (qty == 0) revert NftMintModule__ZeroQuantity();
        if (qty > MAX_MINTS_PER_TX) revert NftMintModule__QuantityExceedsMax(qty, MAX_MINTS_PER_TX);

        IErc721Mintable tokenC = IErc721Mintable(token);

        // -- 1. Supply cap
        uint256 minted = tokenC.totalMinted();
        uint256 maxS = tokenC.maxSupply();
        if (maxS != 0) {
            uint256 remaining = maxS > minted ? maxS - minted : 0;
            if (qty > remaining) revert NftMintModule__MaxSupplyExceeded(qty, remaining);
        }

        // -- 2. WL gate
        bool wlUsed;
        NftWhitelistModule wl = whitelistModule;
        if (address(wl) != address(0)) {
            bool eligible = wl.isEligible(msg.sender, wlProof, wlCount, wlExpiry, wlSig);
            if (!eligible) revert NftMintModule__NotWhitelisted();
            wlUsed = block.timestamp <= wl.wlWindowEnd();
        }

        // -- 3. Discount
        uint256 discountBps = _computeAndVerifyDiscountBps(msg.sender, discountProofs);
        uint256 ceiling = discountCeilingBps();
        if (discountBps > ceiling) discountBps = ceiling;

        // -- 4. Net cost — same math as ETH path.
        uint256 gross = _grossPriceFor(qty, minted);
        uint256 net = gross - (gross * discountBps) / BPS_DENOMINATOR;
        // URU-path requires exact — no over-pay refunds (safeTransferFrom
        // can't return excess without a second transfer + reentrancy risk).
        if (uruAmount != net) revert NftMintModule__InsufficientPayment(net, uruAmount);

        // -- 5. Pull URU from buyer.
        //     safeTransferFrom reverts on any failure (missing allowance,
        //     insufficient balance, non-standard return).
        SafeTransferLib.safeTransferFrom(pt, msg.sender, address(this), uruAmount);

        // -- 6. Mint (CEI: state change before external calls).
        tokenC.mintBatch(msg.sender, qty);

        // -- 7. Per-wallet cap.
        uint256 cap = perWalletMintCap;
        if (cap != 0) {
            uint256 owns = tokenC.balanceOf(msg.sender);
            if (owns > cap) revert NftMintModule__PerWalletCapExceeded(owns, cap);
        }

        // -- 8. Split into launcher (accrue) + platform (push URU to sink).
        uint256 platformSlice = (uruAmount * PLATFORM_SLICE_BPS) / BPS_DENOMINATOR;
        uint256 launcherSlice = uruAmount - platformSlice;
        launcherBalanceUru += launcherSlice;

        if (platformSlice > 0) {
            // Push URU to UruDepositSink. Try/catch so a sink misconfig
            // stashes rather than bricking the mint (same posture as
            // ETH path).
            try IERC20Min(pt).transfer(uruDepositSink, platformSlice) returns (bool ok) {
                if (ok) {
                    emit PlatformSlicePushedUru(uruDepositSink, platformSlice);
                } else {
                    // Non-reverting `return false` (non-standard ERC-20) — stash.
                    platformStuckUru += platformSlice;
                    emit PlatformSliceStuckUru(platformSlice);
                }
            } catch {
                platformStuckUru += platformSlice;
                emit PlatformSliceStuckUru(platformSlice);
            }
        }

        emit Minted(msg.sender, minted, qty, uruAmount, discountBps, wlUsed, true);
    }

    /// @notice Launcher pulls their accrued 90%. Anyone can call this
    ///         (funds always go to `launcher`) so a keeper can top up
    ///         a launcher wallet whose EOA has no gas.
    function withdraw() external returns (uint256 amount) {
        amount = launcherBalance;
        if (amount == 0) revert NftMintModule__NoBalance();
        launcherBalance = 0;
        // launcher receiving is trusted here (they picked their own
        // address at launch); safeTransferETH is fine.
        SafeTransferLib.safeTransferETH(launcher, amount);
        emit LauncherWithdrew(launcher, amount);
    }

    /// @notice URU-mode analog of `withdraw()`. Pays out accrued URU
    ///         balance to the launcher.
    function withdrawUru() external returns (uint256 amount) {
        amount = launcherBalanceUru;
        if (amount == 0) revert NftMintModule__NoBalance();
        launcherBalanceUru = 0;
        // safeTransfer is safe here — Solady reverts on failure, which
        // is correct because the launcher chose their own address and
        // any failure is their responsibility to fix (contract wallet
        // etc). Balance state was cleared BEFORE the transfer so a
        // partial-execution reentry can't double-withdraw.
        SafeTransferLib.safeTransfer(paymentToken, launcher, amount);
        emit LauncherWithdrewUru(launcher, amount);
    }

    /// @notice URU-mode analog of `sweepPlatformStuck()`.
    /// @dev    Gated to `launcher` for two reasons:
    ///           1. Slither's arbitrary-send-eth-style detectors treat
    ///              storage-derived destinations from permissionless
    ///              functions as user-controllable. Gating the caller
    ///              removes that surface without weakening the sweep.
    ///           2. Prevents a griefer from repeatedly retrying a known-
    ///              failing sink push and burning gas on state churn.
    function sweepPlatformStuckUru() external returns (uint256 amount) {
        if (msg.sender != launcher) revert NftMintModule__NotLauncher();
        amount = platformStuckUru;
        if (amount == 0) revert NftMintModule__NoBalance();
        platformStuckUru = 0;
        try IERC20Min(paymentToken).transfer(uruDepositSink, amount) returns (bool ok) {
            if (!ok) {
                platformStuckUru = amount;
                revert NftMintModule__TransferFailed();
            }
            emit PlatformSlicePushedUru(uruDepositSink, amount);
        } catch {
            platformStuckUru = amount;
            revert NftMintModule__TransferFailed();
        }
    }

    /// @notice Recover a stuck platform slice (rare — only if
    ///         FeeSplitter's receive() reverts on a specific push).
    /// @dev    Gated to `launcher` — funds still always route to the
    ///         `feeSplitter` set at initialize time. Gating removes
    ///         Slither's arbitrary-send-eth surface (storage-derived
    ///         destination from a permissionless function) without
    ///         changing where the money can go.
    function sweepPlatformStuck() external returns (uint256 amount) {
        if (msg.sender != launcher) revert NftMintModule__NotLauncher();
        amount = platformStuckBalance;
        if (amount == 0) revert NftMintModule__NoBalance();
        platformStuckBalance = 0;
        // Retry once. If it fails again, revert — better to leave the
        // balance recorded than lose track by clearing it and failing.
        try IFeeReceiver(feeSplitter).receiveFee{value: amount}(launcher, BaseType.ERC721A) {
            emit PlatformSlicePushed(feeSplitter, amount);
        } catch {
            platformStuckBalance = amount; // undo state change on failure
            revert NftMintModule__TransferFailed();
        }
    }

    // ============================================================
    // Internal — pricing
    // ============================================================
    /// @dev  For LinearStep: sum(base + step*i, i=alreadyMinted..alreadyMinted+qty-1)
    ///       = qty*base + step * sum(i) over that range
    ///       = qty*base + step * (qty*alreadyMinted + qty*(qty-1)/2)
    ///       Solidity 0.8 checked math reverts on any overflow (which
    ///       is desirable — we want a loud failure on absurd inputs
    ///       rather than a wrap). `qty` is bounded by remaining supply
    ///       ≤ maxSupply, which the deployer sets at launch.
    function _grossPriceFor(
        uint256 qty,
        uint256 alreadyMinted
    ) internal view returns (uint256) {
        uint256 base = basePriceWei;
        if (mintMode == MintMode.Fixed) {
            return base * qty;
        }
        uint256 step = priceStepWei;
        uint256 flat = base * qty;
        // sum(i) for i in [alreadyMinted, alreadyMinted+qty-1]
        //   = qty*alreadyMinted + qty*(qty-1)/2
        uint256 sumOfIds = qty * alreadyMinted + (qty * (qty - 1)) / 2;
        return flat + step * sumOfIds;
    }

    // ============================================================
    // Internal — discount verification
    // ============================================================
    function _clampDiscount(
        uint256 discountBps
    ) internal view returns (uint256) {
        uint256 ceiling = discountCeilingBps();
        return discountBps > ceiling ? ceiling : discountBps;
    }

    /// Verifies each tier proof, checks no duplicates, sums the
    /// discount contributions. Returns the raw sum (NOT clamped);
    /// callers clamp at the ceiling. Reverts on any invalid proof.
    ///
    /// Duplicate-tier detection: uses a bitmap so a buyer can't
    /// double-claim the same tier by passing two proofs with the same
    /// `tierId`. Bounded to 256 tiers per collection which is way past
    /// any reasonable use — real launches will have 1-4 tiers.
    function _computeAndVerifyDiscountBps(
        address wallet,
        TierProof[] calldata proofs
    ) internal view returns (uint256) {
        uint256 n = proofs.length;
        if (n == 0) return 0;
        uint256 tierCount = _tiers.length;
        uint256 seenBitmap;
        uint256 total;

        for (uint256 i; i < n; ++i) {
            TierProof calldata p = proofs[i];
            uint256 tierId = p.tierId;
            if (tierId >= tierCount) revert NftMintModule__TierIdOutOfRange(tierId, tierCount);
            if (tierId >= 256) revert NftMintModule__TierIdOutOfRange(tierId, tierCount);
            uint256 bit = uint256(1) << tierId;
            if (seenBitmap & bit != 0) revert NftMintModule__DuplicateTierProof(tierId);
            seenBitmap |= bit;

            DiscountTier storage tier = _tiers[tierId];
            uint256 tierContribution;

            if (tier.kind == TierKind.WalletList) {
                bool valid = NftDiscountVerifier.verifyWalletList(tier.walletListRoot, wallet, p.merkleProof);
                if (!valid) revert NftMintModule__NotWhitelisted();
                tierContribution = tier.fixedDiscountBps;
            } else {
                // ExternalNft attestation
                if (block.timestamp > p.expiry) {
                    revert NftMintModule__AttestationExpired(p.expiry, block.timestamp);
                }
                (address signer, bool ok) = NftDiscountVerifier.verifyExternalNftAttestation(
                    wallet,
                    address(this),
                    tier.externalCollection,
                    tier.externalChainId,
                    tierId,
                    p.count,
                    p.expiry,
                    p.sig,
                    attestationSigner
                );
                signer; // silence unused (kept in return for calling-site debug)
                if (!ok) revert NftMintModule__BadAttestationSigner();
                // Cap holder count at maxCountedNfts, then multiply
                // by percentPerNftBps. Use checked math — overflow
                // would require insane deployer config.
                uint256 counted = p.count > tier.maxCountedNfts ? tier.maxCountedNfts : p.count;
                tierContribution = counted * tier.percentPerNftBps;
            }

            total += tierContribution;
            // Early clamp: once we hit ceiling, stop counting. Prevents
            // uint256 overflow if a rogue deployer configured absurd
            // per-tier bps values.
            if (total >= BPS_DENOMINATOR) {
                return BPS_DENOMINATOR;
            }
        }
        return total;
    }
}
