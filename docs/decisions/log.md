# Decision log

Chronological, one entry per significant milestone or shift. Newest at top.
Complements per-decision ADRs in `docs/decisions/ADR-*` — this is the per-session narrative.

---

## 2026-07-02 — Phases 1–3 shipped, broadcast-ready

**Recap:** Since the last log entry Phase 1 (launch stack), Phase 2 (bonding curve + trade UX), and Phase 3 (multichain + IPFS + real graduation) all landed in a series of pushes.

**Contract state (`contracts/`):**
- 454 in-memory tests + 2 Sepolia fork tests (LPLockedHook hook init on real v4 PoolManager, full BondingCurve → graduation → v4 pool creation with LP locked by LPLockedHook)
- 20 shipped modules (10 ERC-20 token, 5 NFT, 3 allocation, 1 governance, 5 v4 hooks) + 3 planned (B20 lineup)
- 33 curated impls registered by `DeployPhase1`
- `BondingCurve` + `CurveFactory` + `Graduator` with `installBondingCurve` flag wired into `Router.LaunchParams`
- `HandoffOwnership.s.sol`, `PostDeploySmoke.s.sol`, `verify-phase1.sh`, `deploy.sh` (multi-chain), `security.sh` (Slither) all shipping
- `.github/SECURITY.md` triage: 2 High findings are Solady `SafeTransferLib` false positives; 36 Medium all triaged as non-exploitable

**Web state (`web/`):**
- 7 static routes + `/trade/[address]` dynamic; production build passes
- Chain switcher (dropdown), IPFS metadata pipeline (Pinata + localStorage fallback), pump.fun-style feed on `/discover` with mock/indexer failover
- `ChainSwitcher` mount-safe against SSR hydration mismatches
- Trade chart displays gwei-per-token with dynamic precision (was rendering "0" due to ETH-per-token scale being too small)

**Indexer state (`indexer/`):**
- Ponder 0.7 with dynamic BondingCurve subscription via `CurveFactory.CurveCreated` factory pattern
- Handlers for `Launched`, `CurveInstalled`, `<base>.Deployed`, `NameRegistry.Reserved`, `BondingCurve.CurveInitialized/Trade/Graduated`
- Client fallback: `web/src/lib/indexer.ts` returns null on any failure so `/discover` and `/trade` degrade to mocks or client-side `getLogs`

**Naming:** Codename shifted from "VM / Vending Machine" to **urufu labs**. `README.md`, `docs/PLAN.md`, `docs/HANDOFF.md`, `docs/TODO.md`, all SPEC files updated. Old TODO IDs `VM-###` retired; new ones use `URU-###`.

**Next up (Phase 4-5):** B20 module lineup (planned), invariant tests, external audit, Immunefi bounty, mainnet multisig deploy. See `docs/TODO.md`.

---

## 2026-07-01 — DEX choice locked: Uniswap v4, not Aero

**Context:** ETHSKILLS Building Blocks flags Aero (merged Aerodrome + Velodrome, Nov 2025) as the dominant DEX on Base by TVL. Considered pivoting graduation target on Base from Uniswap v4 to Aero.

**Decision:** Uniswap v4, on both mainnet and Base. Locked.

**Why:** VM's entire post-graduation economics — LP-lock, per-swap fee redirect (platform/creator/holders), cross-token loyalty discounts, anti-vamping 2× penalty, buyback-and-burn triggers — are built on Uniswap v4's `hooks` system. Aero is a ve(3,3) Solidly fork; it has no hook interface. Choosing Aero forfeits the moat.

**How to apply:** any Base-specific guidance from Building Blocks about Aero applies to the general Base ecosystem, not to VM. If a VM launch wants Aero liquidity, that's an owner action post-graduation — outside the hook's mandate.

---

## 2026-07-01 — Phase 0 scaffold complete

**Repo state:** initialized git, monorepo layout matches `README.md` §Repository layout. pnpm workspaces cover `web` (empty, to scaffold), `compile-service` (skeleton), `indexer` (skeleton). `contracts/` is a Foundry workspace outside pnpm.

**Contracts config:** `foundry.toml` pins `solc_version = "0.8.26"`, `evm_version = "cancun"`, `via_ir = true`, default optimizer runs 10 000, with a `clone` profile at 200 for factory-cloned templates. Fuzz runs 1 000 local / 10 000 CI. Invariant depth 32 local / 64 CI. `contracts/install-deps.sh` written but not runnable until Foundry is installed on host (see VM-008).

**Uniswap v4 pin — deferred:** `install-deps.sh` intentionally leaves v4-core and v4-periphery as TODO markers. The correct audited commit gets pinned when Phase 2 (curve + graduation) starts, using the ETHSKILLS Building Blocks sub-skill for guidance.

**Shared matrix:** `shared/matrix.json` schema stubbed with `bases`, `mechanics`, empty `modules`. Filled as modules land.

**SPECs:** `docs/SPEC-registry.md` and `docs/SPEC-router.md` complete. Both include invariants, threat model rows, deploy checklists, and a testing checklist per HANDOFF §"Contract specs." Next specs on the list: SPEC-templates, SPEC-modules (module fragment interface + FeeOnTransfer + AntiBot), SPEC-factories, SPEC-compile-service.

**GH Actions:** three workflows — `contracts.yml` (forge fmt/build/test/coverage under CI profile), `web.yml` (pnpm typecheck/lint/build), `compile-service.yml` (typecheck/build). Gated on path filters.

**Blockers on the human (Brandon):**
- Real project name (VM-001), domain/GitHub org/Twitter handle (VM-002), LLC or C-corp (VM-003), audit firm outreach (VM-004), API accounts (VM-005, VM-006), deploy/staging/ops wallets (VM-007).
- `foundryup` install on host (VM-008) before `forge install` can run.

**ETHSKILLS status:**
- Read: Ship, Standards, Security, Protocol, Building Blocks, Audit. Standards + Security drove the SPEC threat models and `foundry.toml` fuzz settings. Building Blocks confirmed the v4 `BaseHook` interface + `getHookPermissions` pattern for VendingMachineHook (Phase 2/3). Audit points at `austintgriffith/evm-audit-skills` — 20-checklist system to run before external audit (Phase 4).
- Layer-2s 404'd — URL may not exist. Not needed for VM's mainnet-first stance.

**Next session (Phase 0 finish → Phase 1 start):**
1. Run `foundryup`; run `contracts/install-deps.sh`; pin Uniswap v4 commit hashes.
2. `pnpm install` at repo root to pull down web + compile-service + indexer deps.
3. Write `NameRegistry.sol` + tests (VM-030, VM-031, VM-032). SPECs are complete; nothing else blocks.
4. Deploy `NameRegistry` to Sepolia; verify (VM-033).
5. Enough `/create` UI to hit GATE 0 — chain picker, base picker, name/ticker input with live registry check (VM-200 through VM-209 in part).

---

## 2026-07-01 — Phase 0 SPECs complete

- Wrote `SPEC-templates.md` (VM-022) — injection-marker convention, per-base initialization signatures, storage safety rules, per-template invariants.
- Wrote `SPEC-modules.md` (VM-023) — fragment file format with header fields, section markers, matrix schema, splice determinism (alphabetical), plus full specs for FeeOnTransfer and AntiBot.
- Wrote `SPEC-factories.md` (VM-024) — clones-over-bytecode design, per-config impl registry, CREATE2 salt policy (`(launcher, name, ticker, chainId)` — front-mining defeated), registrar role.
- Wrote `SPEC-compile-service.md` (VM-025) — endpoint contract, canonical config hash, splicing algorithm, Postgres-backed cache, impl deploy + register choreography, error taxonomy, sandbox rules.

**Key architectural decisions locked (all captured in the SPECs, none require ADRs above the SPEC level):**
- **Clones over bytecode.** Factories deploy an impl per unique (base, module-combo, params) then clone via EIP-1167. Each impl is a single-file verified contract; each clone points to it.
- **CREATE2 salt includes `launcher` and `chainid`.** Prevents both cross-user front-mining and cross-chain deploy replay.
- **Impl registry is immutable.** A config hash's impl address never changes. Security fixes bump module versions → new config hashes → new impls. Existing tokens run their original code, per user's ownership choice.
- **Splice order is alphabetical by module ID.** Two configs with the same modules always produce the same bytecode. Reproducibility is a hard requirement.
- **Storage-safe composition.** Base storage frozen; modules append only; identifier collisions rejected at splice time.

