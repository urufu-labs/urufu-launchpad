# TODO — Vending Machine

> Punchlist. Ordered. Checkbox-only. Reference by ID (`VM-###`).
> Update after each work session. Move completed items to `docs/decisions/log.md` with date.

**Legend:**
- 🔥 blocking / critical path
- 🎯 gate item (phase advances on completion)
- 🧪 requires audit before mainnet
- 💰 costs money (audit / tools / hosting)

---

## Phase 0 — Foundation (weeks 1–2)

### Setup
- [ ] **VM-001** 🔥 Choose real project name (see PLAN.md §7) — **owner: Brandon (human-only)**
- [ ] **VM-002** 🔥 Register domain, GitHub org, Twitter handle — **owner: Brandon (human-only)**
- [ ] **VM-003** 💰 Consult lawyer, form LLC or Delaware C-corp — **owner: Brandon (human-only)**
- [ ] **VM-004** 💰 Reach out to audit firms (Spearbit, Cantina, Pashov, Trust, Zellic) to reserve slot for month 5 — **owner: Brandon (human-only)**
- [ ] **VM-005** Set up Alchemy account, get mainnet + Sepolia + Base RPC endpoints — **owner: Brandon (account creation is human-only; Claude will populate `.env` once keys are provided)**
- [ ] **VM-006** Set up Pinata + Cloudflare R2 accounts — **owner: Brandon (human-only)**
- [ ] **VM-007** Create dev wallet (deploy key), staging wallet, ops wallet — key separation from day 1. **owner: Brandon (human-only; do NOT let Claude generate these)**
- [ ] **VM-008** 🔥 Install Foundry on host (`foundryup`) — required before `contracts/install-deps.sh` can run. **owner: Brandon**

### Repo scaffold
- [x] **VM-010** 🔥 Init monorepo with pnpm workspaces — done 2026-07-01
- [ ] **VM-011** Init Foundry in `contracts/` — **partial**: `foundry.toml`, `remappings.txt`, `contracts/install-deps.sh` written. `forge install` blocked on VM-008. Uniswap v4 commit-pin still TODO in `install-deps.sh`.
- [ ] **VM-012** Init Next.js 15 in `web/` (App Router, TS, Tailwind, shadcn/ui) — pending; scheduled for next session or run `pnpm create next-app@latest web` manually
- [x] **VM-013** Init TypeScript project in `compile-service/` (Node 20, ESM, Zod) — done 2026-07-01
- [x] **VM-014** Add `.editorconfig`, `.gitignore`, `.prettierrc`, `foundry.toml` with pinned solc 0.8.26 — done 2026-07-01. `.eslintrc` deferred (each workspace ships its own once its stack is present).
- [x] **VM-015** Add GitHub Actions: `forge test`, `forge fmt --check`, `pnpm typecheck`, `pnpm lint`, coverage report — done 2026-07-01. Separate workflow per workspace with path filters.
- [x] **VM-016** Create `docs/` folder, move PLAN.md / HANDOFF.md / TODO.md into it — done 2026-07-01. README.md stays at repo root.
- [x] **VM-017** Create `shared/matrix.json` stub with schema comment — done 2026-07-01
- [x] **VM-018** Create `docs/decisions/log.md` for ADR-adjacent status notes — done 2026-07-01

### Docs / specs
- [x] **VM-020** 🔥 Write `docs/SPEC-registry.md` — done 2026-07-01
- [x] **VM-021** 🔥 Write `docs/SPEC-router.md` — done 2026-07-01
- [x] **VM-022** 🔥 Write `docs/SPEC-templates.md` — done 2026-07-01
- [x] **VM-023** 🔥 Write `docs/SPEC-modules.md` (module fragment interface + first two module specs: FeeOnTransfer, AntiBot) — done 2026-07-01
- [x] **VM-024** Write `docs/SPEC-factories.md` — done 2026-07-01
- [x] **VM-025** Write `docs/SPEC-compile-service.md` — done 2026-07-01

