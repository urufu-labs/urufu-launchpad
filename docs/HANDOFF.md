# HANDOFF — for Claude Code

> This document tells Claude Code (or any next dev) everything they need to keep building VM. Read `PLAN.md` first for the "why" and "when." This document is the "how."

---

## Context you must have

**The developer:** Brandon (@brand). Prior work referenced during design and worth reading for style/pattern before writing new code:

- **Cops & Robbers** — PvP on-chain game on Base using B20's PolicyRegistry BLOCKLIST for jail mechanics. `Precinct.sol`, `LaunchCurve.sol`, `YieldDistributor.sol`, `HeistHook.sol`, `SPEC.md`, `HANDOFF.md`, `PUNCHLIST.md`. **The `LaunchCurve.sol` and `HeistHook.sol` are direct predecessors to VM's `Curve.sol` and `VendingMachineHook.sol` — read them first before writing the new versions.**
- **The Cartel** — Uniswap v4 hook with permanent LP lock, swap fee distribution, on-chain SVG NFT dossiers, probabilistic sieges. Rug-proof by hook design. **The LP-lock pattern in VendingMachineHook is directly from Cartel — don't reinvent it.**
- **Twine** — v4 hook turning AMM into spread-trading venue for correlated pairs (MSTRX/cbBTC). Full test suite pre-audit. Reference for hook testing patterns.
- **Basefields** — Stardew Valley-inspired game on Base with NFT plots, ERC-1155 crops, deflationary $FIELD. Reference for game token economies but NOT for VM architecture.
- **`airdrop-mint.mjs`** — ethers v6 + OpenZeppelin merkle-tree, funding + proof generation + concurrency + retries + dry-run. **This is the exact pattern for VM's `AirdropModule` — port it to Solidity + factory.**
- **Design skill library** — 16+ `.md` files (nasa, art-deco, art-nouveau, brutalist, kawaii-motion, russian-constructivism, retro-8bit-gaming, etc.). These are the frontend skills for v2. Not touched in v1.
- **`neochibi-studio` and `chibi-wolf-game`** at `C:/Users/brand/OneDrive/Desktop/`. Blender-MCP + Tripo AI pipeline for pixel chibi character generation. Used in v2 Neochibi factory only.

**Machine:** Windows PC (username `brand`, path `C:/Users/brand/`). Mac secondary. MCPs installed: Blender, Godot.

**Style calibration:** Brandon writes tight, opinionated SPECs. Uses `PUNCHLIST.md` for todos. No fluff. Prefers Foundry over Hardhat. TypeScript everywhere on the JS side. Solady when gas matters. Immutable contracts by default, timelocked governance if any admin is retained. Key separation (deploy key ≠ admin key ≠ upgrade key).

---

## Locked design decisions (do not revisit without asking)

See `PLAN.md` §1 for full table. The critical ones for coding:

1. **Template-injection compile** — NOT diamond pattern. Modules are audited .sol snippets, spliced into a base template at compile time, compiled with pinned Foundry. Bytecode is verifiable on Etherscan as a normal contract.
2. **VM deploys everything** — no user self-deploy. Router + Factories on-chain.
3. **Renounce is the default** — post-deploy prompt gives user renounce (default, pre-checked) / transfer to multisig / keep EOA. Show ownership audit before purchase (list every `onlyOwner` function).
4. **Onchain global name/ticker registry** on mainnet (later mirrored to Base).
5. **Ethereum mainnet first**, Base month 2–3. Do NOT scaffold Base in v1 — clean mainnet first.
6. **Full v4 hook v1** — LP-lock + fee redirect (platform/creator/holders) + cross-token loyalty + anti-vamping + optional toggles (dynamic fee, MEV protection, buyback-burn). All in `VendingMachineHook.sol`.
7. **Curve numbers:** 800M for sale / 200M reserved for graduated LP / ~10 ETH mainnet graduation threshold / 1% trade fee (0.7 platform / 0.3 creator) / first-3-blocks buy caps.
8. **Hook numbers:** 0.7% swap fee (0.2 platform / 0.3 creator / 0.2 holders). Loyalty tiers 1/5/10 tokens = 15/30/50% off platform share only. Anti-vamping 2× fee.

