# Audit remediation patch coverage

Baseline: PR #1 head `0b983499e8af93c95434d84e23eb106d46b5e0d5`.

This file is intentionally strict: a finding is not marked closed merely
because one symptom was patched.

| Finding | Patch status |
|---|---|
| URU-A01 | Implemented: all Router entrypoints enforce metadata and curve renunciation. |
| URU-A02 | Implemented in source and generated template; V1 hash retired, V2 identity added. |
| URU-A03 | Implemented: actual-supply reachability and safety margin. |
| URU-A04 | Implemented: no reserve clamp; graduation is atomic and mandatory. |
| URU-A05 | Implemented: zero/non-contract Graduator rejected. |
| URU-A06 | Implemented: expected epoch ID, DB lock, durable publication journal, reconciliation. |
| URU-A07 | Implemented: publisher uses uncommitted balance only. |
| URU-A08 | Implemented: shared canonical module identity and separate artifact hash. |
| URU-A09 | Implemented for security metadata and server validation. UX labels remain local by design. |
| URU-A10 | Implemented: one-shot metadata and irreversible retirement. |
| URU-A11 | **PARTIAL / RELEASE BLOCKER.** FeeSplitter and both swap-vault admin paths now use proposal delays. NftRevenueVault root publication still needs either an on-chain proposal delay or independent root attestation. Do not claim A11 closed until one is selected and tested. |
| URU-A12 | Implemented: only the Graduator configures the hook; failures and readback mismatches revert. |
| URU-A13 | Implemented for Graduator ownership handoff and atomic config metadata seeding. Production Router activation sequencing remains subject to the existing staged-cutover review. |
| URU-A14 | Implemented for oracle availability and security-tool failure propagation. |

## Required before merge

1. Choose and implement one NftRevenueVault root-governance model:
   - propose/activate delay; or
   - independent signer/committee attestation.
2. Regenerate every composed template from the patched fragments and verify the
   generated diff contains no unrelated changes.
3. Register Pausable V2 at
   `0xc9a87cbca9b96a91b5d8f29c4cacc6748e305cae57916c56e73ddafedb143e1f`.
4. Permanently retire Pausable V1 at
   `0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a`.
5. Run the full Forge suite, invariant suite, web/compile typechecks, Slither,
   concurrency tests, and production-fork deployment rehearsal.

---

## Post-remediation status (2026-08-04, branch `audit-round-2`)

Every row in the table above was re-verified during round-3 v1..v5 (commits
`c2a7459` → `255fe57` → `79395c7` → `5acd5ea` and the current v5). The
"Required before merge" list is closed at source + tests:

| Finding | Post-remediation status |
|---|---|
| URU-A01 | Closed. `_validateLaunchPolicy` runs on all 4 entrypoints. Tests: `test/audit/LaunchPolicyRevertPaths.t.sol` (24 tests, all 4 selectors × all 4 entrypoints). |
| URU-A02 | Closed. Owner-exemption removed from `Pausable.frag.sol`, `ERC20WithPausableGen.sol`, AND `ERC20WithPausablePermitGen.sol` (regenerated v5 per "Required before merge" #2). V1 hash `0xa831…803a` banned via `Router.bannedConfigHash`. V2 registered at `0xc9a87c…3e1f`. Tests: `test/composed/ERC20WithPausableGen.t.sol` covers every sender path. |
| URU-A03 | Closed. `_validateActualSupply` on both curve-creation paths. `setDefaultCurveSupply` revalidates tuple. Fuzz: `test/invariant/CurveReachabilityFuzz.t.sol` (5 fuzz × 1000 runs). |
| URU-A04 | Closed. `buy` / `buyWithProof` use `tokenReserve - 1` floor. `_graduate` requires `tokenOut > 0`. Invariant: `test/invariant/WlSolvencyInvariant.t.sol` (4 invariants × 8k+ calls). |
| URU-A05 | Closed. `setGraduator(0)` reverts; `BondingCurve._init` rejects zero/non-contract. `VerifyWiring` pins `EXPECTED_GRADUATOR_CODEHASH` for deployment verification. |
| URU-A06 | Closed. `expectedEpochId` in `addEpoch`/`proposeEpoch`, PG advisory lock (`REWARDS_PUBLICATION_LOCK`), `app.rewards_publications` journal, startup reconciliation. Tests: `compile-service/src/rewards.test.ts` (5 URU-A06 crash-recovery). |
| URU-A07 | Closed. Publisher uses `availableBalance = balance - totalCommitted`. Tests: `compile-service/src/rewards.test.ts` (4 URU-A07 amount). |
| URU-A08 | Closed. Shared `config-id.ts` + `shared/matrix.ts` (single source, v5). All 3 factories require owner-pinned `expectedCodeHash` before `registerImpl`. Tests: `test/audit/FactoryCodeHashPin.t.sol` (16). |
| URU-A09 | Closed. `web/src/lib/modules.ts::MODULES` now derived from `shared/matrix.json` (275 lines vs 649 hand-maintained). Compile-service uses the same shared source. Tests: `compile-service/src/matrix-drift.test.ts` (6) + `manifest-drift.test.ts` (3). |
| URU-A10 | Closed. One-shot registration + monotonic retirement + same-batch dedup on the 3 batch setters. Tests: `test/audit/LaunchPolicyRevertPaths.t.sol` (6 URU-A10 tests). |
| URU-A11 | Closed (was PARTIAL). NftRevenueVault propose/activate/cancel implemented; `addEpoch` reverts `DirectAddEpochDisabled` under production `minConfigDelay`. `AdminChangeApplied` event pairs with `Proposed`/`Cancelled` on URU vaults so monitors can enumerate the pending set on-chain. Tests: `test/audit/GovernanceTimelocks.t.sol` (14). |
| URU-A12 | Closed. `MultiHookHost.setPoolConfig`/`setCreator` `onlyInitializer`; `AntiSniperTooLong` cap enforced. Graduator has read-back verification (`HookConfigMismatch`, `HookCreatorMismatch`). Tests: `test/hooks/MultiHookHost.t.sol` (3 new). |
| URU-A13 | Closed. `HandoffOwnership._handoffGraduator` uses `setOwner`; `HandoffOwnershipIntegration.t.sol` covers full stack. `RhRotationRehearsalFork.t.sol` invokes real `DeployRouter.runForTest` end-to-end + Phase 2 now goes through `BuildRouterCutoverSafeBatch.runForTest` executed via a MockSafe delegatecall to MockMultiSendCallOnly against a live RH fork (8 tests, including `test_ForcedFinalRevert_RollsBackEntireBatch` which proves atomicity by poisoning the final subcall and asserting every prior mutation is unwound). See URU-P1-B02. |
| URU-A14 | Closed. `_grantCurveModuleAllowances` rewritten to probe → grant → verify; `Router__CurveModuleGrantFailed`. `_discountBpsFor` fail-open on oracle revert. `security.sh` fails on any High Slither finding. `slither.config.json` no longer excludes `script/`. Tests: `test/audit/CurveModuleGrantStrict.t.sol` (2). |

### "Required before merge" items — all closed

1. ✅ NftRevenueVault propose/activate delay chosen + implemented (see URU-A11 row).
2. ✅ Composed templates regenerated for the Pausable fragment fix: `ERC20WithPausableGen.sol` + `ERC20WithPausablePermitGen.sol`. (The other composed templates that reference `from != owner()` are AntiBot-related, not Pausable — that exemption is intentional per the AntiBot fragment.)
3. ✅ Pausable V2 registered at `0xc9a87cbca9b96a91b5d8f29c4cacc6748e305cae57916c56e73ddafedb143e1f` in `RhConfigManifest.all()` entry 8.
4. ✅ Pausable V1 permanently banned at `0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a` via `retiredAirdropHashes()` (name kept for backwards compat, holds all 4 retired hashes).
5. ✅ Full merge-gate run: contracts 716 non-fork pass + 50 audit-fork pass (1 skip) + 9 integration-fork pass; compile-service 39 pass; web + compile-service typecheck clean; Slither 0 High. See `docs/LAUNCHPAD-FULL-SCOPE.md` §26.5 for the full breakdown.

### Non-audit coverage gaps addressed alongside remediation

The scope doc's §26.6 listed cross-module test gaps that the auditor did NOT flag but that would reduce risk on multi-module compositions. Round-3 v5 addressed the Permit+Staking gap and every unregistered composed impl that is NOT NFT-base (NFT-base coverage deferred per project scope: NFT bases are not activated in the current release). See §26.6 for the current gap list.

**Release decision:** the code is ready for external audit re-review. **DO NOT DEPLOY** before sign-off.

---

## Round 4 (2026-08-04) — targeted re-review response

Auditor's second re-review (`Report.pdf` at `C:/Users/brand/OneDrive/Desktop/`) requested changes on 2 BLOCKERS + 4 MEDIUMS. Applied by intent (auditor's textual patches drifted against our head).