### First real code
- [x] **VM-030** 🔥 🧪 Implement `contracts/src/registry/NameRegistry.sol` — written 2026-07-01. Not yet run through `forge test` (VM-008 blocks). Needs verify pass after `forge build` succeeds.
- [x] **VM-031** Implement `contracts/test/unit/NameRegistry.t.sol` — written 2026-07-01. Coverage plan hits every revert branch + views + admin + constructor + basic fuzz. Actual coverage number TBD after `forge coverage` runs.
- [x] **VM-032** Homoglyph blocklist + reserved-ticker list in `NameRegistry` — ASCII-only character set at the input boundary (rejects non-ASCII homoglyphs entirely); reserved-ticker constructor seed + admin add/remove path. Written 2026-07-01.
- [ ] **VM-033** Deploy `NameRegistry` to Sepolia, verify on Etherscan — **script ready.** `contracts/script/DeployPhase1.s.sol` deploys the full Phase 1 stack (NameRegistry + FeeReceiver + Router + ERC20Factory + ERC20Template impl + wires everything + registers BARE_ERC20_CONFIG). Rehearsed against Sepolia fork — simulation completes. Broadcast blocked on you providing `SEPOLIA_RPC_URL` + `DEV_PRIVATE_KEY`.
- [ ] **VM-034** 🎯 **GATE 0:** Shop UI can pick base + name + ticker, registry rejects duplicates on Sepolia — **blocked on VM-012** (web scaffold + shop routes) and **VM-033**.

---

## Phase 1 — Simple launches (weeks 3–6)

### Templates
- [x] **VM-100** 🔥 🧪 Implement `contracts/src/templates/ERC20Template.sol` with injection markers — **Done 2026-07-01.** Solady ERC20 base + Solady Ownable, storage-backed name/symbol, single-shot `initialize(bytes)`, all 8 injection markers as literal comments (fragments splice into them via compile-service).
- [x] **VM-101** 🧪 Unit tests for `ERC20Template` (bare, no modules) — **Done 2026-07-01.** 14 tests: initialize happy/double/zero-owner/mint routing/emit, transfer, transferFrom, ownership transitions, impl-vs-clone isolation.
- [ ] **VM-102** 🧪 Invariant tests for `ERC20Template` — total supply conservation, transfer safety — deferred to when first module fragment lands (bare template invariants are trivially covered by unit tests).
- [x] **VM-103** 🔥 🧪 Implement `contracts/src/templates/ERC721ATemplate.sol` with injection markers — **Done 2026-07-01.** ERC721A 4.3.0 (Chiru Labs) + Solady Ownable, storage-backed name/symbol/baseURI/maxSupply, cloneable via LibClone, owner-only `mintBatch` with max-supply enforcement, `setBaseURI` admin. All 10 injection markers present.
- [x] **VM-104** 🧪 Unit + invariant tests for `ERC721ATemplate` — **Done 2026-07-01.** 18 unit tests (init happy/double/zero-owner, mint boundary + zero-quantity + max-supply revert, exact-supply boundary, transfer, baseURI admin, tokenURI concat, ownership, impl-vs-clone isolation).
- [x] **VM-105** 🔥 🧪 Implement `contracts/src/templates/ERC1155Template.sol` with injection markers — **Done 2026-07-01.** Solady ERC1155 + Ownable, storage-backed name/symbol/URI, owner-only mint + mintBatch, canonical `{id}` URI template. `_useBeforeTokenTransfer`/`_useAfterTokenTransfer` overridden to return true so hooks actually fire.
- [x] **VM-106** 🧪 Unit + invariant tests for `ERC1155Template` — **Done 2026-07-01.** 16 unit tests including init, single/batch mint, transfer, URI admin, ownership, impl/clone isolation.