---

## Repo conventions

### Directory layout
See `README.md` §"Repository layout." Enforce it.

### Solidity style
- Solidity **0.8.26** (Cancun). Do not upgrade without discussion.
- Optimizer runs: 10_000 for factories/templates (deployed rarely, called often). 200 for clones themselves (deployed often, called often — smaller bytecode wins).
- `via_ir = true` for hook and curve (complex math benefits from IR).
- Use `Solady` for `Ownable`, `ReentrancyGuard`, `SafeTransferLib`, `FixedPointMathLib`, `LibClone` (CREATE2 clones for factory pattern).
- Use `OpenZeppelin 5.x` for `ERC20Votes`, `ERC721A` (Chiru Labs), `Governor` + `TimelockController`, `MerkleProof`.
- Use `Uniswap v4-core` and `v4-periphery` pinned to a specific commit hash. **Never** track `main`.
- Imports ordered: OZ, then Solady, then Uniswap, then local. Blank line between groups.
- Every external/public function: NatSpec `@notice`, `@param`, `@return`. `@dev` for non-obvious logic.
- Custom errors, never revert strings. Named `ContractName__ErrorName(...)`.
- Events named `PastTenseVerb(...)`. All state changes emit.

### Test style
- `forge-std/Test.sol` base.
- Tests named `test_ContractName_Behavior_Condition()`.
- Fuzz tests: `testFuzz_...`. Set `runs = 10_000` in `foundry.toml` for CI, `1_000` locally.
- Invariants: separate file per contract, `invariant_...`. Handler pattern for actor bounding.
- Coverage target: **>95%** on any contract holding funds or determining fees.
- Fork tests against mainnet for hook + v4 pool creation. Pin block number.

### TypeScript style
- Node 20+, ESM only.
- Type imports use `import type`.
- No `any` — use `unknown` + narrowing.
- Zod for all API boundaries (compile-service inputs, indexer configs).
- Effect or neverthrow for error handling in compile-service (recommended, not required — pick one and stick).
- Viem, not ethers. (Sorry `airdrop-mint.mjs` — port it.)

### Frontend style
- App Router only. No Pages Router.
- Server Components by default. `"use client"` only where needed.
- shadcn/ui components — install per-component with `npx shadcn add`, do not paste.
- Tailwind — utility classes, no custom CSS files except `globals.css`.
- Wagmi hooks for reads, `useWriteContract` + `useSimulateContract` for writes.
- All config lives in `web/lib/config.ts`. No magic numbers scattered.

### Git style
- Branches: `feat/`, `fix/`, `chore/`, `docs/`, `spec/`.
- Commits: conventional commits (`feat(hook): add loyalty tier lookup`).
- PRs: reference the punchlist item ID (`Closes VM-123`).
- Never commit to `main`. Every change through PR, even solo. Self-review before merge.

---

## Current state

**As of handoff:** nothing has been coded. `PLAN.md`, `README.md`, `HANDOFF.md`, `TODO.md` exist. The repo has not yet been scaffolded.

**Immediate next action:** execute TODO.md Phase 0 items in order. First real work is `NameRegistry.sol`.

---

## Sequence for the next 10 sessions

