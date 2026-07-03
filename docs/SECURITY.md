# Security posture

Where we sit on the risk gradient today, what's been checked, and what a real production launch still needs.

## What runs today

| Tool | Status | Owner |
|---|---|---|
| **Foundry tests** | ✅ 454 unit + integration, all green | in-tree |
| **Foundry fuzz** | ✅ 1,000 runs per property (default) | in-tree |
| **Fork tests** | ✅ LPLockedHook init + full graduation against real Sepolia v4 | in-tree |
| **Slither** | ✅ `bash contracts/security.sh` — 2H, 36M, 28L, 94I (see triage) | in-tree |
| **Solhint / linter** | ⚠️ Not wired | future |
| **Invariant tests** | ⚠️ Not written | future |
| **Coverage** | ⚠️ Foundry `forge coverage` runs but no CI gate | future |
| **External audit** | ❌ Not done | pre-mainnet |
| **Bug bounty** | ❌ Not launched | post-broadcast |

## Deploy readiness

| Target | Status | Gate |
|---|---|---|
| Sepolia testnet | ✅ Ready | none |
| Mainnet, dev funds only | ⚠️ | resolve Slither medium triage + write invariant tests |
| Mainnet, real user funds | ❌ Not ready | external audit + bug bounty + coverage ≥90% |

## Slither triage

Run: `bash contracts/security.sh` from the repo root.

### High severity (2) — confirmed false positives

Both flagged findings are `unchecked-transfer` inside `Graduator.sol`. They point at
`SafeTransferLib.safeTransferFrom` and `SafeTransferLib.safeTransfer` (Solady). Solady's
implementation uses inline assembly to inspect the return value and reverts on failure —
this is verifiably safer than the OZ IERC20 pattern, but Slither's detector traces into
the library and flags the internal `call` shape without recognizing the assembly guard.

Verification: see `lib/solady/src/utils/SafeTransferLib.sol` — every transfer routes
through a `require(success)` after the low-level call. Also fork-tested end-to-end via
`test/curve/GraduationForkTest.t.sol` against a real Sepolia PoolManager + a MockToken
where a bad transfer would have caused the pool init to revert.

**Verdict: safe. No fix required.**

### Medium severity (36) — triaged

Distribution:
- **`divide-before-multiply` (6)** — bps arithmetic (`x * bps / 10_000`). Standard pattern; the precision loss is acceptable and matches OpenZeppelin's own conventions. Also intentional in `Graduator`'s tick alignment (`MIN_TICK / spacing * spacing`).
- **`incorrect-equality` (5)** — checks like `if (reward == 0) revert Staking__NothingToClaim();`. Exact-zero comparison is correct here — we're checking whether a bookkeeping ledger is empty.
- **`uninitialized-local` (16)** — Solidity zero-initializes locals at declaration. Slither flags `abi.decode` destinations declared without an explicit `= <default>`; the decode always writes them before use.
- **`unused-return` (9)** — Uniswap v4 PoolManager returns are safe to discard per the v4 pattern (deltas are validated via the unlock/settle flow instead). Consumers of `settle()` and `initialize()` in `Graduator` fall in this category.

**Verdict: no exploitable issues. All medium findings are either style-level, false positives, or acceptable trade-offs. Individual annotations planned but not blocking broadcast.**

### Low + Informational (122)

Bulk are:
- `redundant-statements` (41): `moduleData;` warning-suppression pattern in every composed template. Cannot remove without breaking the splicer's marker convention.
- `missing-inheritance` (36): Slither over-eagerly flags every composed contract as "should inherit `IInitializable`". False positive — the contracts DO have an `initialize(bytes)` function that matches the factory's expected ABI; there's no interface to formally inherit.
- Various style / naming / event-indexing suggestions.

## What still needs to happen before mainnet

1. **Write invariant tests.** `forge invariant` supports property-based testing across random sequences of calls. Critical properties: curve `k` monotonicity, no-inflation invariant on refunds/vesting, LP position ownership immutability post-graduation.
2. **Add solhint** to CI to enforce naming + gas patterns automatically.
3. **Gas snapshot regression tracking.** `forge snapshot` in CI so a bad regression triggers review.
4. **External audit.** Trail of Bits, Spearbit, Cantina — or a solo auditor like Guido or samczsun. Budget: $30k-$80k depending on scope; timeline 2-4 weeks.
5. **Bug bounty on Immunefi.** Tiered payouts scale with TVL post-launch.
6. **Formal specification** of the invariants that must hold on the router + curve + hooks. Even one page each is enough to guide auditors.

## Incident response

- **Router pause**: `Router.setPaused(true)` reverts every `launch()`. Test path: `test/unit/Router.t.sol::test_Paused_RevertsLaunch`.
- **Ownership**: after `HandoffOwnership.s.sol`, every admin action requires the multisig. Pause + fee updates + factory swaps all gated.
- **Curve funds when graduator not wired**: `_graduate()` leaves ETH + tokens on the BondingCurve, callable by owner via post-deploy adapter (not yet built — TODO if we launch without a graduator).
- **v4 hook custody**: `LPLockedHook` reverts every `beforeRemoveLiquidity`. Even the deployer can't unlock. This is a feature, not a bug — if a hook needs to be swapped, deploy a new pool with the new hook.

## Contacts

Brandon (@brand) — solo dev, sole approver.