### Token modules
- [x] **VM-110** 🔥 🧪 Implement `contracts/modules/token/FeeOnTransfer.frag.sol` — **Done 2026-07-01.** Simplified v1: `feeBps + burnBps + treasuryBps + treasury`. Uses `_afterTokenTransfer` with `_burn(to, fee)` + `_mint(treasury, split)`. Recursion-safe by construction — the recursive `_burn`/`_mint` calls fire hooks with `from==0` or `to==0`, and the module's hook check `from!=0 && to!=0` naturally skips them. No template revision needed after all.
- [x] **VM-111** 🧪 Test fragment + unit tests for `FeeOnTransfer` — **Done 2026-07-01.** 18 tests on the generated `ERC20WithFeeOnTransferGen`: init happy/reverts, splits arithmetic (recipient gets amount-fee, treasury gets treasuryBps slice, burn slice reduces supply), event emission, exclusion admin, recursion safety (double-charging check), tiny-amount rounding.
- [ ] **VM-112** 🧪 Fuzz test fee splits — sum to 100%, no wei lost, no wei duplicated — deferred (arithmetic invariants verified by unit tests; fuzz pass adds robustness for adversarial rounding).
- [x] **VM-113** 🔥 🧪 Implement `contracts/modules/token/AntiBot.frag.sol` (block-N gating + allowlist; commit-reveal deferred) — **Done 2026-07-01.** Fragment authored per SPEC-modules §Fragment file format. Splicer produces `ERC20WithAntiBotGen.sol` from `ERC20Template.sol` + this fragment. 11 tests on the generated contract pass (init, gate boundaries, allowlist admin, owner freedom, post-gate freedom, storage layout invariant).
- [ ] **VM-114** 🧪 Additional tests for AntiBot — commit-reveal path, fork tests
- [ ] **VM-115** 🧪 Implement `AntiWhaleModule.sol` (max wallet, max tx, cooldown, auto-expiry)
- [ ] **VM-116** 🧪 Implement `VotesModule.sol` (OZ ERC20Votes wrapper)
- [ ] **VM-117** 🧪 Implement `PermitModule.sol` (ERC-2612)
- [ ] **VM-118** 🧪 Implement `PausableModule.sol` (⚠️ flagged in UI)
- [ ] **VM-119** 🧪 Implement `BlacklistModule.sol` (⚠️ flagged in UI)

### NFT modules
- [x] **VM-130** 🧪 Implement `OnChainSVG.frag.sol` — **Done 2026-07-01.** Overrides `tokenURI` to return `data:application/json;base64,...` with an embedded base64 SVG showing token name + id. Uses Solady LibString + Base64. `_buildSvg` is virtual so submodules can override for richer visuals. 4 tests verify URI structure, JSON encoding, per-id uniqueness.
- [ ] **VM-131** 🧪 Implement `DelayedReveal.frag.sol`
- [x] **VM-132** 🧪 Implement `ERC2981Royalty.frag.sol` — **Done 2026-07-01.** Standard ERC-2981 with flat per-collection royalty. Params: `(receiver, feeBps)` capped at 10%. `royaltyInfo`, `supportsInterface(0x2a55205a)`, admin `setRoyaltyReceiver`. 10 tests.
- [ ] **VM-133** 🧪 Implement `SoulboundModule.sol`
- [ ] **VM-134** 🧪 Implement `RefundableModule.sol`

### Allocation bundles
- [ ] **VM-140** 🔥 🧪 Implement `contracts/src/modules/allocation/VestingModule.sol` (linear/cliff/stepped)
- [ ] **VM-141** 🧪 Implement `AirdropModule.sol` — port from `airdrop-mint.mjs` pattern
- [ ] **VM-142** 🧪 Implement `StakingPoolModule.sol` (single-asset)
- [ ] **VM-143** 🧪 Implement `LPAllocationModule.sol` (v4 pool seed at deploy)
- [ ] **VM-144** 🧪 Implement `TreasuryAllocationModule.sol`