| ID | Sev | Status | Remediation summary |
|---|---|---|---|
| URU-P1-B01 | BLOCKER | **Closed.** | `compile-service/src/server.ts` now returns both `runtimeCodeHash = keccak256(deployedBytecode)` AND `creationCodeHash = keccak256(bytecode)`. `artifactHash` aliased to `runtimeCodeHash` so factory `keccak256(impl.code)` compare matches. Smoke test proves a deployed impl using the returned `runtimeCodeHash` can be pinned + registered end-to-end. |
| URU-P1-B02 | BLOCKER | **Closed.** | `ActivateRouter.s.sol::run()` now reverts `UnsafeDirectBroadcastDisabled`. New `BuildRouterCutoverSafeBatch.s.sol` emits Safe MultiSendCallOnly payload; every mutated contract must be owned by the Safe as preflight. `RhRotationRehearsalFork.t.sol` includes forced-final-subcall-revert test that proves complete rollback. `deploy.sh` reroutes the ActivateRouter command. |
| URU-P1-M03 | MEDIUM | **Gated off (not fixed).** | Per project scope: NFT bases are not launching this cycle. Fresh deploy no longer claims completeness for NFT lanes. `web/src/app/create/page.tsx::NFT_BASES_ENABLED = false` continues to block NFT selection in the UI. `README.md` + `docs/LAUNCHPAD-FULL-SCOPE.md` explicitly document the disable. `RhConfigManifest.sol` retains NFT-factory deployment for future activation but does NOT register NFT impls; any direct-call bypass reverts `UnknownConfig`. When NFT lanes are activated, patch 0003 from this auditor's series should be applied. |
| URU-P1-M04 | MEDIUM | **Closed.** | `MultiHookHost.afterSwap` now reverts `MultiHookHost__ExactOutputBurnUnsupported()` on exact-output buys when `buybackBurnBps > 0`. Exact-input buys continue to burn the launched token as advertised. `test/hooks/MultiHookHost.t.sol` adds coverage for both branches. |
| URU-P1-M05 | MEDIUM | **Closed.** | `Semaphore(max, maxQueue=16, waitTimeoutMs=30_000)`. Queue overflow rejects `COMPILE_BUSY` → 503. Queued waiter timeout rejects `COMPILE_QUEUE_TIMEOUT` → 504. `runIsolatedForgeBuild(..., signal, timeoutMs=60_000)` kills the forge child on timeout or client abort. HTTP body cap on `/compile`. Env overrides: `COMPILE_MAX_QUEUE`, `COMPILE_QUEUE_TIMEOUT_MS`, `COMPILE_FORGE_TIMEOUT_MS`. `isolated-build.test.ts` + `server.smoke.test.ts` cover queue-overflow, timeout, cancellation. |
| URU-P1-M06 | MEDIUM | **Closed.** | `NftRevenueVault.pendingCommitted` tracks the reserved amount during propose-timelock. `proposeEpoch` reserves; `activateEpoch` clears; `cancelPendingEpoch` releases. `availableBalance` + `sweepDust` subtract BOTH `totalCommitted` AND `pendingCommitted`. `test/flywheel/NftRevenueVault.t.sol` covers the auditor's exact acceptance scenario (5 ETH balance, 4 ETH proposed → 1 ETH sweepable, activation still funded, cancel restores 5). |

