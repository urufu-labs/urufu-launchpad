// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface ICurveFactoryLike {
    function createCurve(
        address token
    ) external returns (address curve);
    function createCurveWithConfig(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external returns (address curve);
    function defaultCurveSupply() external view returns (uint256);
}

interface IERC20Like {
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

interface ILoyaltyOracleLike {
    function discountBpsFor(
        address holder
    ) external view returns (uint16);
}

/// @notice Called by Router to deploy the actual token contract. Every base-type factory
///         (`ERC20Factory`, `ERC721AFactory`, `ERC1155Factory`) implements this.
interface IVMFactory {
    function deploy(
        string calldata name,
        string calldata ticker,
        bytes32 configHash,
        bytes calldata initData,
        address launcher
    ) external returns (address token);
}

/// @notice Minimal ownership interface. Every launched token must implement it — either via
///         Solady `Ownable` (default) or a compatible surface. Router calls this after the
///         factory returns; template contracts have Router set as owner at initialize time.
interface IOwnable {
    function transferOwnership(
        address newOwner
    ) external;
    function renounceOwnership() external;
}

/// @title  Router
/// @notice User-facing entry to the launchpad. Collects the launch fee, dispatches to the correct
///         base-type factory, atomically reserves the name in `NameRegistry`, dispatches ownership
///         per the launcher's chosen mode, refunds any excess ETH, and emits `Launched`.
/// @dev    See docs/SPEC-router.md. `nonReentrant` on `launch`; owner is a multisig post-deploy;
///         `paused` is flagged as a censorship vector — mitigations documented in the SPEC.
contract Router is Ownable, ReentrancyGuard {
    // ============================================================
    // Errors
    // ============================================================

    error Router__Paused();
    error Router__InsufficientFee(uint256 quoted, uint256 provided);
    error Router__FactoryUnset(BaseType base);
    error Router__EmptyName();
    error Router__EmptyTicker();
    error Router__ZeroAddress();
    error Router__DeployFailed();
    error Router__CurveFactoryUnset();
    error Router__CurveOnlyForERC20();

    // ============================================================
    // Events
    // ============================================================

    event Launched(
        address indexed token,
        address indexed launchedBy,
        BaseType indexed base,
        bytes32 nameHash,
        bytes32 tickerHash,
        uint256 feePaid,
        bool installedHook,
        bool installedGovernance
    );
    event FactorySet(BaseType indexed base, address indexed factory);
    event FeeSet(BaseType indexed base, uint256 weiAmount);
    event AddOnFeesSet(uint256 moduleAddOn, uint256 hookAddOn, uint256 governanceAddOn);
    event PausedSet(bool paused);
    event Swept(address indexed to, uint256 amount);
    event CurveFactorySet(address indexed factory);
    event CurveInstalled(address indexed token, address indexed curve);
    event LoyaltyOracleSet(address indexed oracle);
    event LoyaltyDiscountApplied(address indexed launcher, uint256 grossFee, uint256 discountBps, uint256 netFee);

    // ============================================================
    // Immutable state
    // ============================================================

    NameRegistry public immutable registry;
    IFeeReceiver public immutable feeReceiver;

    // ============================================================
    // Mutable state
    // ============================================================

    mapping(BaseType => address) public factories;
    mapping(BaseType => uint256) public fees;
    uint256 public moduleAddOnFee;
    uint256 public hookAddOnFee;
    uint256 public governanceAddOnFee;
    address public curveFactory;
    address public loyaltyOracle;
    bool public paused;

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address initialOwner,
        NameRegistry _registry,
        IFeeReceiver _feeReceiver,
        uint256 erc20Fee_,
        uint256 nftFee_,
        uint256 erc1155Fee_,
        uint256 moduleAddOn_,
        uint256 hookAddOn_,
        uint256 governanceAddOn_
    ) {
        if (address(_registry) == address(0) || address(_feeReceiver) == address(0)) {
            revert Router__ZeroAddress();
        }
        _initializeOwner(initialOwner);
        registry = _registry;
        feeReceiver = _feeReceiver;

        fees[BaseType.ERC20] = erc20Fee_;
        fees[BaseType.ERC721A] = nftFee_;
        fees[BaseType.ERC1155] = erc1155Fee_;
        moduleAddOnFee = moduleAddOn_;
        hookAddOnFee = hookAddOn_;
        governanceAddOnFee = governanceAddOn_;

        emit FeeSet(BaseType.ERC20, erc20Fee_);
        emit FeeSet(BaseType.ERC721A, nftFee_);
        emit FeeSet(BaseType.ERC1155, erc1155Fee_);
        emit AddOnFeesSet(moduleAddOn_, hookAddOn_, governanceAddOn_);
    }

    // ============================================================
    // Public
    // ============================================================

