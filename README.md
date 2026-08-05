# urufu labs

> **The composable token launchpad.** Users pick a base (ERC-20, ERC-721A, ERC-1155), stack audited feature modules, choose a launch mechanic (bare or bonding curve), and deploy real Solidity in one transaction. Bonding-curve launches graduate to Uniswap v4 with LP locked forever and swap fees routed through the urufu gemu flywheel.

**Status:** Audit round 3 v5 complete (2026-08-04). Every URU-Axx acceptance criterion + every page-10 additional-defect item from `Consolidated system-level findings.pdf` + every "Required before merge" item from the auditor's `PATCH-COVERAGE.md` (see repo root) is closed at source-level enforcement AND covered by an executable test. External audit re-review pending. **DO NOT DEPLOY** the patched code until sign-off. Live V7 stack on Robinhood chain 4663 is still operational but URU launches are soft-disabled via emergency mitigation.

**Test state (round-3-v5):**
- Contracts non-fork (`forge test -j 2`): **724 pass, 0 fail**
- Contracts fork suites vs live Robinhood chain 4663: **59 pass, 1 skip** (audit fork 50 + integration fork 9; skip is pre-existing URUFU-orphan)
- Compile-service (`node --test 'src/*.test.ts'`): **39 pass, 0 fail** (URU-A06 crash recovery, URU-A07 available math, URU-A09 shared→manifest drift, tempdir + concurrency, WL snapshot truncation)
- Slither: **0 High**, 56 Medium, 46 Low (High-gate blocks CI on regression)
- Web + compile-service typecheck: clean

