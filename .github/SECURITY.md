# Security posture

Where we sit on the risk gradient today, what's been checked, and what a real production launch still needs.

## Reporting a vulnerability

**DM [@spoobsV1 on X](https://x.com/spoobsV1)** — that is the sole channel. Please don't email, open a public GitHub issue, or file a PR that describes the vuln. Include a short summary + repro steps in the DM; we'll take it from there in private.

While a report is under triage, please refrain from:
- deploying the exploit against a live urufu labs deployment,
- disclosing the finding publicly (on X, in a blog, on Discord/Telegram, in a talk),
- filing the same finding on a third-party bounty platform.

Timelines: acknowledgment within 72h, triage decision within 7 days, coordinated disclosure once a patch has shipped or 90 days after acknowledgment (whichever is sooner).

## What runs today

| Tool | Status | Owner |
|---|---|---|
| **Foundry tests** | ✅ 548 unit + integration + fork + invariant, all green | in-tree |
| **MultiHookHost post-graduation fork test** | ✅ `MultiHookGraduationForkTest` — drives a curve to graduation on a real chain fork, then asserts LP-lock revert + fee-redirect accrual on the resulting v4 pool. Env-driven (`FORK_RPC_URL` / `BASE_SEPOLIA_RPC_URL`). | in-tree |
| **Deploy wiring check** | ✅ `forge script VerifyWiring` — chain-parameterized read-only script that asserts every deployed contract is wired end-to-end (Router↔factories, CurveFactory.graduator, Graduator ctor args, MultiHookHost flag mask, ownership eyeball). Run via `pnpm contracts:verify:wiring`. | in-tree |
| **Foundry fuzz** | ✅ 1,000 runs per property (default) | in-tree |
| **Invariant tests** | ✅ `test/invariant/` — 7 curve invariants + 4 router invariants, 256 runs × 8192 calls each, 0 reverts | in-tree |
| **Fork tests** | ✅ LPLockedHook init + full graduation against real Sepolia v4 + Graduator wire path | in-tree |
| **Slither** | ✅ `bash contracts/security.sh` — 2H, 36M, 28L, 94I (see triage) | in-tree |
| **Solhint / linter** | ⚠️ Not wired | future |
| **Coverage** | ⚠️ Foundry `forge coverage` runs but no CI gate | future |
| **External audit** | ❌ Not done | pre-mainnet |
| **Bug bounty** | ❌ Not launched | post-broadcast |

## Deploy readiness

| Target | Status | Gate |
|---|---|---|
| Sepolia testnet | ✅ Ready | none |
| Mainnet, dev funds only | ⚠️ | resolve Slither medium triage annotations |
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

1. **Add solhint** to CI to enforce naming + gas patterns automatically.
2. **Gas snapshot regression tracking.** `forge snapshot` in CI so a bad regression triggers review.
3. **External audit.** Trail of Bits, Spearbit, Cantina — or a solo auditor like Guido or samczsun. Budget: $30k-$80k depending on scope; timeline 2-4 weeks.
4. **Bug bounty on Immunefi.** Tiered payouts scale with TVL post-launch.
5. **Formal specification** of the invariants that must hold on the router + curve + hooks. Even one page each is enough to guide auditors — the current in-tree invariants are the mechanical baseline, not the full spec.

## Incident response

- **Router pause**: `Router.setPaused(true)` reverts every `launch()`. Test path: `test/unit/Router.t.sol::test_Paused_RevertsLaunch`.
- **Ownership**: after `HandoffOwnership.s.sol`, every admin action requires the multisig. Pause + fee updates + factory swaps + curve-factory + flywheel Ownables (FeeSplitter, LoyaltyOracle, NftRevenueVault, UruBuybackVault, RoyaltyRouterFactory) all gated by the multisig after handoff. `Graduator` has no admin surface — its config is immutable at construction, so no handoff applies; graduation-routing changes go through `CurveFactory.setGraduator(new)`.
- **Curve funds when graduator not wired**: `_graduate()` leaves ETH + tokens on the BondingCurve, callable by owner via post-deploy adapter (not yet built — TODO if we launch without a graduator).
- **v4 hook custody**: `LPLockedHook` reverts every `beforeRemoveLiquidity`. Even the deployer can't unlock. This is a feature, not a bug — if a hook needs to be swapped, deploy a new pool with the new hook.

## Contacts

[@spoobsV1 on X](https://x.com/spoobsV1) — sole approver, sole reporting channel. All coordination happens in DM.
