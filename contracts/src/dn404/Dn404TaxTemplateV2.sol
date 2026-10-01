// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {DN404} from "dn404/DN404.sol";
import {Dn404TaxTemplate} from "./Dn404TaxTemplate.sol";

/// @title  Dn404TaxTemplateV2
/// @notice Dn404TaxTemplate plus a fixed set of platform-system exemptions,
///         so taxed DN404 launches can graduate into Uniswap v4 and keep
///         working there.
///
/// @dev **Why V2 exists (found 2026-10-01, Dn404TaxedGraduationFork.t.sol).**
///      Uniswap v4 settles by measuring what actually arrived at the
///      PoolManager. V1 taxes every transfer that is not exempt, and the only
///      exemptions were factory, curve, launcher, feeSplitter. Graduation does
///      `graduator -> PoolManager` (sync / transfer / settle), which V1 taxed,
///      so the pool received less than the graduator settled and every taxed
///      launch reverted `CurrencyNotSettled()` at graduation, in EVERY tax
///      mode including BurnDead. The curve would stall just under its target.
///
/// @dev **Exemptions added (any transfer where `from` OR `to` is one of these
///      is untaxed, exactly like V1's `taxExempt` mapping):**
///        - `GRADUATOR_ETH`  (GraduatorV3, ETH-paired DN404 graduations via the
///          V10 CurveFactory) and `GRADUATOR_PAIR` (Dn404Graduator, ERC-20
///          paired graduations). Both move the launched token only as sender:
///          the LP settle into the PoolManager and the excess burn to 0xdEaD.
///        - `HOOK_ETH` / `HOOK_PAIR` (the two MultiHookHosts those graduators
///          bind pools to). On a pool BUY the hook's afterSwap
///          `poolManager.take(token, hook, fee + burn)` moves the launched
///          token PoolManager -> hook. Taxed, the hook would receive less than
///          it books into `owed[...]`, so the last fee claimant could not be
///          paid. Hook -> 0xdEaD (buyback burn) and hook -> platform/creator
///          (fee claims) are covered by the same exemption.
///        - the current `keeper` (dynamic, governance-rotated). The keeper
///          only ever moves swept tax; exempting it lets the keeper swap / add
///          liquidity through standard v4 routers. Without it every keeper
///          sell would hit the same settle shortfall, and swept tax would be
///          taxed again on the way out.
///
/// @dev **Deliberately NOT exempt: the PoolManager.** Exempting it would
///      silently disable the tax on every pool trade. User SELLS stay taxed,
///      which means a router must use the fee-on-transfer order
///      (SETTLE first, then swap the open credit, then TAKE). See
///      Dn404TaxTemplateV2Fork.t.sol for the proven Universal Router order.
///
/// @dev **Storage:** declares NO state. Inherits V1's layout unchanged, so the
///      Dn404LaunchFactory clone + `initialize` + `initializeTax(bytes)` path is
///      identical. The four system addresses are constructor immutables: they
///      live in the impl's runtime code, which every LibClone proxy
///      delegatecalls, so all clones of this impl share them.
contract Dn404TaxTemplateV2 is Dn404TaxTemplate {
    error Dn404TaxTemplateV2__ZeroSystemAddress();

    address public immutable GRADUATOR_ETH;
    address public immutable GRADUATOR_PAIR;
    address public immutable HOOK_ETH;
    address public immutable HOOK_PAIR;

    constructor(address graduatorEth_, address graduatorPair_, address hookEth_, address hookPair_) {
        if (
            graduatorEth_ == address(0) || graduatorPair_ == address(0) || hookEth_ == address(0)
                || hookPair_ == address(0)
        ) revert Dn404TaxTemplateV2__ZeroSystemAddress();
        GRADUATOR_ETH = graduatorEth_;
        GRADUATOR_PAIR = graduatorPair_;
        HOOK_ETH = hookEth_;
        HOOK_PAIR = hookPair_;
    }

    /// @notice True when `a` is a platform-system address that is untaxed on
    ///         either side of a transfer (graduators, hooks, current keeper).
    ///         Exposed so frontends / keepers can explain why a transfer was
    ///         not taxed.
    function isSystemExempt(address a) public view returns (bool) {
        return a == GRADUATOR_ETH || a == GRADUATOR_PAIR || a == HOOK_ETH || a == HOOK_PAIR
            || (a != address(0) && a == keeper);
    }

    /// @dev System-exempt routes go straight to DN404's transfer (no tax);
    ///      everything else takes V1's taxed path unchanged.
    function _transfer(address from, address to, uint256 amount) internal virtual override {
        if (isSystemExempt(from) || isSystemExempt(to)) {
            DN404._transfer(from, to, amount);
            return;
        }
        super._transfer(from, to, amount);
    }
}