**Anti-rug guarantees enforced ON-CHAIN** (not just in the frontend — the audit's page-1 concern):
- Router rejects curve launches with any non-Renounce ownership, any `FLAG_REQUIRES_OWNER` config, out-of-range antiSniper / buybackBurn params, missing metadata, or banned hashes — all four launch entrypoints (`launch`, `launchWithURU`, `launchWithWhitelist`, `launchWithURUAndWhitelist`).
- Pausable V2 no longer exempts owner-origin transfers. V1 hash `0xa831…803a` permanently banned via `Router.bannedConfigHash`.
- Bonding curves cannot leave whitelist buyers or ETH trapped: reserve floor enforced, actual-supply reachability validated, non-zero Graduator required at creation.
- Factory registration binds `configHash → keccak256(impl.code)` via one-shot owner-pinned `expectedCodeHash`. Rogue registrar can't bind arbitrary bytecode.
- Every economic setter (FeeSplitter, UruDepositSink, UruBuybackVault, NftRevenueVault) requires a matured propose → activate cycle. `AdminChangeApplied` events pair with `Proposed`/`Cancelled` so monitors enumerate the pending set.
- Reentrancy guards on `executeBuyback` + `executeConversion`.

**Full technical reference:** [`docs/LAUNCHPAD-FULL-SCOPE.md`](./docs/LAUNCHPAD-FULL-SCOPE.md) — audit-round-by-audit-round history + every mechanic. Read this before touching anything security-critical.

**Known limitations acknowledged:**
- **Indexer** (`indexer/`) filters v4 swaps to the platform's own swap router and skips administrative events by design. Do NOT use indexer output as a complete security or volume authority — it is a UX-facing feed, not a source of truth.
- **Whitelist snapshots** (compile-service `wl-snapshot.ts`) default to fail-loud when Blockscout truncates or the block-drift budget is exceeded. Callers who want partial data must pass `allowPartial: true` explicitly.

**Full technical reference:** [`docs/LAUNCHPAD-FULL-SCOPE.md`](./docs/LAUNCHPAD-FULL-SCOPE.md) — 2700+ lines covering every contract, mechanic, fee flow, and structural gap. Read this before touching anything security-critical.

**Chain scope:** Robinhood mainnet only. Base + Ethereum code paths are nulled in `web/src/lib/config.ts` — see `CHAINS_ENABLED`.

**Launch scope:** ERC-20 only for this release. ERC-721A + ERC-1155 bases are intentionally disabled — `NFT_BASES_ENABLED = false` in `web/src/app/create/page.tsx` blocks NFT base selection in the UI, and `contracts/script/manifest/RhConfigManifest.sol` deliberately does not register NFT impls. Any hand-crafted direct-Router call selecting an NFT base reverts `UnknownConfig` in the factory (honest failure, not a silent broken launch). NFT activation checklist lives at `docs/NFT-ACTIVATION.md` — apply auditor's patch 0003 alongside that checklist when the time comes. Audit finding URU-P1-M03 addressed by this explicit disable rather than by NFT enablement.

---

## The flywheel

Every launch fee, curve trade, and post-graduation swap feeds a `FeeSplitter` contract that splits ETH three ways:

| Slice | % | Destination |
|---|---|---|
| **URU buyback** | 40% | `UruBuybackVault` → keeper swaps ETH → URU → forwards URU to `NftRevenueVault` |
| **NFT revenue** | 35% | `NftRevenueVault` → merkle-drops ETH direct to urufu gemu NFT holders |
| **Treasury** | 25% | Platform + infra + audits |

### Launch-fee discount tiers (via `LoyaltyOracle`)

- Hold ≥ 1 urufu gemu NFT → **20% off** every launch fee
- Hold ≥ 100,000 URU → **40% off**
- Hold both → **50% off** (hard-capped at 80% via `MAX_LOYALTY_DISCOUNT_BPS`)

Discounts apply at `Router.launch()` time via `Router.quoteFor(params, holder)`. A reverting oracle no longer bricks all launches — the discount is a fail-open read (URU-A14).

### Post-graduation earnings

Real creator earnings accrue **post-graduation via v4 hooks**. The `MultiHookHost` hook takes 1% platform + 1% creator on every swap through a graduated pool. Platform slice → FeeSplitter (loops into the 40/35/25). Creator slice → launcher's wallet.

Pre-graduation, launcher earnings are zero — curve trade fees route to the platform, so wash-trading a curve earns the launcher nothing.

### Anti-rug guarantees (on-chain, not frontend)

Every guarantee below is enforced by contract, not the UI. Frontend-only anti-rug rules were the URU-A01 finding — closed in audit round 3.

- **Graduation LP is locked structurally.** The Graduator holds the LP position NFT and exposes no burn, transfer, or withdraw path, so the graduated position can never be removed. Third-party LPs who add liquidity to the same pool via Uniswap can add + remove theirs freely. Regression tested against live RH PoolManager (`test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched`).
- **Curved launches MUST renounce ownership.** Router `_validateLaunchPolicy` reverts `CurveMustRenounce` on any curve launch with `KeepEOA` or `TransferToMultisig`. Enforced on all 4 launch entrypoints.
- **Owner-controlled modules cannot pair with the curve.** Pausable, AntiBot, AntiWhale all carry `FLAG_REQUIRES_OWNER`. Router blocks the combo with `CurveRequiresOwner`.
- **Pausable no longer exempts the owner.** V1 exempted `from == owner()` transfers while paused — a one-sided sell freeze. V2 removes the exemption; V1 hash `0xa831…803a` is permanently banned (URU-A02).
- **Retired-Airdrop hashes permanently banned.** The 3 Airdrop V1 hashes point at a rugged impl (inflation bug). All 3 in `Router.bannedConfigHash` at every deploy via `RhConfigManifest.retiredAirdropHashes`.
- **Every curve creation requires a live Graduator + reachable target.** `CurveFactory._requireGraduator` + `_validateActualSupply` (using ACTUAL supply after reserve-carve, not nominal) prevent both zero-graduator strand and unreachable-target strand.
- **Every buy leaves ≥1 wei-token in reserve.** Prevents the WL terminal-lock states — no configuration can reach graduation with `tokenReserve == 0`.
- **Graduation is atomic.** `graduated = true` and the Graduator call happen in one flow; if the Graduator reverts, the whole tx unwinds.
- **Hook config is mandatory + read back.** Graduator no longer try/catches around `setPoolConfig` + `setCreator`. It reads back `poolConfig(id)` and `creators(id)` after setting and reverts on mismatch — closes the attacker-preplant-then-freeze DoS.
- **Every economic admin change is propose/activate.** `FeeSplitter`, `UruDepositSink`, `UruBuybackVault`, and `NftRevenueVault` all require a matured proposal for any keeper/target/rate/config change. Real timelocks, not cooldowns.

---

## What ships today

| Layer | Status | Notes |
|---|---|---|
| Modules (shipped) | 9 canonical hashes | AntiBot, AntiWhale, FoT, Pausable V2, Permit, Vesting, Staking, Votes, bare + 1 combo (Permit+Staking). See `RhConfigManifest.all()` |
| Modules (retired) | 4 hashes | Airdrop, Airdrop+Permit, Airdrop+Vesting, Pausable V1. All in `retiredAirdropHashes()` |
| v4 hooks | 1 (MultiHookHost) | LP-lock + anti-sniper + fee-redirect + buyback-burn in one contract |
| Flywheel contracts | 6 | FeeSplitter, LoyaltyOracle, NftRevenueVault, UruBuybackVault, UruDepositSink, RoyaltyRouterFactory |
| Contract tests | 651 pass, 0 fail | Unit + integration; forge test -j 2 |
| Fork tests (live RH) | 54 pass, 1 skip | `test/audit/*Fork.t.sol` + `test/integration/*Fork.t.sol` |
| Web (Next.js 16) | live | `/create`, `/trade`, `/discover`, `/profile`, `/recover` |
| Indexer (Ponder v0.7) | live | Multi-chain, dynamic BondingCurve + Token subscriptions |
| Compile service | live | HTTP splicer + journaled reward publications + WL snapshot |
| Live launches | disabled | `LAUNCHPAD_LIVE = false` — awaiting V8 deploy + audit sign-off |

---

## Architecture

```
                    ┌───────────────────────────────────────┐
                    │            web/  (Next.js 16)         │
                    │  /create /trade /discover /profile    │
                    │  wagmi 2 + viem 2 + lightweight-charts│
                    └────────────────┬──────────────────────┘
                                     │
                    ┌────────────────┴──────────────────────┐
                    │       indexer/ (Ponder v0.7)          │
                    │  Launch · Trade · Graduated events    │
                    │  Dynamic BondingCurve + Token subs    │
                    └────────────────┬──────────────────────┘
                                     │
                    ┌────────────────┴──────────────────────┐
                    │        contracts/ (Foundry)           │
                    │                                       │
                    │  NameRegistry  ← name + ticker lock   │
                    │  Router        ← 4 launch entrypoints │
                    │  FeeSplitter   ← 40/35/25 ETH router  │
                    │  LoyaltyOracle ← discount tiers       │
                    │  <base>Factory ← per-base deploys     │
                    │  ERC20Template ← module splice target │
                    │  BondingCurve  ← virtual x·y=k curve  │
                    │  CurveFactory  ← one curve per token  │
                    │  Graduator     ← curve → v4 pool      │
                    │  MultiHookHost ← v4 hook (LP-lock++)  │
                    │  UruBuybackVault + NftRevenueVault    │
                    │  UruDepositSink + RoyaltyRouterFactory│
                    └───────────────────────────────────────┘
                                     │
                    ┌────────────────┴──────────────────────┐
                    │  compile-service/ (Fastify + Foundry) │
                    │  POST /compile   → splice + build     │
                    │  POST /wl/snapshot → merkle root      │
                    │  POST /rewards/publish → journaled    │
                    └───────────────────────────────────────┘
```

### Flywheel data flow

```
launcher pays fee
       │
       ▼
   Router.launch{value: fee}
       │  (Router.quoteFor applies LoyaltyOracle discount, fail-open on oracle revert)
       ▼
  FeeSplitter.receiveFee (URU-A11: 2-day propose/activate timelock on splits)
       │
       ├── 40% ──> UruBuybackVault ──(keeper URU-A11 propose/activate)──> URU ──> NftRevenueVault
       ├── 35% ──> NftRevenueVault ──(URU-A11 propose/activate epochs)──> merkle claim by gemu holders
       └── 25% ──> Treasury (single EOA today; multisig migration queued via HandoffOwnership)

Post-graduation v4 swap fees flow separately:
  MHH.afterSwap ──> platform 1% + creator 1% ──> owed[]
       │
       ├── keeper.pushOwed(FeeSplitter) ──> FeeSplitter (loops into 40/35/25)
       └── launcher.claim() ──> launcher wallet direct
```

---

## Quickstart

```bash
# clone + install
pnpm install
cd contracts && forge install && cd ..

# full contract test suite (unit + integration)
cd contracts && forge test -j 2       # 651 pass, 0 fail

# fork tests against live Robinhood chain 4663
source ../.env
forge test --match-path "test/audit/*Fork.t.sol"       --fork-url "$ROBINHOOD_RPC_URL"
forge test --match-path "test/integration/*Fork.t.sol" --fork-url "$ROBINHOOD_RPC_URL"

# services
pnpm dev:web               # http://localhost:3000
pnpm dev:indexer           # http://localhost:42069 (Ponder)
pnpm dev:compile-service   # http://localhost:3001
```

Frontend home + create page render a "not live yet" splash while `LAUNCHPAD_LIVE = false`. Other pages (discover, trade, profile, recover) are usable against live V7 state.

---

## Audit history

| Round | Date | Findings closed |
|---|---|---|
| Round 1 (external) | pre-branch | updateImpl removal, per-config `moduleCountForConfig` gate, initial `bannedConfigHash` design, curve-incompat flags, LP-lock via MHH revert, refund-on-launch-revert |
| Round 2 v1–v5 | 2026-07-31 → 08-02 | LoyaltyOracle on-chain repoint, `setUruConfig` hardening, `bannedConfigHash` guard on all 4 launch entrypoints, retired-Airdrop count-poison, DeployRouter/ActivateRouter split into staging + atomic-cutover, production-rotation fork test |
| **Round 3** | **2026-08-03** | **URU-A01…A14 + exact-output burn bypass. See commit `c2a7459`.** |

Round 3 patches source-level to close every URU-Axx finding from the auditor's consolidated PDF. Merge is blocked pending external re-review.

---

## Deploy topology (post audit-round-3)

The auditor's plan replaces V7 with a fresh full-stack V8 deploy (targeted rotation isn't viable because the live NameRegistry predates the 2-phase timelock — `test_LiveRegistry_LacksRotationApi` proves this on every fork run).