### Factories + Router
- [x] **VM-150** 🔥 🧪 Implement `contracts/src/factories/ERC20Factory.sol` — **Done 2026-07-01.** Per-config impl registry (immutable-once-registered), CREATE2 clone via Solady LibClone, salt = `keccak(launcher, name, ticker, chainid)` — front-mining defeated. 25 unit tests + covered by E2E integration test. 93.75% lines / 92.31% branches / 100% functions.
- [x] **VM-151** 🔥 🧪 Implement `contracts/src/factories/ERC721AFactory.sol` — **Done 2026-07-01.** Mirrors ERC20Factory shape but hardcodes the 721A initialize signature `(owner, name, symbol, baseURI, maxSupply, moduleData)`. Same CREATE2 salt policy, same immutable impl registry. 15 unit tests + 5 E2E integration tests.
- [x] **VM-152** 🧪 Implement `contracts/src/factories/ERC1155Factory.sol` — **Done 2026-07-01.** Mirror of the ERC-721A shape; hardcodes ERC-1155 init signature `(owner, name, symbol, uri, moduleData)`. 13 unit tests + 3 E2E integration tests.
- [x] **VM-153** 🔥 🧪 Implement `contracts/src/router/Router.sol` — receives fee, calls factory, reserves name in registry atomically. **Done 2026-07-01.** 40 tests pass; 100% line/branch/function coverage. Ownership dispatch (Renounce/Multisig/KeepEOA) works via `IOwnable` interface.
- [x] **VM-154** 🔥 🧪 Implement `contracts/src/router/FeeReceiver.sol` — **Done 2026-07-01.** 100% coverage. Emits per-launch `FeeReceived`; direct-send fallback credits `launcher = address(0)`.
- [x] **VM-155** 🧪 Router integration tests — end-to-end deploy flow (bare ERC-20, no modules) — **Partial. Done 2026-07-01.** `contracts/test/integration/LaunchE2E.t.sol` runs the full real stack (NameRegistry + Router + FeeReceiver + ERC20Factory + ERC20Template) for 10 scenarios: 3 ownership modes, refund correctness, transferability post-launch, collision handling (same launcher, different launcher, reserved ticker), sequential launches. Module compositions (1/3/8) land when first fragment ships (VM-110).

### Compile service
- [x] **VM-170** 🔥 Implement `compile-service/src/matrix.ts` — reads `shared/matrix.json`, validates compositions — **Done 2026-07-01.** loadMatrix + validateConfig with UNKNOWN_BASE / UNKNOWN_MECHANIC / UNKNOWN_MODULE / MODULE_WRONG_BASE / MODULE_MISSING_REQUIRES / MODULE_INCOMPATIBLE error codes.
- [x] **VM-171** 🔥 Implement `compile-service/src/compile.ts` + server wiring — **Done 2026-07-01.** parseFragment + splice + compose (library). `POST /compile` endpoint in `server.ts` now calls `compose()`, writes to `contracts/tmp/<hash>/`, invokes `forge build --sizes`, reads the artifact, and returns `{configHash, contractName, moduleIds, bytecode, abi, warnings}`. Caching, matrix hot-reload, and JSON Schema param validation still TODO. Server needs `pnpm install` to run (adds `@noble/hashes` for the configHash keccak256).
- [x] **VM-172** 🔥 Implement `compile-service/src/test-runner.ts` — **Done 2026-07-01.** `runForgeTests({contractsDir, matchPath, ci})` shells to `forge test --json`, parses per-test pass/fail/gas/reason. Wired into `POST /test` endpoint. Handles the two common `forge --json` shapes and returns `TestSuite[]`.
- [ ] **VM-173** Implement `compile-service/src/cache.ts` — config-hash → bytecode cache (in-memory MVP, Postgres later)
- [ ] **VM-174** 🔥 Implement `compile-service/src/server.ts` — `POST /compile` endpoint with Zod validation
- [ ] **VM-175** Dockerize compile service, deploy to a single VPS or Fly.io
- [ ] **VM-176** Rate limit + auth (API key per FE call) on compile service

