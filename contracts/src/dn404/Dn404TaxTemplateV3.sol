// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {DN404} from "dn404/DN404.sol";
import {Dn404TaxTemplateV2} from "./Dn404TaxTemplateV2.sol";

/// @title  Dn404TaxTemplateV3
/// @notice Dn404TaxTemplateV2 plus one rule: transfers INTO the Uniswap v4
///         PoolManager are untaxed, so taxed DN404 tokens can be sold through
///         Uniswap's own app and router in the normal order.
///
/// @dev **Why V3 exists (2026-10-02).** v4 settles by measuring what actually
///      arrived at the PoolManager. Under V2 a user SELL pays the pool through
///      a taxed transfer, so the pool receives `amount - tax` while the router
///      settles `amount`, and the swap reverts. Only routers that settle first
///      and then swap the open credit (our site's order) could sell. Uniswap's
///      app and the Universal Router's normal order
///      (SWAP_EXACT_IN_SINGLE -> SETTLE_ALL -> TAKE_ALL) pay the pool straight
///      from the user's wallet via Permit2, i.e. `user -> PoolManager`. Making
///      that hop untaxed lets those sells settle exactly.
///
/// @dev **Scope of the rule:** `to == POOL_MANAGER` only.
///        - Pool SELLS (anything paying the PoolManager) are untaxed.
///        - Pool BUYS (`PoolManager -> buyer`) stay taxed: the PoolManager pays
///          the full amount and the buyer nets `amount - tax`, which settles
///          fine, so buys keep funding the launch's tax destination.
///        - Wallet-to-wallet transfers stay taxed.
///        - Aggregators that first pull tokens into their OWN contract and only
///          then pay the pool are still taxed on that first hop (wallet ->
///          router), so they still settle short unless they are fee-on-transfer
///          aware. This template does not, and cannot from the token side, fix
///          that; it fixes the Uniswap app / Permit2-direct path.
///
/// @dev **Storage:** declares NO state. Inherits V1/V2's layout unchanged, so
///      the Dn404LaunchFactory clone + `initialize` + `initializeTax(bytes)`
///      path is identical. POOL_MANAGER is a constructor immutable in the impl's
///      runtime code, shared by every LibClone proxy that delegatecalls it.
contract Dn404TaxTemplateV3 is Dn404TaxTemplateV2 {
    error Dn404TaxTemplateV3__ZeroPoolManager();

    address public immutable POOL_MANAGER;

    constructor(
        address graduatorEth_,
        address graduatorPair_,
        address hookEth_,
        address hookPair_,
        address poolManager_
    ) Dn404TaxTemplateV2(graduatorEth_, graduatorPair_, hookEth_, hookPair_) {
        if (poolManager_ == address(0)) revert Dn404TaxTemplateV3__ZeroPoolManager();
        POOL_MANAGER = poolManager_;
    }

    /// @dev Transfers paying the PoolManager skip tax; everything else takes
    ///      V2's path (system exemptions, then V1's taxed split).
    function _transfer(address from, address to, uint256 amount) internal virtual override {
        if (to == POOL_MANAGER) {
            DN404._transfer(from, to, amount);
            return;
        }
        super._transfer(from, to, amount);
    }
}