### Fresh V8 deploy (recommended path)

```bash
# 1. env
cp .env.example .env
# → fill ROBINHOOD_RPC_URL, DEV_PRIVATE_KEY, URU_TOKEN_ADDRESS, GEMU_NFT_ADDRESS

# 2. rehearse in-fork (no broadcast; validates patched V8 source against live chain state)
forge test --match-path "test/audit/DeployPathRhFork.t.sol" --fork-url "$ROBINHOOD_RPC_URL"
# → 12 tests: full lifecycle (launch → curve → graduate → v4 swap → fee accrual)

# 3. broadcast fresh stack
bash contracts/deploy.sh DeployFreshLocal robinhood
# → writes 4 address books:
#     deployment-fresh.4663.json      (full 20-field dump)
#     deployment.4663.json            (legacy Phase-1 shape; HandoffOwnership consumer)
#     deployment-flywheel.4663.json   (legacy; ConfigureFlywheel consumer)
#     deployment-routerv2.4663.json   (legacy; Router-rotation shape)
# → Post-broadcast assertion refuses to write books unless all 4 retired hashes
#   are banned + all 10 canonical hashes are configured atomically.

# 4. verify wiring against the fresh deploy
forge script script/VerifyWiring.s.sol --rpc-url $ROBINHOOD_RPC_URL

# 5. configure flywheel (URU-A11: this now proposes → wait 2 days → activate)
export KEEPER=0xYourKeeperAddress
export SWAP_TARGET=0x8876789976dEcBfCbBbe364623C63652db8C0904  # RH Uniswap Universal Router
bash contracts/deploy.sh ConfigureFlywheel robinhood
# → First run: proposes vault admin changes + FeeSplitter config.
# → Wait minConfigDelay (2 days).
# → Re-run: activates all pending proposals.

# 6. sync addresses into web + indexer
pnpm sync:addresses
# → patches CONTRACTS + HOOKS + GRADUATORS + FLYWHEEL blocks in web/src/lib/config.ts

# 7. hand ownership to multisig (URU-A13: HandoffOwnership uses setOwner for Graduator)
export MULTISIG_ADMIN=0xYourSafeAddress
pnpm contracts:handoff
# → Iterates every Ownable + calls Graduator.setOwner. Integration-tested in
#   test/integration/HandoffOwnershipIntegration.t.sol against a full V8 stack.

# 8. flip frontend live flag
# → Set `LAUNCHPAD_LIVE = true` in web/src/lib/launchpadStatus.ts
# → Redeploy web app
```