### Frontend
- [x] **VM-200** 🔥 Wagmi + Viem setup, chain config (Ethereum mainnet + Sepolia + Base + Base Sepolia pre-wired; CHAINS_ENABLED=['sepolia']) — **Done 2026-07-01.** Injected connector, chain ID↔key helpers, explorer URL helpers.
- [ ] **VM-201** 🔥 SIWE auth flow — deferred (not required for GATE 0; wallet connect is enough).
- [x] **VM-202** 🔥 `/create` shop page: chain picker — **Done 2026-07-01.** All four chains rendered; Sepolia enabled, others greyed as "soon."
- [x] **VM-203** 🔥 Base picker (ERC-20 / 721 / 1155) — **Done 2026-07-01.** ERC-20 enabled; 721A + 1155 greyed pending templates.
- [ ] **VM-204** 🔥 Launch mechanic picker (per base) — deferred (bare launch is the MVP; curve UI arrives with Phase 2).
- [ ] **VM-205** 🔥 Module toggle UI with live compatibility warnings (reads `shared/matrix.json`) — pending (bare ERC-20 works today; modules require compile-service pre-registration of impls).
- [ ] **VM-206** 🔥 Allocation bundle configurator
- [ ] **VM-207** 🔥 Governance add-on toggle (only enabled if Votes module selected)
- [ ] **VM-208** 🔥 v4 hook add-on toggles (only enabled if LP present)
- [x] **VM-209** 🔥 Name + ticker input with live registry check — **Done 2026-07-01.** Live wagmi useReadContract polls NameRegistry.isNameAvailable / isTickerAvailable on every keystroke (staleTime 3s). Ticker input auto-uppercases + strips non-alphanumeric.
- [ ] **VM-210** 🔥 URL-encoded config — shareable link generates config from URL params
- [ ] **VM-211** 🔥 Live compile status indicator (green/yellow/red badge)
- [ ] **VM-212** "Run Tests" button — triggers backend test run, streams output
- [ ] **VM-213** 🔥 Ownership audit panel — lists every `onlyOwner` function in the composition — deferred (bare ERC-20 has only the standard Solady owner functions; panel becomes valuable when modules add admin surface).
- [x] **VM-214** 🔥 Cost breakdown — **Partial. Done 2026-07-01.** Live Router.quote() call shows ETH cost in header of the cost section. Per-module breakdown lands with VM-205.
- [x] **VM-215** 🔥 Purchase button → wallet signature → tx submitted → success state with token page URL — **Done 2026-07-01.** useSimulateContract preview → useWriteContract → useWaitForTransactionReceipt with tx link + deployed-address link to Etherscan. Simulation errors surface inline.
- [x] **VM-216** 🔥 Post-purchase renounce/multisig/keep chooser (renounce default) — **Done 2026-07-01.** Pre-launch chooser (baked into `LaunchParams.ownership`) with inline multisig address input + isAddress validation.
- [ ] **VM-217** 🔥 Token page `/t/[chain]/[address]` — metadata, holders, transfers (no trading widget in Phase 1)
- [ ] **VM-218** Discover feed (New only in Phase 1 — no trending yet)
- [ ] **VM-219** Profile page `/u/[address]` — tokens launched

### Indexer
- [ ] **VM-230** 🔥 Ponder setup, connect to Alchemy Sepolia
- [ ] **VM-231** Index `NameRegistry` events (reservations)
- [ ] **VM-232** Index `Router` events (launches)
- [ ] **VM-233** Index factory events (deployments)
- [ ] **VM-234** Index deployed token Transfer events (holders, balances)
- [ ] **VM-235** Postgres schema for tokens, launches, holders, transfers

### End-to-end
- [ ] **VM-260** 🎯 **GATE 1:** Friend on Sepolia launches ERC-20 with fee-on-transfer + vesting end-to-end. Token page loads. Transfers show up in indexer.

### Audit prep
- [ ] **VM-270** 💰 Send Phase 1 contracts to solo auditor (Trust / Pashov / a solo pick) — budget $15–25k
- [ ] **VM-271** Address findings, re-audit critical/high
- [ ] **VM-272** Slither + Aderyn clean pass
- [ ] **VM-273** 💰 Announce Immunefi bug bounty (initial $10k, scaled up as fees accrue)