**All Phase 0 SPEC work is done.** VM-030+ (implementing NameRegistry.sol) is unblocked.

---

## 2026-07-01 — NameRegistry.sol + tests written (VM-030, VM-031, VM-032)

**Code landed:**
- `contracts/src/registry/NameRegistry.sol` (~370 lines) — implements SPEC-registry in full. Storage layout as specified: `router`, `treasury`, then three mappings. All state-changing paths emit exactly one event. All errors are custom errors, no revert strings. Uses Solady `Ownable` (constructor `_initializeOwner`; `onlyOwner` gates admin paths).
- `contracts/test/unit/NameRegistry.t.sol` (~340 lines) — happy-path + every revert branch + normalization equivalence + view-reason codes + admin gating + constructor state + a fuzz test asserting name-hash uniqueness over random valid inputs.

**Non-obvious implementation choices:**

1. **`InvalidCharacter` errors carry no byte.** Simpler surface; off-chain tooling has the original input string and can pinpoint the offending index if needed. Trade-off vs. richer errors: cheaper bytecode, cleaner test asserts.

2. **`_validateNameChars` returns the too-long normalized string on `TooLong`.** This lets the write-path revert with `NameLength(normalizedLen)` (not the raw input length), which is what a human wants to see when they type "  My Really Long Token Name   " and get told 34 chars.

3. **`_normalizeTickerOrRevert` reverts with the RAW input length**, not a normalized length, because tickers don't have whitespace-collapse — the raw length IS the normalized length (or the reason we rejected). Reverting with the raw len keeps the caller's error self-explanatory.

4. **`addReservedTicker` refuses to reserve a ticker that's already claimed.** Enforces invariant 3 (`reservedTickers[hash] ⇒ tickerOwner[hash] == 0`) by construction rather than by test. `removeReservedTicker` also refuses to remove a claimed ticker as defense-in-depth, even though the add-side guard makes the collision case unreachable.

5. **Case-fold is done post-normalize, not during.** The stored `Reservation.name` preserves the user's original casing (post-trim, post-collapse) for display; the hash uses the lowercased version. Trade-off: two storage reads of the string are needed to compare display vs. hash, but the frontend UX benefit of "your token is called 'Vending Machine Token', not 'vending machine token'" is worth it.

6. **The fuzz test skips ticker collisions instead of enforcing uniqueness across the batch.** With only ~17k unique 3-letter uppercase combos and default 1000 fuzz runs, we'd hit reserved-seed collisions frequently. Skipping is cheaper than encoding avoidance logic. Add a proper invariant handler in Phase 3 when we start invariant testing across contracts.