### Uniswap v4 PoolManager (Robinhood)

`0x8366a39CC670B4001A1121B8F6A443A643e40951` — the canonical Uniswap-deployed PoolManager on RH.

---

## Repository layout

```
launchpad/
├── contracts/                # Foundry workspace
│   ├── src/
│   │   ├── registry/         # NameRegistry (source has 2-phase; live still single-step)
│   │   ├── router/           # Router (V8 source), FeeSplitter, UruDepositSink
│   │   ├── templates/        # ERC20Template + ERC20VotesTemplate + composed/ (31 impls)
│   │   ├── factories/        # ERC20Factory, ERC721AFactory, ERC1155Factory (one-shot registerImpl)
│   │   ├── curve/            # BondingCurve, CurveFactory, GraduatorV2 (V8-final)
│   │   ├── hooks/            # MultiHookHost + BaseHook + HookMiner
│   │   ├── flywheel/         # LoyaltyOracle, NftRevenueVault, UruBuybackVault, RoyaltyRouter*
│   │   └── types/            # LaunchParams, BaseType, OwnershipMode
│   ├── modules/              # .frag.sol fragments (spliced into templates by compile-service)
│   ├── test/                 # unit/, integration/, curve/, hooks/, composed/, audit/*Fork.t.sol
│   ├── script/               # DeployFreshLocal, DeployRouter, ActivateRouter, HandoffOwnership,
│   │                          # ConfigureFlywheel, VerifyWiring, DeployFlywheel, and RhConfigManifest
│   └── deploy.sh             # wrapper for forge script invocations
│
├── compile-service/          # Fastify + Foundry
│   ├── src/
│   │   ├── server.ts         # /compile, /test, /health, /pin/*, /wl/*, /rewards/*
│   │   ├── compile.ts        # parseFragment + splice + compose
│   │   ├── rewards.ts        # URU-A06 journaled publication + PG advisory lock + reconciliation
│   │   ├── matrix.ts         # URU-A09 server-side parameter validation
│   │   ├── keeper.ts         # opt-in background loops (MHH.pushOwed + NftRevenueVault epochs)
│   │   └── config-id.test.ts # asserts canonical ConfigId identity is stable
│   └── fixtures/             # canonical config JSONs (one per checked-in composed impl)
│
├── web/                      # Next.js 16
│   └── src/
│       ├── app/              # /, /create, /discover, /trade/[address], /profile/[address],
│       │                     # /recover, /catalog, /feed
│       └── lib/              # config, modules, abis, wagmi, indexer, launchpadStatus
│
├── indexer/                  # Ponder v0.7
│   ├── ponder.config.ts      # env-driven multi-chain subscriptions
│   ├── ponder.schema.ts      # 13 tables (launches, curves, trades, v4Swaps, graduations, holders, +flywheel)
│   └── src/index.ts          # event handlers with in-memory correlation buffers
│
├── shared/                   # URU-A08 single source of truth
│   ├── config-id.ts          # canonicalModuleString — imported by web AND compile-service
│   └── matrix.json           # module compat rules (Staking incompat with Vesting synced)
│
├── tools/
│   └── sync-addresses.mjs    # deployment-fresh.<chain>.json → web + indexer
│
└── docs/
    ├── LAUNCHPAD-FULL-SCOPE.md      # THE technical reference (2700+ lines)
    ├── UNISWAP-HOOK-ALLOWLIST.md    # submission dossier for app.uniswap.org routing
    ├── NFT-ACTIVATION.md            # checklist to enable ERC-721A / ERC-1155 launches
    └── decisions/log.md             # ADRs
```