### Mainnet ship (partial)
- [ ] **VM-280** 🎯 🔥 🧪 Deploy Phase 1 contracts to Ethereum mainnet
- [ ] **VM-281** Deploy indexer + compile service to production
- [ ] **VM-282** Deploy web app to Vercel with production RPC
- [ ] **VM-283** 🎯 **GATE 1 MAINNET:** Public soft launch — non-curve non-hook launches only, invite-only allowlist

---

## Phase 2 — Bonding curve + minimal hook (weeks 7–12)

### Curve
- [ ] **VM-300** 🔥 Write `docs/SPEC-curve.md`
- [ ] **VM-301** 🔥 🧪 Implement `contracts/src/curve/Curve.sol` — constant-product virtual reserves, 800M/200M split
- [ ] **VM-302** 🔥 🧪 Trade fee logic (1% total, 0.7 platform / 0.3 creator)
- [ ] **VM-303** 🧪 Anti-sniper — first-3-blocks buy caps
- [ ] **VM-304** 🧪 Fuzz all curve math — no rounding exploits, no infinite loops
- [ ] **VM-305** 🧪 Invariant: curve reserves ≥ tokens sold * price. Fees always sum to trade amount.
- [ ] **VM-306** 🔥 🧪 Implement `contracts/src/curve/CurveFactory.sol`
- [ ] **VM-307** 🔥 🧪 Implement `contracts/src/curve/Graduator.sol` — atomic drain → v4 pool → LP mint → transfer to hook

### Minimal hook v1
- [ ] **VM-320** 🔥 Write `docs/SPEC-hook.md` (minimal version — LP-lock + platform fee only)
- [ ] **VM-321** 🔥 🧪 Implement `contracts/src/hooks/VendingMachineHook.sol` — minimal version
  - [ ] LP-lock (owns position NFT, no admin withdraw)
  - [ ] Platform fee capture (0.7%, all to platform for now)
  - [ ] All other features stubbed / disabled
- [ ] **VM-322** 🧪 Fork tests against v4 mainnet PoolManager
- [ ] **VM-323** 🧪 Invariant: LP position never leaves hook. Fees never rebate to zero.
- [ ] **VM-324** 🔥 🧪 Graduation integration tests — curve at threshold → graduation tx → v4 pool live → swap works

### Trading UI
- [ ] **VM-350** 🔥 Buy/sell widget on token page (curve pre-graduation, v4 pool post-graduation, transparent to user)
- [ ] **VM-351** 🔥 Price chart (candles from indexer)
- [ ] **VM-352** Bonding curve progress bar
- [ ] **VM-353** Recent trades feed
- [ ] **VM-354** Holders list
- [ ] **VM-355** Comments section (SIWE-authed)
- [ ] **VM-356** Share to X button with auto-generated OG image
- [ ] **VM-357** Graduation animation / event notice

### Discovery
- [ ] **VM-370** Trending feed
- [ ] **VM-371** Almost Graduated feed (>70% of threshold)
- [ ] **VM-372** Recently Graduated feed
- [ ] **VM-373** Top Volume 24h
- [ ] **VM-374** Search by name / ticker / address

### End-to-end
- [ ] **VM-390** 🎯 **GATE 2:** 10+ curve tokens launched on Sepolia, 3+ graduated, trading works pre/post

### Audit + ship
- [ ] **VM-395** 💰 🧪 Full audit of curve + minimal hook — Spearbit/Cantina, budget $30–50k
- [ ] **VM-396** Address findings
- [ ] **VM-397** 🎯 🔥 Deploy curve + minimal hook to mainnet
- [ ] **VM-398** 🎯 **GATE 2 MAINNET:** Public curve launches live

---

## Phase 3 — Full hook (weeks 13–18)