1. **Repo scaffold** — monorepo with pnpm workspaces, Foundry init in `contracts/`, Next.js 15 in `web/`, TypeScript boilerplate in `compile-service/`. Copy `.gitignore`, `.editorconfig`, root `README.md`. Add `docs/` folder with all four docs.
2. **`NameRegistry.sol`** — read spec below. Write contract, write tests, deploy to Sepolia.
3. **`ERC20Template.sol`** — bare ERC-20 base. No modules yet, but written with **module hooks** (`_beforeTokenTransfer`, `_afterTokenTransfer`, virtual overridable initialization). Copy pattern from Cops & Robbers `LaunchCurve.sol`.
4. **First module: `FeeOnTransferModule.sol`** — audited standalone, ready to be spliced into ERC20Template. Must compile clean when injected.
5. **Compile service — MVP** — Node HTTP server, single endpoint `POST /compile { base, modules, params }` → returns bytecode + ABI + test results. Uses child_process to invoke `forge build` and `forge test`. Cache in-memory by config hash. Postgres later.
6. **`Router.sol` + `ERC20Factory.sol`** — user-facing entry. Router receives launch fee, calls factory, factory clones the template, initializes with user params.
7. **Shop UI scaffold** — chain picker (Ethereum only for now), base picker (ERC-20 only for now), module toggles (fee-on-transfer only for now), name/ticker input with registry check, live compile status indicator.
8. **End-to-end test** — friend on Sepolia can go through the flow: pick ERC-20 + fee-on-transfer, enter "Test Token" TEST, pay 0.005 ETH, get a deployed contract at a URL.
9. **Second module: `AntiBotModule.sol`** — proves the composition system works with multiple modules.
10. **Token page v1** — display token info, holders, transfers. No trading widget yet (curve doesn't exist yet).

Each step is 3–8 hours of solo work. After step 10, you're roughly at end of Phase 1 in `PLAN.md`.

---

## Contract specs (write these as you build — SPEC-* files)

For each contract, before writing Solidity, write a `docs/SPEC-<name>.md` with:

- **Purpose:** one paragraph.
- **State:** every variable, why it exists, when it's set.
- **Functions:** every external/public function, params, returns, invariants held.
- **Events:** every event, when emitted.
- **Access control:** who can call what, why.
- **Reentrancy:** what's guarded and why.
- **Invariants:** the properties that must always hold (for invariant testing).
- **Attack surface:** things to worry about, mitigations.
- **Deploy:** constructor args, post-deploy steps.

Reference: `Precinct.sol`'s SPEC.md is the model. Aim for that density.

### Priority order for SPECs

1. `SPEC-registry.md` (before writing `NameRegistry.sol`)
2. `SPEC-router.md` (before writing `Router.sol`)
3. `SPEC-templates.md` (before writing `ERC20Template.sol`)
4. `SPEC-modules.md` (module interface + first two module specs)
5. `SPEC-factories.md`
6. `SPEC-compile-service.md` (backend design)
7. `SPEC-curve.md` — Phase 2
8. `SPEC-hook.md` — Phase 2 minimal, Phase 3 full
9. `SPEC-loyalty.md` — Phase 3

---

## Module composition mechanism (the trickiest thing to get right)

**Options considered:**
- **Diamond (EIP-2535):** flexible but bytecode-heavy, hard to verify on Etherscan, gas-costly per call. ❌
- **Manual inheritance chain:** requires N! contracts for N modules. ❌
- **Template + module code splicing at compile time:** ✅ chosen. Cheap deploys, normal Etherscan verification, per-module audits map cleanly.

**How it works:**

1. Each module is written as a **Solidity fragment** — a file containing state variables, constants, functions, events, errors, and hook implementations. Not a compilable contract on its own; it's a template snippet.

2. The base template (e.g. `ERC20Template.sol`) contains **injection markers**:

```solidity
// ============================================================
// VM_INJECT_STATE
// ============================================================
// Modules add state variables here.

// ============================================================
// VM_INJECT_INIT
// ============================================================
// Modules add initialization logic here (called from initialize()).

// ============================================================
// VM_INJECT_BEFORE_TRANSFER
// ============================================================
// Modules add pre-transfer checks/state changes here.

// ============================================================
// VM_INJECT_AFTER_TRANSFER
// ============================================================
// Modules add post-transfer logic here.

// ============================================================
// VM_INJECT_EXTERNAL
// ============================================================
// Modules add new external functions here.
```

3. **Compile service** reads user config → picks modules → for each module, reads its `.frag.sol` → splices fragments into the correct markers → produces a single valid `.sol` file → compiles with pinned Foundry → runs merged test suite (each module ships with its own test fragment, merged similarly) → returns bytecode.

4. **Compatibility matrix** (`shared/matrix.json`) declares which modules can coexist. Frontend reads it live for greying-out incompatible options. Backend enforces on compile.

5. **Each module is independently audited.** Composition is safe by construction because the base template's storage layout is fixed and modules only add new storage slots at the end (Solidity storage layout rules make this safe as long as base storage is not modified).

**Reference implementation:** The pattern is a simplified version of the "compile-time contract composition" used by early Aave v2 modules and Balancer pool factories. Do NOT try to use runtime delegatecall composition — it's a security nightmare and defeats the "each deploy is a normal contract" property.

**First proof of concept:** get `ERC20Template.sol` + `FeeOnTransferModule.sol` compiling as a single spliced contract, and verify on Etherscan Sepolia. Once this works end-to-end, the whole system's foundation is proven.

---

## Testing philosophy

- **Every module has a fragment of tests** in `contracts/test/modules/<name>.frag.t.sol`.
- **Compile service merges test fragments** when building a combo, so `forge test` runs the exact test suite matching the composition.
- **Invariant tests** live on the base template — they must hold for *any* module composition (e.g. total supply conservation, no self-referential transfers).
- **Fork tests** for anything touching v4: pin mainnet block, use real Uniswap v4 PoolManager.
- **Fuzz all fee splits.** Rounding errors in fee accounting are a top-5 audit finding. Prove fee splits sum to 100% for all inputs, no wei lost, no wei duplicated.
- **Gas snapshots** with `forge snapshot`. Track them in-repo. Alert if any function grows >5%.

---

## What Claude Code specifically should do

1. **Read all four docs (`PLAN.md`, `README.md`, `HANDOFF.md`, `TODO.md`) before touching code.**
2. **When given an ambiguous task, write the SPEC first.** Do not code without the spec agreed.
3. **When implementing a contract, write the tests first.** TDD is not optional on money contracts.
4. **When adding a module, update `shared/matrix.json`** with its compatibility rules.
5. **When updating a design decision, add an ADR in `docs/decisions/`** — `ADR-NNN-short-title.md`, dated, one-page.
6. **Do not add features not in `PLAN.md`.** If a feature seems clearly needed, propose it as an ADR first.
7. **Always run `forge test`, `forge fmt --check`, `pnpm typecheck`, `pnpm lint` before proposing a commit.**
8. **Reference prior Brandon work when relevant.** "This follows the `LaunchCurve.sol` pattern from Cops & Robbers" is a legitimate comment.
9. **Never touch admin keys / deploy keys / addresses.** Ask before every mainnet-affecting action, even in staging.
10. **When you finish a phase, update `TODO.md` and write a two-paragraph status note in `docs/decisions/log.md`.**

---

## Contact + escalation

- **Anything ambiguous:** ask Brandon before proceeding. Bad guesses on money contracts are expensive.
- **Anything security-adjacent:** flag it, don't fix it silently. Security decisions need explicit approval.
- **External audit findings:** track in `docs/audits/`, address in a dedicated branch, require Brandon's sign-off on remediation.

---

## Appendix: prior-art file paths (Windows)

- `C:/Users/brand/OneDrive/Desktop/cops-and-robbers/` — Precinct, LaunchCurve, HeistHook, YieldDistributor
- `C:/Users/brand/OneDrive/Desktop/the-cartel/` — permanent LP lock hook, on-chain SVG dossiers
- `C:/Users/brand/OneDrive/Desktop/twine/` — spread-trading v4 hook, test suite reference
- `C:/Users/brand/OneDrive/Desktop/basefields/` — game economy reference (not architecture)
- `C:/Users/brand/OneDrive/Desktop/neochibi-studio/` — Blender-MCP pipeline (v2 only)
- `C:/Users/brand/OneDrive/Desktop/chibi-wolf-game/` — Tripo AI + Phaser 3 pipeline (v2 only)
- `airdrop-mint.mjs` (across various projects) — merkle airdrop reference

Read these before implementing similar patterns. Do not copy-paste — port with proper naming and updated conventions.