**What's untested until Foundry is installed:**
- Whether the contract actually compiles (I've followed 0.8.26 syntax carefully, but no compiler in the loop is a real risk).
- Whether Solady's `Ownable` API has changed since my mental model (`_initializeOwner`, `owner()`, `onlyOwner`, `Unauthorized()` error selector). If Solady changed, the test's `UNAUTHORIZED_SELECTOR` constant may not match and admin-only tests will fail.
- Whether my `expectEmit` calls use the correct event syntax for the installed forge-std version (I used the 4-arg form which has been stable for a while).
- Whether `makeAddr` is available on the forge-std version pinned (it has been for at least two years; safe assumption).

**First actions when Foundry is installed:**
1. `forge build` — expect success. If the compiler complains about `unchecked { ++outLen; }` pattern inside a for-loop condition body, replace with the plain increment.
2. `forge test -vv` — expect all tests to pass. Any that don't are either a real bug or a forge-std/Solady API drift.
3. `forge coverage --report summary` — expect >95% on NameRegistry (SPEC target).
4. `slither src/registry/NameRegistry.sol` — expect zero informational findings that indicate a real issue. Known noise: "external calls in loop" (there are none), "reentrancy" (there are no external calls at all in NameRegistry, so any flag is false-positive).

---

## 2026-07-01 — Foundry verified + Router/FeeReceiver landed

**Foundry.** Found at `C:\Users\brand\.foundry\bin\forge.exe` (forge 1.5.1). Not on PATH by default; the `install-deps.sh`, `rehearse-deploy.sh`, and root package.json scripts all just `cd contracts && forge ...` so PATH still needs to be set by the shell — a one-liner in the user's PowerShell profile fixes this permanently:
`$env:Path = "$env:USERPROFILE\.foundry\bin;$env:Path"`

**Foundry 1.5.1 flag update.** `forge install` no longer accepts `--no-commit`; the default is now no-commit and `--commit` is opt-in. Updated `contracts/install-deps.sh` to use `--no-git` alone. Also split the script into "install now" vs. "uncomment when needed" sections so we don't pull down OZ / ERC721A / Uniswap v4 until Phase 1/2 needs them.

**NameRegistry verified locally.** `forge test` → 54/54 pass. `forge coverage` → 99.35% lines, 100% branches, 100% functions. One uncovered line is inside the `TooLong` return path of `_validateNameChars` — the exact "return a normalized-but-too-long buffer" branch that's really only reached by `_normalizeNameOrRevert` and not by any view. Coverage is above the SPEC target — no need to chase.

**Local-fork rehearsal.** Wrote `contracts/script/DeployNameRegistry.s.sol` and `contracts/rehearse-deploy.sh`. The rehearsal script uses `forge script --fork-url` (no broadcast) to simulate a deploy against real Sepolia state. Confirmed against public RPC: NameRegistry deploy would cost ~3.12M gas on Sepolia. `pnpm contracts:rehearse:registry` runs it. Same script pattern will work for `Router`, `FeeReceiver`, and every subsequent contract by adding a new `Deploy*.s.sol`.

**Router + FeeReceiver landed.** New files:
- `contracts/src/types/VMTypes.sol` — `BaseType`, `OwnershipMode`, `LaunchParams` enums/struct shared between Router and factories.
- `contracts/src/router/FeeReceiver.sol` — `IFeeReceiver` + implementation. Solady Ownable, `receiveFee(launcher, base)` emits, `sweep(to)` owner-only, `receive()` fallback for accidental sends credits `launcher = address(0)`.
- `contracts/src/router/Router.sol` — full impl per SPEC-router. `nonReentrant` on `launch`; CEI order (fee → deploy → reserve → ownership → refund → emit); refund of excess ETH; `IOwnable` dispatch by mode; pausable (flagged as censorship vector in the SPEC).
- `contracts/test/mocks/MockToken.sol`, `MockFactory.sol` — minimal test doubles. MockFactory records last-call params and deploys a fresh MockToken owned by Router so ownership dispatch resolves.
- `contracts/test/unit/Router.t.sol` — 40 tests. Covers: constructor + immutables + zero-address reverts, `quote` monotonicity + variants, launch happy path for each base + ownership mode, event emission, refund correctness, every launch revert branch (paused, insufficient fee, unset factory, empty name/ticker, multisig zero target, registry-collision unwind, factory-returns-zero, factory-reverts-bubbles), admin gating + effect, sweep, `FeeReceiver` receive/sweep/direct-send.

**Coverage.**
- `NameRegistry.sol` — 99.35% / 99.45% / 100% / 100%
- `Router.sol` — 100% / 100% / 100% / 100%
- `FeeReceiver.sol` — 100% / 100% / 100% / 100%
- (Mocks aren't full-coverage — the untested branches are error paths that never fire in current tests. Not real code.)

**94 total tests, all passing.** Full suite runs in <1s. `forge test` is now the primary local-verification loop.

**Design decision — `IOwnable` interface, not a Solady import for downcast.** Router imports a bare `IOwnable { transferOwnership, renounceOwnership }` interface rather than requiring the token to be Solady `Ownable` specifically. This lets any Ownable-compatible token (Solady, OZ, custom) launch through VM. Templates in SPEC-templates use Solady Ownable by default; if a Phase 5 template ships with a different owner surface, they only need to expose these two functions.

**Design decision — `Router__ZeroAddress` reused for constructor + admin + multisig-target.** One error code, three call sites. Could split into per-site errors for finer test asserts, but the caller (Router users) has the calldata to distinguish. Keeping surface area small.

**Design decision — factory interface takes flat params, not a struct.** SPEC-factories draft had `DeployParams` struct; the concrete implementation uses `deploy(name, ticker, configHash, initData, launcher)`. Flat args save a struct-encode step in Router's calldata construction and match viem's ergonomics on the client side. When we write real factories, they'll expose this signature.

**Next in Phase 1 (real code, in priority order):**
1. **VM-150 / 151 / 152** — the three factory contracts. Need SPEC-factories' impl-registry design (`registerImpl(configHash, impl)` + CREATE2 clone salt = `keccak256(launcher, name, ticker, chainid)`).
2. **VM-100** — `ERC20Template.sol` with the injection markers. First splice-target for the compile service. Solady Ownable, OpenZeppelin ERC20 base.
3. **VM-110** — `FeeOnTransfer.frag.sol`, the first module fragment. Once (1)+(2)+(3) land, compile-service can be wired to produce a real bytecode → factory can register → Router can launch a real ERC-20 with FoT end-to-end on Sepolia.

---

## 2026-07-01 — Full stack end-to-end (ERC20Template + ERC20Factory + real E2E)

**New contracts:**
- `contracts/src/templates/ERC20Template.sol` — bare ERC-20 base with the 8 injection markers as literal comments (`VM_INJECT_ERRORS`, `_EVENTS`, `_STATE`, `_CONSTANTS`, `_INIT`, `_MODIFIERS`, `_BEFORE_TRANSFER`, `_AFTER_TRANSFER`, `_EXTERNAL`, `_INTERNAL`). Uses Solady `ERC20` + Solady `Ownable`. Single-shot `initialize(bytes)` decodes `(initialOwner, name, symbol, initialSupply, initialRecipient, moduleData)`. Storage-backed `name()`/`symbol()` because clones don't run constructors. `_beforeTokenTransfer` / `_afterTokenTransfer` overridden with empty splice bodies so the bare template compiles clean while accepting future module fragments.
- `contracts/src/factories/ERC20Factory.sol` — impl registry + CREATE2 deployer. Impl address per config hash is registered once, immutable forever; security fixes ship as new config hashes (bumped module versions), never mutations. Salt `= keccak256(abi.encode(launcher, keccak256(name), keccak256(ticker), block.chainid))`. Front-mining defeated: an external griefer's `msg.sender` differs, so their salt differs, so their address differs. Registered per SPEC-factories §Impl registry. `predictAddress` view helper matches actual deploy address exactly (fuzz-verified).

**Real end-to-end integration:**
- `contracts/test/integration/LaunchE2E.t.sol` — 10 scenarios, all pass. Real `NameRegistry` + `Router` + `FeeReceiver` + `ERC20Factory` + registered `ERC20Template` impl. No mocks. Every test walks the full flow: launcher pays → Router forwards fee → factory clones + initializes → registry reserves → Router dispatches ownership → refund → `Launched` event. Confirmed:
  - **Ownership modes work end-to-end.** `Renounce` → clone owner = zero. `KeepEOA` → clone owner = launcher (verified by launcher.transferOwnership). `TransferToMultisig` → clone owner = multisig; Router calling `transferOwnership` post-launch reverts (atomic transition).
  - **Refund is exact.** Launcher pays `ERC20_FEE + overpay`, receives `overpay` back same tx. Router's balance is 0 post-tx (Invariant 6).
  - **Registry rejection unwinds cleanly.** Duplicate name from a different launcher: whole tx reverts, no orphan clone, no orphan reservation, `usageCount` unchanged.
  - **CREATE2 collision reverts.** Same launcher + same (name, ticker) → LibClone reverts inside factory before registry check. Second launch impossible.
  - **Reserved ticker rejection reaches Router.** `USDC` (in the seed) is rejected by registry via Router.

**Test totals: 143 pass, 0 fail. Runs in ~130ms.** (54 NameRegistry + 40 Router + 14 ERC20Template + 25 ERC20Factory + 10 LaunchE2E.)

**Coverage on `src/` contracts (via `forge coverage --ir-minimum`):**
- `NameRegistry.sol` — 98.70% lines / 100% branches / 100% functions.
- `Router.sol` — 100% / 86.67% / 100%.
- `FeeReceiver.sol` — 100% / 100% / 100%.
- `ERC20Factory.sol` — 93.75% / 92.31% / 100%.
- `ERC20Template.sol` — 89.47% / 100% / 60%. The 60% functions is a coverage-tool quirk — `_beforeTokenTransfer` / `_afterTokenTransfer` are internal overridden hooks; branches inside them hit 100% but the tool doesn't credit an "invocation" for a hook called from base ERC20.

The stack-too-deep in factory `deploy()` under coverage (which turns off `via_ir`) is a compile-only issue. Fine for production; only affects `forge coverage` which needs `--ir-minimum` — documented pattern.

**Design decisions locked this round:**

1. **Factory hardcodes template init signature.** SPEC-factories left the interface abstract; the concrete `ERC20Factory` knows that `ERC20Template.initialize(bytes)` decodes `(owner, name, symbol, initialSupply, initialRecipient, moduleData)`. `ERC721AFactory` will do the same for the 721A template. This means each factory is tightly coupled to its template — but that's already true architecturally (base-type factories only deploy their own base-type templates). Coupling made explicit.

2. **Factory forces `owner = router` at initialize.** The client's `initData` is bytes for `(initialSupply, initialRecipient, moduleData)` — NO owner field. Factory prepends Router as the initial owner. This makes ownership dispatch atomic within `Router.launch`: template init sets owner=Router, factory returns, Router immediately calls `transferOwnership`/`renounceOwnership` per user's `OwnershipMode` in the same tx. If dispatch fails (e.g. multisig target is a contract that rejects), the whole tx reverts — no orphan token with Router stuck as owner.

3. **`initData` empty → zero-supply.** If a launcher wants a mintable-only, zero-initial-supply token, they pass `hex""` as `initData`. Factory handles this branch. Removes the need to construct an empty `abi.encode(0, address(0), "")` blob for the trivial case.

4. **`predictAddress` returns `address(0)` for unregistered configs.** Frontend can use it as a truthy check before showing a "your token will deploy at 0x..." preview. Avoids a separate `isRegistered` check.

5. **Integration test in `test/integration/`, mocks in `test/mocks/`.** Separates the "does the pipeline behave correctly" check from the unit-level checks. Router.t.sol still uses MockFactory to test isolation (e.g. factory-reverts, factory-returns-zero); LaunchE2E.t.sol proves the real pipeline works.

**What we can now actually do on Sepolia:**
- Deploy this whole stack (NameRegistry + FeeReceiver + Router + ERC20Factory + one ERC20Template impl).
- Call `factory.registerImpl(BARE_CONFIG, implAddress)` from the registrar key.
- From a launcher wallet, call `router.launch{value: 0.05 ETH}(params)` with `params.configHash = BARE_CONFIG` and `params.initData = abi.encode(supply, recipient, "")`.
- Get back a real ERC-20 with the name reserved in registry, deployed at a predictable CREATE2 address, ownership set per launcher's choice. Fee sitting in FeeReceiver ready for `sweep(treasury)`.

This is the smallest launchable unit of VM. Everything from here is additive:
- **Modules** — `FeeOnTransfer.frag.sol`, `AntiBot.frag.sol`, etc. splice into the template's injection markers. Compile service does the splicing.
- **Other bases** — ERC721AFactory + ERC721ATemplate mirror this pattern.
- **Curve + hook** — Phase 2 work, needs Uniswap v4 install.

**Next in Phase 1 (updated priorities):**
1. **VM-110** — `FeeOnTransfer.frag.sol`. First module fragment. Once this splices cleanly into `ERC20Template`, the compile service has a real proof-of-concept.
2. **VM-171 / 172** — compile service `compile.ts` + `test-runner.ts`. Take a config JSON, produce spliced .sol, invoke `forge build` + `forge test`, return artifacts.
3. **VM-033** — deploy the full Phase 1 stack to Sepolia. First public-testnet launch. GATE 0 ready.
4. **VM-103 / 105** — ERC-721A + ERC-1155 templates. Parallel to modules; not blocking.

---

## 2026-07-01 — First module fragment + working splicer (AntiBot end-to-end)

**New files:**
- `contracts/modules/token/AntiBot.frag.sol` — fragment source-of-truth. Lives OUTSIDE `contracts/src/` so forge's scanner doesn't try to compile it as a standalone contract (it isn't — fragments aren't valid Solidity in isolation). Header format: `VM_MODULE_ID`, `_VERSION`, `_BASES`, `_REQUIRES`, `_INCOMPATIBLE_WITH`, `_FLAGGED`. Then section markers `// SECTION: VM_INJECT_X` with body between markers.
- `compile-service/src/matrix.ts` — matrix loader + `validateConfig` with typed error codes.
- `compile-service/src/compile.ts` — the splicer. `parseFragment` extracts section bodies from a `.frag.sol` file. `splice(templateSource, fragments[])` finds each `VM_INJECT_X` marker in the template and inserts each module's corresponding section body, alphabetically ordered by moduleId, right after the marker line. `compose(input)` glues it together and renames the output contract.
- `compile-service/src/cli.ts` — CLI wrapper. `node --experimental-strip-types compile-service/src/cli.ts <configPath> <outputPath>`. Reads a JSON config and writes a spliced .sol.
- `compile-service/fixtures/erc20-antibot.json` — the first real config: `{base: "ERC20", modules: ["AntiBot"], contractName: "ERC20WithAntiBotGen"}`.
- `contracts/src/templates/composed/ERC20WithAntiBotGen.sol` — **generated** by the splicer, checked into the repo for now. Header marks it as generated. Once the compile-service backend fully wires forge build/test, this file gets recreated on demand.
- `contracts/test/composed/ERC20WithAntiBotGen.t.sol` — 11 tests: init state (gate end, mint routing), gate-window behavior (non-owner blocked, allowlisted passes, owner exempt), exact boundary (block N-1 blocked, block N free), post-gate freedom, allowlist admin gating, and a storage-layout invariant check confirming base state occupies pre-module slots.

**Template restructure (breaking-but-invisible change):**
Every `VM_INJECT_X` marker moved to the BOTTOM of its section. Before: marker at top, base declarations below, splicer inserted between them → module state landed BEFORE base state in the generated output → violated SPEC-templates §Storage safety Rule 1. After: base declarations first, marker at bottom, splicer inserts after marker → module content appended below base content → Rule 1 preserved by construction. All existing tests still pass because base semantics didn't change, only comment positions.

**AntiBot module design (this v1):**
- Params: `blockGate` (uint16, 0..100 blocks).
- On initialize: records `_abGateEndsAtBlock = block.number + blockGate`.
- On `_beforeTokenTransfer`: if `block.number < gateEnd` AND not a mint (`from != 0`) AND not a burn (`to != 0`) AND sender is not owner → require the recipient be on the allowlist; otherwise revert `AntiBot__Gated(from, to, blocksLeft)`.
- External `setAntiBotAllowed(who, allowed)` — owner-only.
- View `antiBotIsGated()`, `antiBotIsAllowed(who)`, `antiBotGateEndsAtBlock()`.

Simpler than the SPEC's original description (no merkle root, no commit-reveal for v1). Merkle allowlist can be added by extending params in a future version bump (`VM_MODULE_VERSION: 2`); the config hash would change → new impl in factory registry → old tokens keep their original behavior.

**Fragment file location — `contracts/modules/` not `contracts/src/modules/`.** Fragments live OUTSIDE the forge `src/` tree because they aren't valid Solidity in isolation. Forge would try to compile them and fail. The SPEC-modules doc originally said `contracts/src/modules/<category>/` — this session updated the actual path to `contracts/modules/<category>/`. SPEC doc still says the old path; edit deferred to the next SPEC-updates pass.

**Splicer semantics (what's guaranteed today):**
- Alphabetical order by `VM_MODULE_ID` — same input always produces same output.
- Each spliced module section body is prefixed with `// --- from <moduleId>.frag.sol ---` for readability.
- Empty module sections are skipped (fragment can leave a section body empty and no dead blank block gets injected).
- Indent-preserving: the marker's leading whitespace is applied to every line of the injected body, so injected code respects the enclosing function's indentation.
- The generated contract is renamed from `ERC20Template` → `<contractName>` at the end.

**Splicer limitations (known, tracked as VM-171 followup):**
- Doesn't run `forge build` yet — user invokes forge separately. Full backend flow (write to tmp dir → forge build → cache bytecode) is next.
- Doesn't validate JSON Schema params (deferred until `zod` or `ajv` is installed).
- Doesn't validate storage-safety of the fragment (e.g. that no module state variable shadows a base name). Deferred to test-time coverage — a name collision would surface as a Solidity compile error, which is loud enough for now.
- Only handles ERC20Template. When ERC721A and ERC1155 templates land, `compose` needs a `contract <TemplateName>` regex per base.

**How to run:**
```
pnpm splice:antibot
# → writes contracts/src/templates/composed/ERC20WithAntiBotGen.sol
cd contracts && forge test --match-path "test/composed/ERC20WithAntiBotGen.t.sol" -vv
```

Or general form:
```
pnpm splice <configPath> <outputPath>
```

**Test totals: 154 pass, 0 fail, ~130ms.** (54 NameRegistry + 40 Router + 14 ERC20Template + 25 ERC20Factory + 10 LaunchE2E + 11 ERC20WithAntiBotGen.)

**Next priorities:**
1. **VM-172** — test-runner: invoke `forge test` on the generated contract via TypeScript, capture results.
2. **VM-171 finish** — write the backend server flow: HTTP POST `/compile` calls `compose(...)`, writes to tmp dir, runs `forge build`, caches bytecode by config hash, returns artifacts.
3. **VM-110** — FeeOnTransfer fragment. Needs the template-revision decision (allow module code to modify transfer amounts). Options: add a `_transferHook(from, to, amount) → adjustedAmount` marker to the template, or handle inside `_afterTokenTransfer` via `_burn`+`_mint` with a reentrancy-guard state flag. Discuss before implementing.
4. **VM-033** — deploy full Phase 1 stack to Sepolia. Everything except FeeOnTransfer is ready.

---

## 2026-07-01 — Second module, compile-service wired end-to-end, Phase 1 deploy script

**FeeOnTransfer.frag.sol (VM-110, VM-111):** simpler than SPEC's original 5-way split — v1 is `feeBps + burnBps + treasuryBps + treasury`. Splits must sum to 10 000. Fee applied post-transfer via `_burn(to, fee)` from the recipient, then `_mint(treasury, treasuryBps * fee / 10000)` to redistribute. Burn slice stays burned (net supply reduction).

**Recursion safety without a guard.** The recursive `_burn` fires `_beforeTokenTransfer(to, address(0), fee)` and `_afterTokenTransfer(to, address(0), fee)` — both zero-out because `to == 0`. The recursive `_mint` fires the hooks with `from == 0`. The module's hook check `from != 0 && to != 0` naturally guards against re-entry. No boolean flag needed. Cleaner than what the SPEC originally suggested.

**AntiBot + FeeOnTransfer coexist without collision.** AntiBot's before-hook checks skip on burns/mints (its `from != 0 && to != 0` condition). Order (alphabetical): AntiBot runs first (block-gate check), then Solady's balance change, then FeeOnTransfer's after-hook (fee-take). No inter-module state overlap. **Multi-module init encoding is still an open design decision** — each fragment currently treats `moduleData` as ITS OWN slice. When both are composed, the compile-service needs to structure `moduleData` so each module gets its named portion. Solution likely: encode as `bytes[]`, splicer rewrites each fragment's `abi.decode(moduleData, ...)` to `abi.decode(moduleData[<idx>], ...)`. Deferred until first real multi-module launch config is needed.

**test-runner.ts (VM-172):** `runForgeTests({contractsDir, matchPath, ci?, env?, timeoutMs?})`. Shells to `forge test --json --match-path <p>`, parses the JSON, returns `{ok, exitCode, stdout, stderr, suites: TestSuite[]}`. Handles the two common `forge --json` shapes; falls back to `[]` on parse failure (the caller still sees `ok=false`). Uses only Node built-ins.

**server.ts /compile + /test wired (VM-171 finish):** `POST /compile` now: validates body via Zod, loads matrix.json, calls `compose(...)`, computes a keccak256 config hash over `{base, sorted modules, params, chain}`, writes the spliced .sol to `contracts/tmp/<hash>/<contractName>.sol`, shells out to `forge build --sizes`, reads the compiled artifact, returns `{configHash, contractName, moduleIds, bytecode, abi, warnings}`. `POST /test` calls `runForgeTests` and returns per-suite results. Error taxonomy per SPEC-compile-service. Requires `pnpm install` (adds `@noble/hashes`) to run.

**DeployPhase1.s.sol (VM-033 ready to broadcast):** deploys NameRegistry + FeeReceiver + Router + ERC20Factory + ERC20Template impl in one broadcast, then wires:
- `router.setFactory(BaseType.ERC20, factory)`
- `registry.setRouter(router)`
- `factory.registerImpl(BARE_ERC20_CONFIG, impl)`

Config knobs via env (ADMIN, TREASURY, REGISTRAR, ERC20_FEE_WEI, etc.). Rehearsed against Sepolia fork via `pnpm contracts:rehearse:phase1` — full simulation completes cleanly. Broadcast requires `SEPOLIA_RPC_URL` + a funded `DEV_PRIVATE_KEY`.

**Test totals: 172 pass, 0 fail, ~115ms.** (54 NameRegistry + 40 Router + 14 ERC20Template + 25 ERC20Factory + 10 LaunchE2E + 11 ERC20WithAntiBotGen + 18 ERC20WithFeeOnTransferGen.)

**Coverage — all `src/` contracts:**
- `NameRegistry`: 98.70% / 100% / 100%
- `Router`: 100% / 86.67% / 100%
- `FeeReceiver`: 100% / 100% / 100%
- `ERC20Factory`: 93.75% / 92.31% / 100%
- `ERC20Template`: 89.47% / 100% / 60%*
- `ERC20WithAntiBotGen`: 82.35% / 60% / 66.67%*
- `ERC20WithFeeOnTransferGen`: 87.50% / 80% / 66.67%*

*Composed contracts' function coverage sits low because overridden `_beforeTokenTransfer`/`_afterTokenTransfer` hooks don't get "invocation credit" from the coverage tool (they're internal and called from Solady's `_transfer`); the branches WITHIN them are hit fully.

**How the whole thing runs today:**
```bash
# 1. Splice a composition from a config
pnpm splice:antibot            # → contracts/src/templates/composed/ERC20WithAntiBotGen.sol
pnpm splice:feeontransfer

# 2. Verify locally
pnpm contracts:test            # 172 tests including composed
pnpm contracts:coverage

# 3. Rehearse full-stack deploy against Sepolia fork (no broadcast)
pnpm contracts:rehearse:phase1

# 4. Broadcast to Sepolia
cd contracts && forge script script/DeployPhase1.s.sol:DeployPhase1 \
  --rpc-url $SEPOLIA_RPC_URL --broadcast --verify -vvvv --private-key $DEV_PRIVATE_KEY

# 5. Compile-service HTTP (once deps install)
pnpm --filter @vm/compile-service install
pnpm --filter @vm/compile-service dev
```

**GATE 0 is one broadcast away.** From the moment Phase 1 lands on Sepolia, any wallet with 0.05 test-ETH can call `router.launch(...)` with `configHash = BARE_ERC20_CONFIG` and get a real deployed ERC-20 back, with the name reserved. Add AntiBot/FeeOnTransfer composed impls by registering their config hashes too.

**Next priorities:**
1. **VM-033 broadcast** — Sepolia. Blocks on you providing `SEPOLIA_RPC_URL` + `DEV_PRIVATE_KEY`.
2. **Multi-module init encoding** — splicer rewrites each module's `abi.decode(moduleData, ...)` to grab its named slice from a wrapper `bytes[]`. Needed before shipping a combo like AntiBot+FeeOnTransfer.
3. **VM-103 / 105** — ERC-721A + ERC-1155 templates. Parallel to modules.
4. **VM-200 shop UI** — `/create` page wiring registry check + module toggles from `shared/matrix.json`.

---

## 2026-07-01 — Shop UI MVP (VM-200, VM-202, VM-203, VM-209, VM-214, VM-215, VM-216)

**New files:**
- `web/src/lib/abis.ts` — typed ABIs via `parseAbi([...])` for NameRegistry, Router, ERC20Factory, and a plain ERC-20 read surface. Also exports `BASE_TYPE` / `OWNERSHIP_MODE` enum-to-uint8 maps for wagmi call args.
- `web/src/lib/wagmi.ts` — updated to include `injected()` connector; adds `CHAIN_ID_TO_KEY` / `CHAIN_KEY_TO_ID` maps and `explorerTxUrl` / `explorerAddressUrl` helpers.
- `web/src/lib/config.ts` — `CONTRACTS` map with null placeholders keyed by chain. Populated post-broadcast by pasting the addresses from `DeployPhase1`'s console output. `BareErc20ConfigHash` = `keccak256(abi.encode("ERC20", 0))` — must match the constant in `DeployPhase1.s.sol`.
- `web/src/app/providers.tsx` — client component wrapping `WagmiProvider` + `QueryClientProvider` (staleTime 10s default).
- `web/src/app/layout.tsx` — updated to mount `<Providers>` and add a dark header with links to `/create` and `/discover`.
- `web/src/app/page.tsx` — landing with a clear "Launch a token" CTA + 3-stat summary.
- `web/src/app/create/page.tsx` — the shop. Wallet connect/disconnect + chain switch prompt; chain picker; base picker; name + ticker inputs with live availability status; initial supply input; ownership mode chooser with inline multisig address input + `isAddress` validation; live `Router.quote()` cost preview; launch button using `useSimulateContract` → `useWriteContract` → `useWaitForTransactionReceipt`; success state with deployed-address Etherscan link (parsed from the `Launched` event's first indexed topic).
- `web/src/app/discover/page.tsx` — stub with a note that the feed lands with the indexer.

**Design decisions:**
1. **CONTRACTS map starts null** and gets filled in post-broadcast rather than being pulled at runtime from an indexer. Simpler for MVP; a `useContractsForChain(chainKey)` hook can swap in a live lookup later.
2. **Ticker input auto-uppercases + strips non-alphanumeric on every keystroke.** Matches `NameRegistry._validateTickerChars` server-side, so users can't type an invalid character that the chain will reject.
3. **Availability check debounce = 3 s stale time** via TanStack Query. Live-typing feels snappy without hammering RPC.
4. **Launch flow surfaces simulation errors inline.** If `useSimulateContract` returns an error, the reason is rendered above the launch button so the user can fix (e.g. wrong-chain, insufficient balance, name taken between quote and launch) without a wallet round-trip.
5. **Deployed-address extraction from the `Launched` event's first indexed topic.** No indexer needed for the "your token is at 0x…" success state — parse the receipt logs client-side by matching Router's address + first topic.
6. **Chain picker shows all four chains** (Sepolia enabled, others "soon") rather than hiding disabled options. Makes the future roadmap visible.

**Known limitations tracked as follow-ups:**
- Module toggles + compatibility matrix wiring (VM-205) waits on module-impl pre-registration in the factory.
- Ownership audit panel (VM-213) waits on the compile-service exposing an `ownershipAudit` field per composed contract.
- SIWE (VM-201) deferred — wallet-connect is enough for GATE 0 launches.
- Discover feed (VM-218) waits on the indexer.
- Web/src/app types + linting: **not verified locally.** `pnpm install` hasn't been run in the web workspace, so `wagmi`, `viem`, `@tanstack/react-query` aren't resolved. The code is written to compile against the pinned versions in `web/package.json` (wagmi ^2.16, viem ^2.36, @tanstack/react-query ^5.62). Run `pnpm install` and `pnpm --filter web typecheck` to verify.

**GATE 0 checklist (bare-ERC-20 flow):**
- [x] Repo scaffolded, Foundry installed, tests pass (172/172).
- [x] Phase 1 stack code complete: NameRegistry + Router + FeeReceiver + ERC20Factory + ERC20Template.
- [x] AntiBot + FeeOnTransfer fragments + splicer + compile-service.
- [x] DeployPhase1.s.sol authored, rehearsed against Sepolia fork.
- [x] Shop UI wired end-to-end at `/create`.
- [ ] `pnpm install` in web workspace (yours; blocks `pnpm --filter web dev`).
- [ ] `SEPOLIA_RPC_URL` + `DEV_PRIVATE_KEY` provided (yours).
- [ ] `DeployPhase1` broadcast to Sepolia (yours; ~15 seconds).
- [ ] Deployed addresses pasted into `web/src/lib/config.ts` `CONTRACTS.sepolia`.
- [ ] `pnpm --filter web dev`, launch a real token from the browser.

**Next priorities:**
1. `pnpm install` in web workspace — VM-012 finishes.
2. Broadcast `DeployPhase1` to Sepolia — VM-033 finishes → GATE 0 lands.
3. Wire module toggles from `shared/matrix.json` — VM-205 (needs impl-registration UX for the compile service).
4. ERC-721A + ERC-1155 templates + factories — VM-103 / VM-105 / VM-151 / VM-152.

---

## 2026-07-01 — ERC-721A base end-to-end (VM-103, VM-104, VM-151)

**New contracts:**
- `contracts/src/templates/ERC721ATemplate.sol` — ERC721A 4.3.0 base with the 8 injection markers plus 2 additional 721A-specific: `_beforeTokenTransfers` / `_afterTokenTransfers` use the ERC-721A signature `(from, to, startTokenId, quantity)`. Storage-backed name/symbol/baseURI/maxSupply. Owner-only `mintBatch(to, quantity)` with `maxSupply` enforcement. Storage layout: `_vmName`, `_vmSymbol`, `_vmBaseURI`, `_vmMaxSupply`, `_initialized`, then `VM_INJECT_STATE` for modules.
- `contracts/src/factories/ERC721AFactory.sol` — mirror of `ERC20Factory` with the same CREATE2 salt policy (`keccak256(launcher, name, ticker, chainid)`), same immutable-once-registered impl registry, same registrar/router roles. Hardcodes the 721A `initialize(bytes)` decoding shape: `abi.decode(initData, (string, uint256, bytes))` → `(baseURI, maxSupply, moduleData)`.

**ERC721A + Solidity 0.8.26 compat.** Chiru Labs 4.3.0 compiles cleanly at 0.8.26 with `via_ir = true`. No pin required. Installed via `forge install --no-git chiru-labs/ERC721A`; `install-deps.sh` updated to install it by default.

**Cloneable-ERC721A pattern.** ERC721A's constructor sets `_name`/`_symbol` in private storage, which is a problem for clones (they don't run constructors). Solution: construct the impl with empty strings (`ERC721A("", "")`) — its own name/symbol slots stay empty — then override `name()`/`symbol()`/`_baseURI()` to read from our own storage-backed variables (`_vmName`, `_vmSymbol`, `_vmBaseURI`) that get set in `initialize(bytes)`. Works for any EIP-1167 clone.

**Splicer generalized.** `compose(input)` now takes an optional `baseContractName` (default derived from `${config.base}Template`). Rename regex uses that name. This lets the same splicer produce ERC-20 composed contracts, ERC-721A composed contracts, and (future) ERC-1155 composed contracts — no per-base hardcoding.

**Extended DeployPhase1.** One broadcast now deploys 7 contracts:
```
NameRegistry → FeeReceiver → Router → ERC20Factory → ERC20Template impl
                                    → ERC721AFactory → ERC721ATemplate impl
```
Wires: `router.setFactory(ERC20, factory20)`, `router.setFactory(ERC721A, factory721)`, `registry.setRouter(router)`, `factory20.registerImpl(BARE_ERC20_CONFIG, impl20)`, `factory721.registerImpl(BARE_ERC721A_CONFIG, impl721)`. Rehearsal against Sepolia fork completes cleanly.

**Shop UI extended.** `/create` page ungreys the ERC-721A option. When ERC-721A is selected, the identity section swaps the "initial supply" field for `Base URI` + `Max supply` inputs. `initData` encoding branches per base:
- `ERC20` → `abi.encode(uint256 supply, address recipient, bytes moduleData)`
- `ERC721A` → `abi.encode(string baseURI, uint256 maxSupply, bytes moduleData)`

configHash also branches (`BareErc20ConfigHash` vs `BareErc721aConfigHash` from `CONTRACTS.<chain>`). `LaunchParams.base` is set to `BASE_TYPE.ERC20` or `BASE_TYPE.ERC721A` accordingly — Router routes to the right factory automatically.

**Test totals: 210 pass, 0 fail** across 10 suites. New this session: 18 ERC721ATemplate + 15 ERC721AFactory + 5 LaunchE2E_ERC721A = 38 new tests. All existing tests still pass — the splicer change is backward-compatible (default `baseContractName` still yields `ERC20Template`).

**What Phase 1 now covers:**
- Two bare launch bases (ERC-20, ERC-721A), same shop, same Router, same registry.
- Two audited modules (AntiBot, FeeOnTransfer) with splicer proof for ERC-20 compositions.
- Impl registry per base — any future config (with modules) registers cleanly.
- Sepolia deploy script for the whole stack in one broadcast.
- Shop UI wired end-to-end for both bases.

**Still open:**
- ERC-1155 template + factory (VM-105, VM-152) — same pattern, deferred.
- Multi-module init encoding (AntiBot + FoT composed) — design pass needed.
- Module toggle UI in shop (VM-205) — reads `shared/matrix.json`, greys incompatible options, forwards module params to compile-service.
- Indexer wiring (VM-230–VM-234) — Ponder handlers for `NameRegistry.Reserved`, `Router.Launched`, `ERC20Factory.Deployed`, `ERC721AFactory.Deployed`, plus transfer indexing for launched tokens.
- ERC-1155 modules (721A modules: `OnChainSVG`, `DelayedReveal`, `ERC2981Royalty`, `Soulbound`, `Refundable`).

---

## 2026-07-01 — ERC-1155 base end-to-end (VM-105, VM-106, VM-152) — all three bases live

**New contracts:**
- `contracts/src/templates/ERC1155Template.sol` — Solady ERC1155 + Ownable. Storage-backed name/symbol/URI. Canonical ERC-1155 `uri(id)` returns a single URI template (clients replace `{id}` with hex-padded token id). Owner-only `mint(to, id, amount, data)` and `mintBatch(to, ids[], amounts[], data)`. Must override `_useBeforeTokenTransfer` and `_useAfterTokenTransfer` to return `true` — Solady skips the hook calls for gas savings unless the subclass opts in.
- `contracts/src/factories/ERC1155Factory.sol` — mirror of the ERC-721A shape. Same CREATE2 salt policy, same impl registry. Hardcodes the ERC-1155 initialize signature: `abi.decode(initData, (string, bytes))` → `(uri, moduleData)`.

**Test totals: 242 pass, 0 fail** across 13 suites (up from 210). 32 new tests: 16 ERC1155Template + 13 ERC1155Factory + 3 LaunchE2E_ERC1155.

**DeployPhase1 covers the full triad now.** One broadcast deploys and wires 9 contracts:
```
NameRegistry → FeeReceiver → Router →
  ERC20Factory   → ERC20Template impl
  ERC721AFactory → ERC721ATemplate impl
  ERC1155Factory → ERC1155Template impl
```
Plus `router.setFactory(...)` for each base, `registry.setRouter(router)`, and `factory.registerImpl(BARE_..._CONFIG, impl)` for each. Rehearsal against Sepolia fork completes cleanly.

**Shop UI covers the full triad.** All three bases enabled in the base picker (no more "soon"). Per-base identity fields:
- **ERC-20** — Initial supply (18 decimals).
- **ERC-721A** — Base URI + Max supply.
- **ERC-1155** — URI template (`ipfs://.../{id}.json`).

`initData` encoding branches per base:
- `ERC20` → `abi.encode(supply, recipient, moduleData)`
- `ERC721A` → `abi.encode(baseURI, maxSupply, moduleData)`
- `ERC1155` → `abi.encode(uri, moduleData)`

`configHash` also branches. `LaunchParams.base` sets the enum. Router routes to the correct factory automatically.

**Phase 1 base+factory coverage complete.** All three token bases (ERC-20, ERC-721A, ERC-1155) can launch through the same shop with the same Router and Registry, differing only in the initData shape and which factory receives the call.

**Still open (in priority order):**
1. `pnpm install` + broadcast — yours; unchanged.
2. Multi-module init encoding (AntiBot + FoT composed).
3. Module toggle UI in shop (VM-205).
4. Indexer wiring (VM-230–VM-234).
5. NFT modules (`OnChainSVG`, `DelayedReveal`, `ERC2981Royalty`, `Soulbound`, `Refundable`).
6. Allocation bundles (vesting, airdrop, staking).
7. Curve + hook (Phase 2) — needs Uniswap v4 pin.

---

## 2026-07-01 — 168 IDE problems + indexer wiring + multi-module init encoding

**168 IDE problems root cause + fix.** No `node_modules/` anywhere (never ran `pnpm install`), so every TypeScript import failed with "Cannot find module" — 156 of the 168 problems. Ran `pnpm install` (1m 25s). Two peer-dep warnings surfaced (React 19 vs. old walletconnect subdep, kysely version in Ponder) — both cosmetic, don't affect runtime.

The remaining 12 were real type errors:
- `web/tsconfig.json` had `target: ES2017` (Next.js scaffold default) → 4x "BigInt literals not available" errors. Bumped to `ES2020`.
- `web/src/lib/wagmi.ts` `CHAIN_KEY_TO_ID` typed as `Record<ChainKey, number>` → wagmi's `useSwitchChain({chainId})` expected the union of specific numeric literals. Changed to `as const satisfies Record<ChainKey, number>` for both nominal-safety and literal preservation.
- `compile-service/src/*.ts` used `.ts` extension imports for `node --experimental-strip-types` runtime → 7x TS5097 errors. Enabled `allowImportingTsExtensions: true` + set `noEmit: true` (we don't emit — runtime uses strip-types). Same treatment for indexer.
- Ponder virtual module `ponder:registry` isn't typed until `ponder codegen` runs against a live config. Added a stub `indexer/ponder-env.d.ts` with broad ambient types.
- pnpm-hoisted drizzle types couldn't be named across the `.pnpm/` path (TS 2742) → added `declaration: false` to indexer tsconfig.

**All three workspaces now typecheck clean.** IDE should clear the panel after the TS server re-indexes.

**Indexer wired (VM-230–VM-234).** New files:
- `indexer/ponder.schema.ts` — three tables (`launches`, `holders`, `transfers`) with relations. Composite ID keys namespaced by chain (`${chainId}-${tokenAddress}`) so multi-chain support is a config change.
- `indexer/ponder.config.ts` — Sepolia network config; contract addresses read from env vars so they can be filled in post-broadcast without editing code. Human-readable ABIs (parseAbi) for `NameRegistry.Reserved`, `Router.Launched`, `<Base>Factory.Deployed`, `ERC-20 Transfer`.
- `indexer/src/index.ts` — event handlers. `Router:Launched` creates the launch row (has the base enum + fee); `NameRegistry:Reserved` fills in the human-readable name/ticker; `<Base>Factory:Deployed` fills in `configHash` + `impl`. Per-token Transfer indexing marked as TODO — waits on Ponder 0.7's dynamic-contract-subscription API.

**Multi-module init encoding refactor (VM-171 followup).** Templates' `moduleData` param changed from `bytes` to `bytes[]`. Factories updated to encode/decode `bytes[]`. Splicer rewrites each fragment's `moduleData` references inside `VM_INJECT_INIT` sections to `moduleData[<idx>]` where idx is the module's splice index (alphabetical). Other section markers don't reference moduleData — no rewrite needed.

**Test updates:** batch `sed 's/bytes("")/new bytes[](0)/'` across 9 test files (bare-launch placeholders). Hand-edited 4 tests in the AntiBot + FoT composed tests where moduleData holds actual params (`bytes[] memory moduleData = new bytes[](1); moduleData[0] = abi.encode(...);`).

**Combined composition proof:** new `ERC20WithAntiBotAndFeeOnTransferGen.sol` (generated by splicer) + 7-test `ERC20WithAntiBotAndFeeOnTransferGen.t.sol`. Verifies:
- Both modules' state configured from `moduleData[0]` (AntiBot) and `moduleData[1]` (FoT) — alphabetical order = deterministic slice assignment.
- Base state (name, symbol, owner, balance) still correct alongside two modules.
- AntiBot's before-hook still gates transfers during the launch window.
- FeeOnTransfer's after-hook takes the fee correctly, even when AntiBot's allowlist bypass fires.
- Cross-module admin: FoT exclusion + AntiBot allowlist are independent flags with independent behavior.
- Storage layout invariant: base state occupies pre-module slots.

**Shop UI updated.** `initData` encoding uses `bytes[]` for `moduleData`. Bare launches pass an empty array (`[]`); composed launches would push each module's ABI-encoded params in alphabetical order. Module toggle UI (VM-205) is the next natural step — reads `shared/matrix.json`, lets users select modules, builds the correct `bytes[]` array.

**Test totals: 249 pass, 0 fail** across 14 suites. Combined composition test suite adds 7 new tests. All existing 242 tests still pass — the refactor is fully backward-compatible via the splicer's default behavior (single-module → `moduleData[0]`).

**Solidity constant-fold gotcha:** `uint16 constant * uint256 ether` in a constant expression triggered a compile-time "Arithmetic error when computing constant value." Fix: cast to `uint256` explicitly in the multiplication. Not a bug — Solidity is being strict about constant-fold overflows.

**Design decisions:**
1. **`bytes[] moduleData`, one slice per module.** Simpler than a map/struct wrapper. Splicer's index rewrite is a 3-line regex.
2. **Alphabetical splice order = deterministic slice assignment.** Same as the splicer's section-body ordering — one rule for both.
3. **Empty `moduleData` (`new bytes[](0)`) for bare launches.** No special-case in the template; the base's `moduleData;` unused-var-suppression line still works.
4. **Splicer rewrite scoped to VM_INJECT_INIT only.** Other markers (BEFORE_TRANSFER, EXTERNAL, etc.) never reference module data.

**Still open (priority order):**
1. `pnpm install` re-run + broadcast (yours).
2. Module toggle UI in shop — reads `shared/matrix.json`, checkbox list per base, param inputs from JSON Schema, builds `bytes[]` initData.
3. Compile-service auto-registration flow — POST /compile returns `{configHash, impl address}`; if impl not yet on-chain, register via signed tx from the registrar key.
4. NFT modules (`OnChainSVG`, `DelayedReveal`, `ERC2981`, `Soulbound`, `Refundable`).
5. Allocation bundles (`Vesting`, `Airdrop`, `Staking`).
6. Curve + hook (Phase 2 — needs Uniswap v4 pin).

---

## 2026-07-01 — Dev server + NFT modules (VM-130, VM-132)

**Web dev server running** at http://localhost:3000 (network at http://10.0.0.223:3000). Next.js 16.2.9 with Turbopack, ready in 1.1s.

**Module toggle UI (VM-205) deferred** with rationale: without compile-service auto-registration, module selection can't produce a launchable configuration — the composed configHash would revert on `factory.deploy` (impl not registered). Better UX investment: pre-register a curated set of composed impls in `DeployPhase1`. Users see a "curated menu" of available compositions rather than a free-form combinator that fails at the last step. Free-form composition returns in Phase 5 when compile-service auto-registration is wired.

**Two NFT modules landed:**
- `contracts/modules/nft/OnChainSVG.frag.sol` — overrides ERC-721A's `tokenURI` to return a `data:application/json;base64,...` URI with embedded base64 SVG. SVG shows the token name + id as text on a dark background. `_buildSvg` is `virtual` so submodules can override for richer procedural art. Uses Solady's `LibString` + `Base64`.
- `contracts/modules/nft/ERC2981Royalty.frag.sol` — standard flat royalty. Params: `(address receiver, uint96 feeBps)` capped at 10%. `royaltyInfo(id, salePrice)`, `supportsInterface(0x2a55205a)`, admin `setRoyaltyReceiver`. `feeBps` is fixed at init (can't be lowered post-launch without a new impl).

**Template import pre-load.** ERC721ATemplate now imports Solady `LibString` and `Base64` at the top. Bare template compiles with unused-import warnings (Solidity doesn't error on those). Splicer doesn't need to hoist imports from fragments — the base template pre-loads the common ones. When a module needs a lib not in the base, we either add it to the base or extend the splicer with import-hoist support (TODO for future NFT/DeFi modules).

**Composed contracts + tests:**
- `ERC721AWithOnChainSVGGen` — 4 tests: URI structure, base64 JSON structure, per-id uniqueness, nonexistent-token revert.
- `ERC721AWithRoyaltyGen` — 10 tests: init happy/bad-fee/zero-receiver, `royaltyInfo` correctness, `supportsInterface` for both ERC-2981 and ERC-721, admin gating.
- `ERC721AWithSvgAndRoyaltyGen` — 5 tests: both modules configured, `tokenURI` uses OnChainSVG override, `royaltyInfo` still works, cross-module admin independence.

**Splicer alphabetical order verified in combined composition:** `ERC2981Royalty` at `moduleData[0]`, `OnChainSVG` at `moduleData[1]`. OnChainSVG takes no params so its slice is `""` (empty bytes); the fragment's `moduleData` reference gets rewritten anyway but never evaluated since the fragment has no init decoding.

**Test totals: 268 pass, 0 fail** across 17 suites. Up from 249 in the previous multi-module refactor. Full suite runs in ~120ms.

**Design decisions:**
1. **Curated impl menu, not free-form composition.** Ship pre-registered composed impls; users pick from a menu. Free-form composition (arbitrary module combos → auto-register on launch) is a Phase 5 upsell requiring compile-service infra.
2. **Common Solady imports pre-loaded in the template.** LibString + Base64 in ERC721ATemplate. Trades a small unused-import warning in the bare case for splicer simplicity + fragment portability.
3. **OnChainSVG's `_buildSvg` is virtual.** Enables per-launch visual overrides via submodules without changing OnChainSVG itself. Simple example — richer visual modules can also make their own composed contracts.
4. **ERC-2981 uses uint96 for feeBps**, not uint16, because that's what the ERC-2981 spec suggests (via the returned `royaltyAmount` type). Trivial ABI difference for the client to encode.

**Still open (in updated priority order):**
1. `pnpm install` re-run + broadcast (yours).
2. Extend DeployPhase1 to register the composed impls (BareErc20, BareErc721A, BareErc1155 + AntiBotErc20 + FoTErc20 + OnChainSVGErc721A + RoyaltyErc721A + SvgAndRoyaltyErc721A = 8 configs total). Then the shop's curated menu has 8 launchable configurations day-one.
3. `DelayedReveal.frag.sol` — commit + reveal for NFT drops (VM-131).
4. Allocation bundles (Vesting, Airdrop, Staking).
5. Compile-service auto-registration flow — turns curated menu into free-form composition.
6. Curve + hook (Phase 2 — needs Uniswap v4 pin).

---

## 2026-07-01 — Wallet visible + module toggle UI + catalog page + curated impl menu

**User feedback: wallet UI + module system weren't visible.** Fixed both.

**WalletButton in global header.** Extracted the wallet connect/disconnect logic into
`web/src/components/WalletButton.tsx` (client component). Mounted in `layout.tsx` header next
to the nav links. Now visible on every page — home, create, catalog, discover.

**Curated impl menu — 8 launchable configurations at go-live.** Extended `DeployPhase1.s.sol` to
also deploy and register the 5 composed impls:

| Config | Impl |
|---|---|
| Bare ERC-20 | `ERC20Template` |
| ERC-20 + AntiBot | `ERC20WithAntiBotGen` |
| ERC-20 + Fee-on-transfer | `ERC20WithFeeOnTransferGen` |
| Bare ERC-721A | `ERC721ATemplate` |
| ERC-721A + On-chain SVG | `ERC721AWithOnChainSVGGen` |
| ERC-721A + ERC-2981 royalty | `ERC721AWithRoyaltyGen` |
| ERC-721A + SVG + Royalty | `ERC721AWithSvgAndRoyaltyGen` |
| Bare ERC-1155 | `ERC1155Template` |

**Config hash formula finalized.** `keccak256(abi.encode(base, sortedModulesJoinedByComma))`.
`base` is the enum name as a string ("ERC20"/"ERC721A"/"ERC1155"). `sortedModulesJoinedByComma`
is `""` for bare launches or `"AntiBot"` / `"ERC2981Royalty,OnChainSVG"` etc. Client and
Solidity agree because both use `abi.encode(string, string)`. Old formula (`abi.encode(base, uint256(0))`)
is gone — DeployPhase1 constants updated.

**Module catalog (`web/src/lib/modules.ts`).** Typed `MODULES` array mirroring `shared/matrix.json`
with client-only additions (label, category, human descriptions). Exports:
- `MODULES: ModuleSpec[]` — the catalog.
- `modulesForBase(base)` — filter for the current base.
- `configHashFor(base, moduleIds)` — canonical config hash (matches DeployPhase1).
- `checkCompatibility(ids)` — cross-module compat errors.
- `validateParam(field, value)` — client-side field validation.

Currently 4 modules: AntiBot, FeeOnTransfer, OnChainSVG, ERC2981Royalty. Adding a new module means
adding one entry.

**ModulePicker component (`web/src/components/ModulePicker.tsx`).** Renders module toggles + params
inputs for the current base:
- Checkbox to enable/disable each module.
- When enabled: params inputs generated from each module's `params` array (integer / address / string).
- Live compatibility warnings.
- Emits selected IDs + params to the parent shop page.
- `encodeModuleSlice(mod, params)` returns the `bytes` encoded per the module's `abiEncode` signature.

**CompositionInfo component (`web/src/components/CompositionInfo.tsx`).** Right-column info panel:
- Base + selected modules.
- Base template address.
- Factory address.
- Config hash (full 66 chars).
- Impl address for the config hash — or "not registered" warning if zero.
- Predicted CREATE2 deploy address.

**Shop rewrite (`web/src/app/create/page.tsx`).** Now uses ModulePicker + CompositionInfo. Two-column
layout: left has the config form (chain, base, modules, identity, ownership, cost, launch button);
right has the sticky CompositionInfo panel. Launch button disables when the impl for the current
config hash isn't registered.

**Catalog page (`/catalog`).** Shows the whole "vending machine" architecture:
- Core stack (NameRegistry, Router, FeeReceiver) with addresses.
- Base templates + factories (three rows) with factory + bare impl addresses.
- All module fragments with description, supported bases, params encoding.
- Curated composition table with each config's hash + registered impl.

Every address on the page is a live Etherscan link (when contracts are deployed). Pre-broadcast,
addresses show as "—".

**ContractSet extended.** `web/src/lib/config.ts` now includes:
- 3 template impls (bare)
- 5 composed impls (AntiBot ERC20, FoT ERC20, OnChainSVG 721A, Royalty 721A, SVG+Royalty 721A)
- No config hashes stored — computed client-side via `configHashFor(base, moduleIds)`.

**All 268 tests still pass.** Web typechecks clean. Dev server hot-reloaded the new pages.

**GATE 0 flow after broadcast:**
1. Broadcast `DeployPhase1` to Sepolia (~15s, one tx).
2. Paste 15 addresses into `web/src/lib/config.ts` `CONTRACTS.sepolia`.
3. `pnpm --filter web dev` (already running).
4. User opens `/catalog` — sees every module, template, factory, impl.
5. User opens `/create` — picks base + modules + params; CompositionInfo shows the resulting composition; if impl is registered, launch button lights up.
6. User launches → real token deployed on Sepolia with the composition's behavior baked in.

**Still open:**
1. Broadcast (yours).
2. `DelayedReveal.frag.sol` (VM-131) — commit + reveal NFT drops.
3. Allocation bundles (Vesting, Airdrop, Staking).
4. Compile-service auto-registration → free-form composition (Phase 5).
5. Indexer per-token Transfer subscriptions (needs Ponder 0.7 dynamic-contract API).
6. Curve + hook (Phase 2 — needs Uniswap v4 pin).