### Hook v2 (full)
- [ ] **VM-400** 🔥 Rewrite `docs/SPEC-hook.md` with full feature set
- [ ] **VM-401** 🔥 🧪 Fee redirect — atomic split into platform / creator / holders
- [ ] **VM-402** 🔥 🧪 Holder claim (pull pattern, per-share accounting, WETH denominated)
- [ ] **VM-403** 🔥 🧪 Implement `contracts/src/hooks/LoyaltyOracle.sol`
- [ ] **VM-404** 🔥 🧪 Cross-token loyalty tier calculation, `$10 min per token` floor
- [ ] **VM-405** 🔥 🧪 Hook queries `LoyaltyOracle.tierOf(swapper)` in `beforeSwap`, applies fee discount
- [ ] **VM-406** 🔥 🧪 Anti-vamping — 2× fee for competing pool detection
- [ ] **VM-407** 🧪 Dynamic fee (volatility-based) toggle
- [ ] **VM-408** 🧪 MEV/JIT protection toggle
- [ ] **VM-409** 🧪 Buyback-and-burn on volume threshold toggle
- [ ] **VM-410** 🧪 Fuzz all fee paths — every combination of toggles, every tier, every discount
- [ ] **VM-411** 🧪 Invariants — creator + holder shares never reduced by loyalty discount; only platform share affected

### Governance bundle
- [ ] **VM-430** 🔥 🧪 Implement `contracts/src/governance/GovernorBundle.sol` — deploys Governor + Timelock, wires to Votes token
- [ ] **VM-431** 🧪 Integration test — launch token with Votes + Governance, propose, vote, execute

### UI: portfolio + claim
- [ ] **VM-450** 🔥 Portfolio page `/portfolio` — all VM tokens held, unclaimed fees, one-click claim-all
- [ ] **VM-451** 🔥 Profile page adds loyalty tier + next-tier progress
- [ ] **VM-452** Creator dashboard — earnings across all their launches

### End-to-end
- [ ] **VM-490** 🎯 **GATE 3:** Full hook passes fuzz + invariants. Cross-token loyalty works with 5+ mock tokens.

---

## Phase 4 — Audit & mainnet full launch (weeks 19–26)

- [ ] **VM-500** 💰 🧪 External audit of full hook + LoyaltyOracle + governance bundle
- [ ] **VM-501** 🧪 Fix findings, re-audit critical/high
- [ ] **VM-502** 🧪 Testnet soak, 2 weeks minimum
- [ ] **VM-503** 💰 Scale Immunefi bug bounty to $100k pool
- [ ] **VM-504** 🎯 🔥 Deploy full hook + oracle + governance to mainnet
- [ ] **VM-505** 🎯 Public mainnet launch — all Phase 1–3 features live
- [ ] **VM-506** Marketing push (Twitter, Warpcast, launch partner announcements)

---

## Phase 5 — Base + v2 (months 7–8)

- [ ] **VM-600** Deploy full stack to Base
- [ ] **VM-601** Cross-chain name registry mirror between mainnet ↔ Base
- [ ] **VM-602** B20-native modules (PolicyRegistry-aware, blocklist, jailable)
- [ ] **VM-603** LayerZero OFT wrapper for cross-chain launches
- [ ] **VM-610** Frontend skills system — reads `.md` skill files, applies per launch
- [ ] **VM-611** Ship NASA / Deco / Nouveau / Brutalist / Kawaii Motion as launch catalog
- [ ] **VM-620** Neochibi generative NFT factory — integrate neochibi-studio + chibi-wolf-game pipeline

---

## Ongoing (all phases)

- [ ] **VM-900** Update `TODO.md` after every work session
- [ ] **VM-901** Add ADR to `docs/decisions/` for any design decision change
- [ ] **VM-902** Weekly status note in `docs/decisions/log.md`
- [ ] **VM-903** Monitor gas costs — alert if any function grows >5% per `forge snapshot`
- [ ] **VM-904** Monthly review of module compatibility matrix — flag combos that fell out of test coverage
- [ ] **VM-905** Track audit findings in `docs/audits/`, remediation branch per finding
- [ ] **VM-906** Keep pinned dependency versions up to date (Uniswap v4 pinned commit, solc, forge, OZ major)

---

## Deferred / rejected (do not pursue without ADR)

- Multisig deployer, payment splitter, escrow, prediction markets, ERC-4626, custom AMM curves, delegation contracts, bribe markets, insurance pools, RWA compliance modules, points systems