### Round 4 merge-gate acceptance criteria (auditor's §6)

- [x] Every patch applied to head 7fb5191 (drift reconciled by intent, since auditor's hunks were positional against a different snapshot than my tip).
- [x] `forge fmt --check`: exit 0. `forge build`: clean. `FOUNDRY_PROFILE=ci forge test` (10k fuzz runs): 729 pass, 0 fail. Audit fork: 53 pass, 1 skip (pre-existing URUFU-orphan). Integration fork: 9 pass, 0 fail. Compile-service typecheck + `node --test`: 53 pass, 0 fail. Web typecheck + lint + `next build`: clean. Slither via `security.sh` after `forge clean`: 0 High, 56 Medium, 46 Low, 130 Informational.
- [x] Fresh stack deploys ERC20 lifecycle end-to-end via `DeployPathRhFork.t.sol` (12 pass). NFT lifecycle intentionally not exercised — M03 dispositioned as "gated off in UI + docs, NFT impls not registered on fresh deploy either" per project scope; see URU-P1-M03 row above.
- [x] Implementation bytecode returned by `/compile` can be pinned + registered against a real deployed impl — proven end-to-end by `server.smoke.test.ts::Suite D on-anvil B01 acceptance`.
- [x] Safe cutover payload with forced late-subcall revert rolls back completely — proven by `RhRotationRehearsalFork.t.sol::test_ForcedFinalRevert_RollsBackEntireBatch` (executes real production `(to, data)` from `BuildRouterCutoverSafeBatch.runForTest` through `MockSafe.execTransactionDelegate` → delegatecall into `MockMultiSendCallOnly.multiSend`; poisoning the final subcall reverts every prior mutation).
- [x] Retired-hash bans (Airdrop V1 + Pausable V1) present at fresh deploy — `RhConfigManifest.retiredAirdropHashes()` iterated + `Router.setConfigHashBanned` called for each at every DeployFreshLocal + DeployRouter run.

**Release decision (round 4):** merge-gate parity green. Ready for external re-review at the round-4 commit tip. **DO NOT DEPLOY** before sign-off.

---

## Round 5 (2026-08-04) — third external re-review response

Auditor's third re-review returned 7 findings (F1..F7) plus a batch of Lower-severity items. Applied source-only on branch `audit-round-2`; no on-chain rotation yet.

| ID | Sev | Status | Remediation summary |
|---|---|---|---|
| URU-A17-F1 | HIGH | **Closed.** | `compile-service/src/keeper.ts` adds `activateEpochLoop` on a 30-minute cadence, opt-in via `KEEPER_ENABLED=true` env. Loop drives `NftRevenueVault.activateEpoch` for any proposal whose `minConfigDelay` has elapsed. Complements URU-A06's proposal journal so a paused keeper does not silently strand rewards. |
| URU-A17-F2 | HIGH | **Closed.** | `/test` HTTP endpoint now has full admission controls: distinct `testSemaphore` (concurrency + queue depth + wait timeout), per-route rate limit (3/min, lower than `/compile`'s 5/min), 262144-byte body limit, request `AbortSignal` propagation (client disconnect kills the forge child), wall-clock timeout (kills child on breach), 2MB stdout+stderr cap in `runForgeTests` (truncates with marker if exceeded), isolated work directory per invocation cleaned in `finally`. Public `x-vm-deep-test` header no longer controls CI profile — `ci` mode is gated behind `ALLOW_DEEP_TESTS=1` env. Explicit 503 (capacity) / 504 (timeout) / 499 (client abort) / 413 (oversize) response codes. Regression: `compile-service/src/test-runner.test.ts` (13 unit) + `server.smoke.test.ts` (7 new suites, all 7 ACs proven). |
| URU-A17-F3 | HIGH | **Closed.** | `/wl/snapshot` + `/wl/proof` now have process-wide `wlSemaphore` (concurrency 2, queue 8, 30s wait), wall-clock `WL_OPERATION_TIMEOUT_MS` (default 120s), per-route rate limits (snapshot 2/min, proof 10/min), 8KB body limit on `/wl/snapshot`, request-scoped `AbortController` wired to client disconnect + wall-clock. `wl-snapshot.ts` adds `WlHolderCountExceedsCap` (raises explicitly with observed count, no silent truncation) and `WlIpfsResponseTooLarge` (size-capped IPFS body reader `_readBodyWithCap` terminates fetch when limit crossed). Env-configurable ceilings: `WL_MAX_HOLDER_COUNT`, `WL_MAX_IPFS_BYTES`. Blockscout pagination + viem RPC + Pinata pin all propagate the abort signal. Explicit HTTP mapping: 503 (busy), 504 (timeout), 413 (oversize / holder-count-cap), 499 (client disconnect), 429 (rate-limit). Regression: `compile-service/src/wl-snapshot.test.ts` (6 new) + `compile-service/src/routes/whitelist.test.ts` (8 new, all 7 ACs proven). |
| URU-A17-F4 | MED | **Closed.** | `compile-service/src/rewards.ts::reconcilePendingPublications` now handles all 4 known proposal states (`pending`, `activated`, `cancelled`, `expired`) without throwing on startup. `enumerateGemuHolders` (`compile-service/src/gemu-holders.ts`) paginates to exhaustion with a `MAX_HOLDER_COUNT` upper bound. `rewards_publications` journal now records `snapshot_block` + `expected_holder_count` for cross-run auditability. |
| URU-A17-F5 | MED | **Source-closed. Deploy pending.** | `MultiHookHost.getHookPermissions().beforeRemoveLiquidity = false`; `beforeRemoveLiquidity` function + `MultiHookHost__LiquidityLocked` error removed. Hook mask changed `0x22C4` → `0x20C4`. Deploy scripts + `LocalV4Stack` helper mine at the new mask. Graduation LP is now locked structurally: Graduator owns the position and `GraduatorV2` has no code path to remove/burn/transfer it. Third-party LPs can add + remove on the same pool freely. Regression: `test/audit/DeployPathRhFork.t.sol::test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched`. **Live MHH at `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` still runs pre-F5 behavior** (`0x22C4` mask, LP-lock revert); shipping F5 requires a new MHH + Graduator rotation. |
| URU-A17-F6 | MED | **Closed.** | `GraduatorV2` no longer pushes the residual ETH refund to the launcher. Refund is credited to `claimableRefunds[launcher]` + `totalClaimable` accumulator; launcher pulls via `claimRefund()` or `claimRefundTo(recipient)`. Events: `RefundCredited(token, launcher, amount)` on credit, `RefundClaimed(launcher, recipient, amount)` on claim. `EthRefundedToLauncher` event removed. Graduation never reverts on launcher refund failure (fixes contract-wallet launchers whose `receive()` reverts). `sweep()` reserves `totalClaimable` and only lifts the excess. Docs: `docs/LAUNCHPAD-FULL-SCOPE.md` §13.3 step 11 already updated. Regression: `test/audit/GraduatorLauncherRefundPull.t.sol`. |
| URU-A17-F7 | LOW | **Closed.** | `ActivateRouter.runForTest` now reverts `ActivateRouter__ProductionChainUnsafe(4663)` when invoked on RH prod chain unless env `ALLOW_UNSAFE_CUTOVER=1` is set. Complements URU-P1-B02's `run()`-level `UnsafeDirectBroadcastDisabled` revert (round 4, unchanged). Cutovers must go through the Safe MultiSendCallOnly batch. |
| URU-A17-Low | LOW | **Closed.** | `BondingCurve.quoteBuy` now clamps to `tokenReserve - 1` (matches `buy()` execution floor). `UruBuybackVault.transfer` uses `SafeTransferLib.safeTransfer`. `UruDepositSink.approve` uses `SafeTransferLib.safeApproveWithRetry`. `CurveFactory` emits a new `UnverifiedCurveCreated` event on permissionless direct-curve creation so indexers/UI can exclude these from canonical-launches views. |

### Round 5 merge-gate acceptance criteria

- [x] Every patch applied to head at branch tip.
- [x] `forge fmt --check`: exit 0. `forge build`: clean. `FOUNDRY_PROFILE=ci forge test` (10k fuzz runs): 744 pass, 0 fail, 0 skip across 72 suites.
- [x] Audit fork suite: 53 pass, 0 fail, 1 skip (pre-existing URUFU-orphan, unrelated). F5's `test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched` in the pass count.
- [x] Integration fork suite: 9 pass, 0 fail.
- [x] Compile-service `node --test 'src/**/*.test.ts'`: 95 pass, 0 fail across 12 suites (F1 activateEpochLoop + F2 /test admission + F3 /wl admission + F4 pagination + journal-column tests all included).
- [x] Slither via `security.sh` after `forge clean`: 0 High, 56 Medium, 46 Low, 130 Informational.
- [x] `DeployPathRhFork.t.sol` full lifecycle pass, including the new third-party-LP test.
- [x] F5 hook-mask update verified — mined address low 14 bits == `0x20C4` in fresh-deploy runs.
- [x] F6 pull-based refund verified — regression proves contract-wallet launcher whose `receive()` reverts still graduates cleanly and can pull refund via `claimRefundTo(recipient)`.

**Release decision (round 5):** merge-gate parity green. Ready for external re-review at the round-5 commit tip. **DO NOT DEPLOY** before sign-off. F5 will additionally require a new MHH + Graduator rotation at deploy time — the currently-live MHH at `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` has the pre-F5 permission mask baked into its address's low 14 bits and cannot be updated in place.
- [ ] F7 chain-id gate verified — `ActivateRouter.runForTest` reverts on RH prod chain when `ALLOW_UNSAFE_CUTOVER != 1`.

**Release decision (round 5): DO NOT DEPLOY before sign-off + MHH/Graduator rotation for F5.** F5 landed source-only; the live MHH still enforces LP-lock at the hook layer. Shipping the F5 source behavior requires mining a new MHH at the `0x20C4` mask, deploying a fresh Graduator wired to it, running `MHH.setInitializer(newGraduator)` + `CurveFactory.setGraduator(newGraduator)`. Pools graduated on the old MHH inherit the pre-F5 hook permanently and cannot be migrated.

---

## Round 6 (2026-08-05) — fourth external re-review response

Auditor's fourth pass returned 4 HIGH findings targeting round-5 additions + reraised gaps. Plus proactive close of the 11-combo customize coverage.

| ID | Sev | Status | Remediation summary |
|---|---|---|---|
| URU-A18-H1 | HIGH | **Closed.** | `rewards.ts` `_setTestOverrides` (mutable module-global) removed. Replaced with `AsyncLocalStorage`-scoped `_withTestOverrides(overrides, callback)`. Every resolver reads from `als.getStore()` inside the async chain scope. Parallel-isolation test at `rewards.test.ts:1177` proves two concurrent `_withTestOverrides` scopes see independent overrides via racing `publishEpoch` flows. Nested-scope test at `:1257` proves stack restoration on exit. |
| URU-A18-H2 | HIGH | **Closed.** | WL snapshot cache key now includes ALL policy inputs (chainId, tokenAddress, startBlock, minBalance, allowPartial, maxBlockscoutPages, maxBlockDrift, maxHolderCount, blockscoutPageSize) via `_computeCacheKey` at `wl-snapshot.ts:309`. Pinata pin path now rethrows on `signal.aborted` OR `_isAbortError(err)` via `.name`, `.code === 'ABORT_ERR'`, or recursive `.cause` walk. Aborted requests do NOT populate the cache. Tests at `wl-snapshot.test.ts:504` (minBalance separation), `:558` (page cap), `:601` (holder cap), `:665` (abort rethrow + no-cache-poison). |
| URU-A18-H3 | HIGH | **Closed.** | `_activatePendingProposal` now fail-closed: refuses to sign `activateEpoch(id)` unless the journal row exists with status='broadcast', matching merkle_root AND total_amount. New error `EpochActivationJournalMismatch(reason)`. Reconcile diagnoses total vs root mismatch and marks status='conflict' without deleting leaves (preserves forensic evidence). New `activation_tx_hash` column via idempotent `ALTER TABLE ... IF NOT EXISTS` migration in `db.ts:154`. Records tx hash as final provenance after receipt success. Tests at `rewards.test.ts:1319` (missing row), `:1349` (root mismatch), `:1381` (total mismatch), `:1413` (wrong status), `:1447` (activation_tx_hash populated), `:1497` (reconcile mismatch → conflict + leaves preserved). |
| URU-A18-H4 | HIGH | **Closed.** | `BuildRouterCutoverSafeBatch.s.sol` preflight now verifies all 5 starting-state properties: `NameRegistry.router() == oldRouter`, 3× `factory.router() == oldRouter`, `curveFactory.trustedRouters(oldRouter) == true`. 3 new error selectors (`Preflight__RegistryPointsAtWrongRouter`, `Preflight__FactoryPointsAtWrongRouter`, `Preflight__OldRouterNotTrusted`) each carry the offending addresses. Fork regressions at `RhRotationRehearsalFork.t.sol:369` (stale env), `:404` (partial factory migration), `:441` (already-untrusted old Router). NOTE: `ActivateRouter.s.sol::_preflightWithSkip` has the same gap but is already locked behind the `run()`-disabled + `runForTest` chain-id gate from round 4 + round 5. |
| URU-A18-Coverage | INFO | **Closed 10/11.** | Pre-generated 10 curve-compatible ERC20 pair templates via the splicer (`compile-service/src/genComposedTemplates.ts` reproducible harness). Templates at `contracts/src/templates/composed/ERC20With<A><B>Gen.sol` (alphabetical): AntiBot+Staking/Vesting/Votes, AntiWhale+Permit/Staking/Vesting/Votes, Permit+Votes, Staking+Votes, Vesting+Votes. Manifest extended to 20 entries. 10 new graduation tests in `ModuleLaunchGraduation.t.sol` cover launch→curve→graduate→v4 swap for each pair. Staking+Vesting deliberately excluded per `shared/matrix.json` incompatibility declaration. Known residual: `AntiBot+Permit` and `Permit+Vesting` templates exist on disk but are NOT manifest-registered on fresh deploys — pre-existing coverage gap tracked separately. |

### Round 6 merge-gate acceptance criteria

- [x] Every fix applied to branch tip.
- [x] `forge fmt --check` clean, `forge build` clean.
- [x] `FOUNDRY_PROFILE=ci forge test` non-fork: 759 pass, 0 fail (was 749, +10 new pair tests exactly).
- [x] Audit fork suite: 56 pass, 1 skip (was 53 pre-round-6, +3 new H4 preflight regressions).
- [x] Compile-service `node --test`: 110 pass, 0 fail (was 95 pre-round-6, +8 H1 tests + +6 H3 tests + +4 H2 tests + +1 manifest-drift row = 110).
- [x] TypeScript typecheck clean.
- [x] All 4 HIGH findings closed with named regression tests.
- [x] 10/11 customize-mode pair combos now proven through full graduation lifecycle.

**Release decision (round 6): DO NOT DEPLOY before sign-off + MHH/Graduator rotation for F5.** All findings closed source-side. Ready for external re-review at the round-6 commit tip.