    /// @notice Launch a new token. Payable — fee is `quote(params)` in wei.
    /// @dev    Ordering: fee forward → factory.deploy → registry.reserve → ownership dispatch →
    ///         refund → emit. Reverts on any failure and unwinds the whole tx.
    function launch(
        LaunchParams calldata params
    ) external payable nonReentrant returns (address token) {
        if (paused) revert Router__Paused();

        uint256 fee = _quoteFor(params, msg.sender);
        if (msg.value < fee) revert Router__InsufficientFee(fee, msg.value);

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);

        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        // Interactions.
        feeReceiver.receiveFee{value: fee}(msg.sender, params.base);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // Bonding-curve install runs BEFORE ownership dispatch so Router still holds the
        // curve-supply tokens (as initialRecipient) and can approve the factory. UI sets
        // initialRecipient = address(Router) and initialSupply = curveFactory.defaultCurveSupply()
        // when this flag is on; approve is exact-amount so Router keeps zero balance after.
        if (params.installBondingCurve) {
            if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
            if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
            uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
            IERC20Like(token).approve(curveFactory, supply);
            address curve = ICurveFactoryLike(curveFactory).createCurveWithConfig(
                token, params.antiSniperBlocks, params.buybackBurnBps
            );
            emit CurveInstalled(token, curve);
        }

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            SafeTransferLib.safeTransferETH(msg.sender, refund);
        }

        emit Launched(
            token, msg.sender, params.base, nameHash, tickerHash, fee, params.installHook, params.installGovernance
        );
    }

    /// @notice Preview the fee for a given config. Matches what `launch` charges exactly.
    function quote(
        LaunchParams calldata params
    ) external view returns (uint256) {
        return _quote(params);
    }

    /// @notice Quote for a specific launcher, applying any LoyaltyOracle discount.
    ///         Frontend calls this to preview the ACTUAL fee a user will be charged.
    function quoteFor(
        LaunchParams calldata params,
        address launcher
    ) external view returns (uint256) {
        return _quoteFor(params, launcher);
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================

    function setFactory(
        BaseType base,
        address factory
    ) external onlyOwner {
        if (factory == address(0)) revert Router__ZeroAddress();
        factories[base] = factory;
        emit FactorySet(base, factory);
    }

    function setCurveFactory(
        address factory
    ) external onlyOwner {
        if (factory == address(0)) revert Router__ZeroAddress();
        curveFactory = factory;
        emit CurveFactorySet(factory);
    }

    /// @notice Set the LoyaltyOracle used to apply launch-fee discounts to holders of
    ///         URU + urufu gemu NFTs. Zero disables discounts.
    function setLoyaltyOracle(
        address oracle
    ) external onlyOwner {
        loyaltyOracle = oracle;
        emit LoyaltyOracleSet(oracle);
    }

    function setFee(
        BaseType base,
        uint256 weiAmount
    ) external onlyOwner {
        fees[base] = weiAmount;
        emit FeeSet(base, weiAmount);
    }

    function setAddOnFees(
        uint256 module_,
        uint256 hook_,
        uint256 governance_
    ) external onlyOwner {
        moduleAddOnFee = module_;
        hookAddOnFee = hook_;
        governanceAddOnFee = governance_;
        emit AddOnFeesSet(module_, hook_, governance_);
    }

    function setPaused(
        bool p
    ) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Recover ETH stranded in Router (should be effectively never called).
    function sweepStuckETH(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert Router__ZeroAddress();
        uint256 amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    // ============================================================
    // Internal
    // ============================================================

    function _quote(
        LaunchParams calldata params
    ) internal view returns (uint256) {
        uint256 baseFee = fees[params.base];
        uint256 extraModules = params.moduleCount > 0 ? params.moduleCount - 1 : 0;
        return baseFee + moduleAddOnFee * extraModules + (params.installHook ? hookAddOnFee : 0)
            + (params.installGovernance ? governanceAddOnFee : 0);
    }

    /// @dev Applies LoyaltyOracle discount when configured. `discountBps ≤ 10_000` is
    ///      enforced by LoyaltyOracle itself; we clamp defensively.
    function _quoteFor(
        LaunchParams calldata params,
        address launcher
    ) internal view returns (uint256) {
        uint256 gross = _quote(params);
        address oracle = loyaltyOracle;
        if (oracle == address(0) || launcher == address(0)) return gross;
        uint16 discountBps = ILoyaltyOracleLike(oracle).discountBpsFor(launcher);
        if (discountBps >= 10_000) return 0;
        return gross - (gross * discountBps) / 10_000;
    }

    function _dispatchOwnership(
        address token,
        OwnershipMode mode,
        address target,
        address launcher
    ) internal {
        IOwnable ownable = IOwnable(token);
        if (mode == OwnershipMode.Renounce) {
            ownable.renounceOwnership();
        } else if (mode == OwnershipMode.TransferToMultisig) {
            ownable.transferOwnership(target);
        } else {
            // KeepEOA
            ownable.transferOwnership(launcher);
        }
    }
}