---

## Known follow-ups (not audit-blocking)

- **Uniswap Labs allowlist**: MHH uses `afterSwapReturnDelta = true` → falls into "must submit" bucket. Submission dossier ready at `docs/UNISWAP-HOOK-ALLOWLIST.md`. Chicken-and-egg: needs a graduated pool on-chain first.
- **NFT-base activation**: `NFT_BASES_ENABLED = false` in `web/src/app/create/page.tsx`. Full plumbing exists (both NFT factories deployed, RoyaltyRouterFactory wired). Activation checklist in `docs/NFT-ACTIVATION.md`.
- **Multisig handoff**: currently a single EOA controls every Ownable. `HandoffOwnership.s.sol` is queued but not executed. Blast radius bounded by (a) all economic changes are propose/activate, (b) LP is unrecoverable, (c) no proxy upgrades exist.

**Deferred by design:**
- Payment splitter / RWA / DAO tooling — out of scope forever.
- On-chain metadata registry — kept off-chain for gas efficiency.
- Launch-fee creator kickback — kept off to prevent spam-launch farming. Real creator earnings gated by post-graduation v4 hook swap fees.

---

## License

Dual-licensed. The SPDX header at the top of each source file is authoritative.

- **[BUSL 1.1](./LICENSE)** — most files. Source is available to read, audit, fork, and modify. Production use limited to personal/educational/research/security-audit purposes; running a token launchpad, bonding-curve trading, curve graduation to Uniswap v4, or the URU / gemu revenue flywheel for third parties requires a commercial license. **Change Date 2030-07-13** — four years after License applied — auto-converts to MIT.
- **[MIT](./LICENSE-MIT)** — the v4 hook library in `contracts/src/hooks/` (`BaseHook`, `HookMiner`, `MultiHookHost`) and `contracts/src/types/VMTypes.sol`.

Public contact: [x.com/spoobsV1](https://x.com/spoobsV1)
