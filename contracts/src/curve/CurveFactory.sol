// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "./BondingCurve.sol";

/// @title  CurveFactory
/// @notice Deploys a `BondingCurve` clone for each launched token via EIP-1167. The caller
///         (usually the token owner, immediately after Router.launch) transfers `curveSupply`
///         tokens into the clone and starts trading. One curve per token — the factory tracks
///         the mapping so the trade page can look up the curve for any token address.
/// @dev    The curve template is pinned at deploy time; `setImpl` is intentionally omitted so
///         the on-chain topology is immutable-once-registered, matching the Phase 1 factory
///         pattern. Fee params (bps, graduation target, virtual reserves) come from the
///         factory owner via `setDefaults` — one shape for the whole platform, MVP-scope.
contract CurveFactory is Ownable {
    error CurveFactory__ZeroAddress();
    error CurveFactory__CurveExists(address token);
    error CurveFactory__NotEnoughSupply(uint256 requested, uint256 balance);

    event CurveCreated(address indexed token, address indexed curve, address indexed launcher);
    event DefaultsSet(
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps
    );
    event FeeReceiverSet(address feeReceiver);
    event GraduatorSet(address graduator);

    address public immutable implementation;

    address public feeReceiver;
    address public graduator;
    uint256 public defaultCurveSupply;
    uint256 public defaultVirtualTokenReserve;
    uint256 public defaultVirtualEthReserve;
    uint256 public defaultGraduationTargetEth;
    uint16 public defaultTradeFeeBps;

    mapping(address token => address curve) public curveFor;

    constructor(
        address owner_,
        address feeReceiver_,
        address curveImpl
    ) {
        if (owner_ == address(0) || feeReceiver_ == address(0) || curveImpl == address(0)) {
            revert CurveFactory__ZeroAddress();
        }
        _initializeOwner(owner_);
        implementation = curveImpl;
        feeReceiver = feeReceiver_;

        // Sepolia-friendly defaults — mainnet deploy overrides via setDefaults. Constraint:
        // graduationTargetEth < curveSupply * virtualEth / virtualToken so the curve doesn't
        // exhaust before graduation. Here: 4 < 800M*5/800M = 5, ~89M tokens remain at grad.
        defaultCurveSupply = 800_000_000e18;
        defaultVirtualTokenReserve = 800_000_000e18;
        defaultVirtualEthReserve = 5 ether;
        defaultGraduationTargetEth = 4 ether;
        defaultTradeFeeBps = 100; // 1%
    }

    function setDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_
    ) external onlyOwner {
        defaultCurveSupply = curveSupply_;
        defaultVirtualTokenReserve = virtualTokenReserve_;
        defaultVirtualEthReserve = virtualEthReserve_;
        defaultGraduationTargetEth = graduationTargetEth_;
        defaultTradeFeeBps = tradeFeeBps_;
        emit DefaultsSet(curveSupply_, virtualTokenReserve_, virtualEthReserve_, graduationTargetEth_, tradeFeeBps_);
    }

    function setFeeReceiver(
        address feeReceiver_
    ) external onlyOwner {
        if (feeReceiver_ == address(0)) revert CurveFactory__ZeroAddress();
        feeReceiver = feeReceiver_;
        emit FeeReceiverSet(feeReceiver_);
    }

    function setGraduator(
        address graduator_
    ) external onlyOwner {
        graduator = graduator_; // zero is allowed — disables v4 graduation
        emit GraduatorSet(graduator_);
    }

    /// @notice Deploy a curve for `token`. Caller must have approved the factory to pull
    ///         `defaultCurveSupply` tokens (or must transfer them to the curve after this
    ///         call). Enforced pre-check: caller balance ≥ supply so we fail fast.
    function createCurve(
        address token
    ) external returns (address curve) {
        if (token == address(0)) revert CurveFactory__ZeroAddress();
        if (curveFor[token] != address(0)) revert CurveFactory__CurveExists(token);

        uint256 supply = defaultCurveSupply;
        uint256 bal = IERC20(token).balanceOf(msg.sender);
        if (bal < supply) revert CurveFactory__NotEnoughSupply(supply, bal);

        // Deterministic clone address per (token, chainid) — same predictability as
        // Phase 1's ImplRegistry.
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);

        curveFor[token] = curve;

        // Pull tokens from caller into curve, then initialize.
        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);

        BondingCurve(payable(curve))
            .initialize(
                token,
                feeReceiver,
                supply,
                defaultVirtualTokenReserve,
                defaultVirtualEthReserve,
                defaultGraduationTargetEth,
                defaultTradeFeeBps,
                graduator
            );

        emit CurveCreated(token, curve, msg.sender);
    }

    function predictCurveAddress(
        address token
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }
}
