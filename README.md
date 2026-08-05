# urufu launchpad

The composable token launchpad. Pick a base, stack audited feature modules, choose a launch mechanic, deploy real Solidity in one transaction. Bonding-curve launches graduate to Uniswap v4 with the graduation LP locked structurally and swap fees routed through the urufu gemu flywheel.

> **Status.** External audit re-review in progress on branch `audit-round-2` (tip: round 6). Live V7 stack on Robinhood chain 4663 remains operational. New launches are gated behind auditor sign-off + a fresh V8 stack rotation. **Do not deploy the patched code until sign-off.**

## Table of contents

- [Overview](#overview)
- [What ships in v1](#what-ships-in-v1)
- [Anti-rug guarantees](#anti-rug-guarantees)
- [Architecture](#architecture)
- [The flywheel](#the-flywheel)
- [Getting started](#getting-started)
- [Testing](#testing)
- [Deploy topology](#deploy-topology)
- [Audit history](#audit-history)
- [Repository layout](#repository-layout)
- [Known limitations](#known-limitations)
- [License + contact](#license--contact)

## Overview

The launchpad turns a base contract plus a set of feature modules into a deployable ERC-20 in one transaction. Bonding-curve launches graduate atomically to a Uniswap v4 pool. Fees from launches, curve trades, and post-graduation swaps route through a three-way splitter (URU buyback / NFT revenue / treasury).

Every rug vector the audit surfaced is closed on-chain, not just in the frontend. Ownership must be renounced on any curve launch. The graduation LP position cannot be removed by anyone including the deployer. Every economic setter is propose-then-activate with a real timelock. Multi-round audit history is at [`PATCH-COVERAGE.md`](./PATCH-COVERAGE.md).

## What ships in v1

Decisions confirmed with the review co-lead (GitHub issues [#5](https://github.com/urufu-labs/urufu-launchpad/issues/5), [#6](https://github.com/urufu-labs/urufu-launchpad/issues/6), [#7](https://github.com/urufu-labs/urufu-launchpad/issues/7), [#11](https://github.com/urufu-labs/urufu-launchpad/issues/11) — all closed decision-accepted):

| Area | v1 scope |
|---|---|
| Chain | Robinhood mainnet (chain id 4663). Base + Ethereum code paths are nulled in `web/src/lib/config.ts`. |
| Base | ERC-20 only. ERC-721A + ERC-1155 are intentionally disabled (`NFT_BASES_ENABLED = false`). |
| Router | Four flat entrypoints: `launch`, `launchWithURU`, `launchWithWhitelist`, `launchWithURUAndWhitelist`. |
| Modules | AntiBot, AntiWhale, FoT, Pausable V2, Permit, Vesting, Staking, Votes, plus 15 curve-compatible pair combos (splicer-generated). |
| Sale mechanic | Bonding curve → Uniswap v4 (with locked graduation LP). Direct / fixed / LBP kept out of v1. |
| Protection knobs | Raw params (`antiSniperBlocks`, `buybackBurnBps`), Router-enforced caps. Presets are post-launch UX work. |
| URU payment | Floor-based via `minUruFee`. **Not** market-quoted. |
| Loyalty discount | Gated on a fork test + CI job + UI live-read; degrades cleanly on RPC or wiring failure. |

Post-audit follow-ups tracked as open issues: on-chain [`PoolPolicy`](https://github.com/urufu-labs/urufu-launchpad/issues/9), [three-layer loyalty gate](https://github.com/urufu-labs/urufu-launchpad/issues/10), [`launchAndBuy` for protected first-buy](https://github.com/urufu-labs/urufu-launchpad/issues/8), [aggregator-friendly indexer](https://github.com/urufu-labs/urufu-launchpad/issues/13), [docs status headers](https://github.com/urufu-labs/urufu-launchpad/issues/12).

## Anti-rug guarantees

Every guarantee is enforced by contract, not the frontend. Contract references are in [`docs/LAUNCHPAD-FULL-SCOPE.md`](./docs/LAUNCHPAD-FULL-SCOPE.md).

- **Graduation LP locked structurally.** The Graduator holds the LP position NFT and has no burn, transfer, or withdraw path, so the graduated position can never be removed. Third-party LPs who add liquidity to the same pool via Uniswap can add + remove theirs freely.
- **Curved launches must renounce ownership.** Router `_validateLaunchPolicy` reverts `CurveMustRenounce` on any curve launch with `KeepEOA` or `TransferToMultisig`. All four entrypoints.
- **Owner-controlled modules cannot pair with the curve.** Pausable, AntiBot, AntiWhale carry `FLAG_REQUIRES_OWNER`. Router blocks with `CurveRequiresOwner`.
- **Pausable no longer exempts the owner.** V1 exempted owner-origin transfers while paused (one-sided sell freeze). V2 removes the exemption; V1 hash `0xa831…803a` is permanently banned.
- **Retired-Airdrop hashes permanently banned.** All 3 rugged Airdrop V1 hashes stay in `Router.bannedConfigHash` at every deploy.
- **Every curve creation requires a live Graduator + reachable target.** Both zero-graduator strand and unreachable-target strand are rejected pre-clone.
- **Every buy leaves ≥ 1 wei-token in reserve.** No configuration can reach graduation with `tokenReserve == 0`.
- **Graduation is atomic.** If the Graduator reverts, the whole transaction unwinds.
- **Hook config is mandatory and read back.** `MultiHookHost.setPoolConfig` + `setCreator` results are verified after the write; mismatch reverts.
- **Every economic admin change is propose → activate.** `FeeSplitter`, `UruDepositSink`, `UruBuybackVault`, `NftRevenueVault` all require a matured proposal for any keeper, target, rate, or config change.
- **Router rotation is one atomic Safe payload.** `BuildRouterCutoverSafeBatch.s.sol` verifies pending state, old-Router pointers, factory pointers, and old-Router trust before signing. Any drift reverts the whole batch.
- **Reward publishing is fail-closed on the journal.** `NftRevenueVault.activateEpoch` refuses to sign unless the local journal row matches the on-chain pending root + total.

## Architecture

```text
              ┌──────────────────────────────────────────┐
              │           web/  (Next.js 16)             │
              │  /create /trade /discover /profile       │
              │  wagmi 2 + viem 2 + lightweight-charts   │
              └───────────────────┬──────────────────────┘
                                  │
              ┌───────────────────┴──────────────────────┐
              │        indexer/ (Ponder v0.7)            │
              │  Launch · Trade · Graduated events       │
              │  Dynamic BondingCurve + Token subs       │
              └───────────────────┬──────────────────────┘
                                  │
              ┌───────────────────┴──────────────────────┐
              │           contracts/ (Foundry)           │
              │                                          │
              │  NameRegistry   ← name + ticker lock     │
              │  Router         ← 4 launch entrypoints   │
              │  FeeSplitter    ← 40/35/25 ETH router    │
              │  LoyaltyOracle  ← discount tiers         │
              │  <base>Factory  ← per-base deploys       │
              │  ERC20Template  ← module splice target   │
              │  BondingCurve   ← virtual x·y=k curve    │
              │  CurveFactory   ← one curve per token    │
              │  GraduatorV2    ← curve → v4 pool        │
              │  MultiHookHost  ← v4 hook (LP-lock, fee) │
              │  UruBuybackVault + NftRevenueVault       │
              │  UruDepositSink + RoyaltyRouterFactory   │
              └──────────────────────────────────────────┘
                                  │
              ┌───────────────────┴──────────────────────┐
              │  compile-service/ (Fastify + Foundry)    │
              │  POST /compile      → splice + build     │
              │  POST /wl/snapshot  → merkle root        │
              │  POST /rewards/publish → journaled       │
              └──────────────────────────────────────────┘
```

## The flywheel

Every launch fee, curve trade, and post-graduation swap feeds a `FeeSplitter` contract that splits ETH three ways:

| Slice | Percentage | Destination |
|---|---|---|
| URU buyback | 40% | `UruBuybackVault` → keeper swaps ETH → URU → forwards URU to `NftRevenueVault` |
| NFT revenue | 35% | `NftRevenueVault` → journaled merkle drops direct to urufu gemu NFT holders |
| Treasury | 25% | Platform, infra, audits |

### Launch fee discounts (via `LoyaltyOracle`)

Displayed at UI-time only when the live-read gate confirms the wiring is intact. Discount claims degrade cleanly on RPC or oracle failure.

- Hold ≥ 1 urufu gemu NFT: **20% off**
- Hold ≥ 100,000 URU: **40% off**
- Hold both: **50% off** (hard-capped at 80% via `MAX_LOYALTY_DISCOUNT_BPS`)

A reverting oracle no longer bricks all launches. The discount is a fail-open read (URU-A14).

### Post-graduation earnings

Real creator earnings accrue **post-graduation** via v4 hooks. The `MultiHookHost` hook takes 1% platform + 1% creator on every swap through a graduated pool. Platform slice → FeeSplitter (loops into 40/35/25). Creator slice → launcher wallet.

Pre-graduation launcher earnings are zero. Curve trade fees route to the platform, so wash-trading a curve earns the launcher nothing.

## Getting started

Requires Node 22+, pnpm, and Foundry (nightly recommended for compatibility with CI).

```bash
git clone https://github.com/urufu-labs/urufu-launchpad
cd urufu-launchpad

pnpm install
cd contracts && forge install && cd ..

cp .env.example .env
# Fill ROBINHOOD_RPC_URL, DEV_PRIVATE_KEY, URU_TOKEN_ADDRESS, GEMU_NFT_ADDRESS
```

Local development:

```bash
pnpm dev:web               # http://localhost:3000
pnpm dev:indexer           # http://localhost:42069  (Ponder)
pnpm dev:compile-service   # http://localhost:3001   (Fastify)
```

The `/create` page renders a "not live yet" splash while `LAUNCHPAD_LIVE = false`. Other pages (`/discover`, `/trade`, `/profile`, `/recover`) remain usable against live V7 state.

## Testing

The launchpad ships with 934 tests across contracts, compile-service, and fork suites. Every audit round adds regressions for the specific behaviors under review.

```bash
# Contracts non-fork (unit + integration + invariants, 10k fuzz runs)
cd contracts && FOUNDRY_PROFILE=ci forge test --no-match-path "test/**/*Fork*"

# Live Robinhood fork suites
source ../.env
FOUNDRY_PROFILE=ci forge test --match-path "test/audit/**Fork*"
FOUNDRY_PROFILE=ci forge test --match-path "test/integration/**Fork*"

# Compile-service (Node 22+ required for --experimental-strip-types)
cd ../compile-service
node --experimental-strip-types --disable-warning=ExperimentalWarning --test 'src/**/*.test.ts'

# Slither static analysis
cd ../contracts && forge clean && bash security.sh
```

### Round 6 test totals

| Suite | Count | Notes |
|---|---|---|
| Contracts non-fork | 759 pass | `FOUNDRY_PROFILE=ci` = 10,000 fuzz runs per property |
| Contracts audit-fork | 56 pass, 1 skip | 1 skip is the pre-existing URUFU-orphan test |
| Contracts integration-fork | 9 pass | Live RH RPC required |
| Compile-service | 110 pass | Node built-in test runner |
| Slither | 0 High | 56 Medium, 46 Low, 130 Informational — full triage in [`.github/SECURITY.md`](./.github/SECURITY.md) |

## Deploy topology

The auditor's plan replaces V7 with a fresh full-stack V8 deploy. Targeted rotation is not viable because the live `NameRegistry` predates the two-phase timelock (`test_LiveRegistry_LacksRotationApi` proves this on every fork run).

```bash
# 1. Rehearse in-fork (no broadcast; validates patched source against live chain state)
forge test --match-path "test/audit/DeployPathRhFork.t.sol" --fork-url "$ROBINHOOD_RPC_URL"

# 2. Broadcast the fresh stack
bash contracts/deploy.sh DeployFreshLocal robinhood

# 3. Verify wiring
forge script script/VerifyWiring.s.sol --rpc-url "$ROBINHOOD_RPC_URL"

# 4. Configure the flywheel (URU-A11: propose → wait 2 days → activate)
export KEEPER=0xYourKeeperAddress
export SWAP_TARGET=0x8876789976dEcBfCbBbe364623C63652db8C0904   # RH Universal Router
bash contracts/deploy.sh ConfigureFlywheel robinhood

# 5. Sync addresses into web + indexer
pnpm sync:addresses

# 6. Hand ownership to the multisig
export MULTISIG_ADMIN=0xYourSafeAddress
pnpm contracts:handoff

# 7. Flip the live flag
# Edit web/src/lib/launchpadStatus.ts: LAUNCHPAD_LIVE = true
```

The Router cutover on subsequent rotations goes through a single Safe MultiSendCallOnly payload built by `BuildRouterCutoverSafeBatch.s.sol`. Preflight checks pending state, ownership, manifest metadata, retired hashes, factory pointers, and old-Router trust before signing.

Uniswap v4 PoolManager on Robinhood: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.

## Audit history

Full round-by-round remediation table lives at [`PATCH-COVERAGE.md`](./PATCH-COVERAGE.md).

| Round | Date | Summary |
|---|---|---|
| Round 1 | Pre-branch | `updateImpl` removal, per-config module-count gate, initial `bannedConfigHash` design, LP-lock via MHH revert |
| Round 2 v1–v5 | 2026-07-31 → 08-02 | LoyaltyOracle on-chain repoint, all-entrypoint banned-hash guard, DeployRouter / ActivateRouter split |
| Round 3 | 2026-08-03 | URU-A01…A14 + exact-output burn bypass |
| Round 4 | 2026-08-04 | Runtime-vs-creation hash split, atomic Safe cutover, exact-output burn revert, pending-reward reservation |
| Round 5 | 2026-08-04 | Publisher wedge, `/test` + `/wl/*` admission controls, holder pagination, MHH LP-lock scoping, pull-based Graduator refund |
| Round 6 | 2026-08-05 | AsyncLocalStorage test isolation, WL cache policy-inclusive key, activation fail-closed on journal, Safe-batch starting-state preflight, 10 splicer-generated pair templates + full customize-mode graduation coverage |

Merge is blocked pending external re-review at the round-6 tip.

## Repository layout

```
launchpad/
├── contracts/                # Foundry workspace
│   ├── src/
│   │   ├── registry/         # NameRegistry (two-phase router rotation)
│   │   ├── router/           # Router, FeeSplitter, UruDepositSink
│   │   ├── templates/        # ERC20Template + composed/ (26+ impls)
│   │   ├── factories/        # ERC20Factory, ERC721AFactory, ERC1155Factory
│   │   ├── curve/            # BondingCurve, CurveFactory, GraduatorV2
│   │   ├── hooks/            # MultiHookHost + BaseHook + HookMiner
│   │   ├── flywheel/         # LoyaltyOracle, NftRevenueVault, UruBuybackVault, RoyaltyRouterFactory
│   │   └── types/            # LaunchParams, BaseType, OwnershipMode
│   ├── modules/              # .frag.sol fragments spliced by compile-service
│   ├── test/                 # unit/, integration/, curve/, hooks/, composed/, audit/*Fork.t.sol
│   ├── script/               # DeployFreshLocal, DeployRouter, ActivateRouter, HandoffOwnership,
│   │                         # ConfigureFlywheel, VerifyWiring, BuildRouterCutoverSafeBatch, RhConfigManifest
│   └── deploy.sh
│
├── compile-service/          # Fastify + Foundry
│   └── src/
│       ├── server.ts         # /compile, /test, /health, /pin/*, /wl/*, /rewards/*
│       ├── compile.ts        # parseFragment + splice + compose
│       ├── rewards.ts        # Journaled publication, PG advisory lock, fail-closed activation
│       ├── wl-snapshot.ts    # Policy-inclusive cache, abort-safe pinning
│       ├── keeper.ts         # Opt-in background loops
│       └── genComposedTemplates.ts   # Reproducible splicer harness
│
├── web/                      # Next.js 16
│   └── src/
│       ├── app/              # /, /create, /discover, /trade/[address], /profile/[address],
│       │                     # /recover, /catalog, /feed
│       └── lib/              # config, modules, abis, wagmi, indexer, launchpadStatus
│
├── indexer/                  # Ponder v0.7
│   ├── ponder.config.ts      # Env-driven multi-chain subscriptions
│   ├── ponder.schema.ts      # 13 tables
│   └── src/index.ts          # Event handlers with in-memory correlation buffers
│
├── shared/                   # Single source of truth (URU-A08 / A09)
│   ├── config-id.ts          # canonicalModuleString: imported by web AND compile-service
│   └── matrix.json           # Module compatibility rules
│
├── tools/
│   └── sync-addresses.mjs    # deployment-fresh.<chain>.json → web + indexer
│
└── docs/
    ├── LAUNCHPAD-FULL-SCOPE.md      # Technical reference (2700+ lines)
    ├── UNISWAP-HOOK-ALLOWLIST.md    # Uniswap Labs submission dossier
    ├── NFT-ACTIVATION.md            # Checklist to enable ERC-721A / ERC-1155 launches
    └── decisions/log.md             # Architectural decision records
```

## Known limitations

- **Indexer** filters v4 swaps to the platform's own swap router and skips administrative events by design. Do not treat indexer output as a security or volume authority; it is a UX feed, not a source of truth.
- **Whitelist snapshots** fail loudly when Blockscout truncates or the block-drift budget is exceeded. Callers wanting partial data must pass `allowPartial: true` explicitly.
- **Live V7 stack** on Robinhood still enforces LP-lock at the hook layer. Shipping the round-5 F5 hook change requires a full MHH + Graduator rotation to a fresh address mined at mask `0x20C4`. Existing pools on the old MHH stay LP-locked forever.
- **NFT bases** are disabled in v1 (`NFT_BASES_ENABLED = false`, no NFT impls registered on fresh deploys). Direct-Router bypass to an NFT base reverts loudly at the policy gate.

## License + contact

Dual-licensed. The SPDX header at the top of each source file is authoritative.

- [**BUSL 1.1**](./LICENSE) covers most files. Source is available to read, audit, fork, and modify. Production use is limited to personal, educational, research, and security-audit purposes. Running a token launchpad, bonding-curve trading, curve graduation to Uniswap v4, or the URU / gemu revenue flywheel for third parties requires a commercial license. **Change Date 2030-07-13** (four years after the license was applied) auto-converts to MIT.
- [**MIT**](./LICENSE-MIT) covers the v4 hook library in `contracts/src/hooks/` (`BaseHook`, `HookMiner`, `MultiHookHost`) and `contracts/src/types/VMTypes.sol`.

Public contact: [x.com/spoobsV1](https://x.com/spoobsV1). Security reports go through the same channel — see [`.github/SECURITY.md`](./.github/SECURITY.md).
