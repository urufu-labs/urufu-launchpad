// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";

interface IERC20BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

interface IERC721BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

/// @title  LoyaltyOracle
/// @notice Reads a user's URU + urufu gemu NFT balance and returns a launch-fee discount
///         in bps. Router consults this on `launch()` / `quote()` to apply the discount.
///         Owner-configurable thresholds so tiers can be re-tuned over time.
///
///         Discount is capped at `MAX_DISCOUNT_BPS` (default 5000 = 50% off). The default
///         schedule below:
///           - Hold ≥ 1 urufu gemu NFT        → 20% off (2000 bps)
///           - Hold ≥ `uruThreshold` URU      → 40% off (4000 bps; default threshold 100,000e18)
///           - Hold BOTH                       → 50% off (5000 bps, capped)
///
/// @dev    LoyaltyOracle takes NO writes on behalf of holders — it only READS the
///         underlying URU + NFT contracts. Zero admin surface over user balances.
contract LoyaltyOracle is Ownable {
    error LoyaltyOracle__ZeroAddress();
    error LoyaltyOracle__BadBps(uint16 bps);

    event ConfigSet(
        address uruToken, address gemuNft,
        uint256 uruThreshold, uint16 nftHolderBps, uint16 uruHolderBps, uint16 bothBps, uint16 maxDiscountBps
    );

    uint16 public constant HARD_MAX_DISCOUNT_BPS = 8_000; // 80% floor on how far we let discounts go

    address public uruToken;
    address public gemuNft;
    uint256 public uruThreshold;
    uint16 public nftHolderBps;
    uint16 public uruHolderBps;
    uint16 public bothBps;
    uint16 public maxDiscountBps;

    constructor(
        address initialOwner,
        address uruToken_,
        address gemuNft_,
        uint256 uruThreshold_
    ) {
        if (initialOwner == address(0)) revert LoyaltyOracle__ZeroAddress();
        _initializeOwner(initialOwner);
        uruToken = uruToken_;
        gemuNft = gemuNft_;
        uruThreshold = uruThreshold_;
        nftHolderBps = 2_000; // 20%
        uruHolderBps = 4_000; // 40%
        bothBps = 5_000;      // 50%
        maxDiscountBps = 5_000;
    }

    /// @notice Return the launch-fee discount in bps for `holder`.
    ///         Router applies as: `discountedFee = fee * (10_000 - discount) / 10_000`.
    function discountBpsFor(address holder) external view returns (uint16) {
        if (holder == address(0)) return 0;
        bool hasNft = gemuNft != address(0) && IERC721BalanceOf(gemuNft).balanceOf(holder) > 0;
        bool hasUru = uruToken != address(0)
            && IERC20BalanceOf(uruToken).balanceOf(holder) >= uruThreshold
            && uruThreshold > 0;
        uint16 discount;
        if (hasNft && hasUru) discount = bothBps;
        else if (hasUru) discount = uruHolderBps;
        else if (hasNft) discount = nftHolderBps;
        else return 0;
        if (discount > maxDiscountBps) discount = maxDiscountBps;
        return discount;
    }

    function setConfig(
        address uruToken_,
        address gemuNft_,
        uint256 uruThreshold_,
        uint16 nftHolderBps_,
        uint16 uruHolderBps_,
        uint16 bothBps_,
        uint16 maxDiscountBps_
    ) external onlyOwner {
        if (
            nftHolderBps_ > HARD_MAX_DISCOUNT_BPS || uruHolderBps_ > HARD_MAX_DISCOUNT_BPS
                || bothBps_ > HARD_MAX_DISCOUNT_BPS || maxDiscountBps_ > HARD_MAX_DISCOUNT_BPS
        ) revert LoyaltyOracle__BadBps(HARD_MAX_DISCOUNT_BPS);
        uruToken = uruToken_;
        gemuNft = gemuNft_;
        uruThreshold = uruThreshold_;
        nftHolderBps = nftHolderBps_;
        uruHolderBps = uruHolderBps_;
        bothBps = bothBps_;
        maxDiscountBps = maxDiscountBps_;
        emit ConfigSet(uruToken_, gemuNft_, uruThreshold_, nftHolderBps_, uruHolderBps_, bothBps_, maxDiscountBps_);
    }
}
