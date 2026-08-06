<div align="center">

<img src="./docs/assets/urufu-mascot.svg" alt="urufu wolf mascot" width="140" />

# ✿ urufu launchpad ✿

> **Status:** current
> _last updated: 2026-08-05_

⌒ the composable token launchpad ⌒  
_pick a base, stack modules, deploy in one transaction_

[![audit](https://img.shields.io/badge/audit-round%206-ff88b3?style=flat-square&labelColor=3a2c3a)](./PATCH-COVERAGE.md)
[![tests](https://img.shields.io/badge/tests-934%20passing-2fbf6a?style=flat-square&labelColor=3a2c3a)](#-testing-)
[![slither](https://img.shields.io/badge/slither-0%20high-bde0fe?style=flat-square&labelColor=3a2c3a)](./.github/SECURITY.md)
[![chain](https://img.shields.io/badge/chain-robinhood%204663-ffefad?style=flat-square&labelColor=3a2c3a)](https://github.com/urufu-labs/urufu-launchpad/issues/6)
[![license](https://img.shields.io/badge/license-BUSL%201.1-ffd1dc?style=flat-square&labelColor=3a2c3a)](./LICENSE)

</div>

<div align="center">

**⋆｡°✩ status ✩°｡⋆**

external audit re-review in progress on `audit-round-2` (tip: round 6)  
live V7 stack on robinhood chain 4663 stays operational  
new launches gated behind auditor sign-off + fresh V8 rotation  
**do not deploy the patched code until sign-off**

</div>

---

## ✿ table of contents ✿

- [overview 概要](#-overview-)
- [what ships in v1 出荷済み](#-what-ships-in-v1-)
- [anti-rug guarantees 安全策](#-anti-rug-guarantees-)
- [architecture 構造](#-architecture-)
- [the flywheel フライホイール](#-the-flywheel-)
- [getting started はじめに](#-getting-started-)
- [testing テスト](#-testing-)
- [deploy topology 配置](#-deploy-topology-)
- [audit history 監査](#-audit-history-)
- [repository layout レイアウト](#-repository-layout-)
- [known limitations 制限](#-known-limitations-)
- [license + contact 版権](#-license--contact-)

---

## ⌒ overview ⌒

the launchpad turns a base contract plus a set of feature modules into a deployable ERC-20 in one transaction. bonding-curve launches graduate atomically to a uniswap v4 pool. fees from launches, curve trades, and post-graduation swaps route through a three-way splitter (URU buyback / NFT revenue / treasury).

every rug vector the audit surfaced is closed on-chain, not just in the frontend. ownership must be renounced on any curve launch. the graduation LP position cannot be removed by anyone including the deployer. every economic setter is propose-then-activate with a real timelock. multi-round audit history lives at [`PATCH-COVERAGE.md`](./PATCH-COVERAGE.md).

---

## ♡ what ships in v1 ♡

decisions confirmed with the review co-lead on gh (issues [#5](https://github.com/urufu-labs/urufu-launchpad/issues/5), [#6](https://github.com/urufu-labs/urufu-launchpad/issues/6), [#7](https://github.com/urufu-labs/urufu-launchpad/issues/7), [#11](https://github.com/urufu-labs/urufu-launchpad/issues/11), all closed decision-accepted):

| area | v1 scope |
|:---|:---|
| ⌒ chain | robinhood mainnet (chain id 4663). base + ethereum code paths nulled in `web/src/lib/config.ts` |
| ⌒ base | ERC-20 only. ERC-721A + ERC-1155 intentionally disabled (`NFT_BASES_ENABLED = false`) |
| ⌒ router | four flat entrypoints: `launch`, `launchWithURU`, `launchWithWhitelist`, `launchWithURUAndWhitelist` |
| ⌒ modules | AntiBot, AntiWhale, FoT, Pausable V2, Permit, Vesting, Staking, Votes, plus 15 curve-compatible pair combos (splicer-generated) |
| ⌒ sale mechanic | bonding curve → uniswap v4 (with locked graduation LP). direct / fixed / LBP kept out of v1 |
| ⌒ protection knobs | raw params (`antiSniperBlocks`, `buybackBurnBps`), router-enforced caps. presets are post-launch UX work |
| ⌒ URU payment | floor-based via `minUruFee`. **not** market-quoted |
| ⌒ loyalty discount | gated on fork test + CI job + UI live-read; degrades cleanly on RPC or wiring failure |

post-audit follow-ups tracked as open issues: on-chain [`PoolPolicy`](https://github.com/urufu-labs/urufu-launchpad/issues/9), [three-layer loyalty gate](https://github.com/urufu-labs/urufu-launchpad/issues/10), [`launchAndBuy` for protected first-buy](https://github.com/urufu-labs/urufu-launchpad/issues/8), [aggregator-friendly indexer](https://github.com/urufu-labs/urufu-launchpad/issues/13), [docs status headers](https://github.com/urufu-labs/urufu-launchpad/issues/12).

---

## ⌒ anti-rug guarantees ⌒

every guarantee below is enforced by contract, not the frontend. contract references sit in [`docs/LAUNCHPAD-FULL-SCOPE.md`](./docs/LAUNCHPAD-FULL-SCOPE.md).

<table>
<tr><td>

**✿ graduation LP locked structurally**  
the graduator holds the LP position NFT and exposes no burn, transfer, or withdraw path. graduated position can never be removed. third-party LPs on the same pool via uniswap can add + remove theirs freely.

</td></tr>
<tr><td>

**✿ curved launches MUST renounce ownership**  
router `_validateLaunchPolicy` reverts `CurveMustRenounce` on any curve launch with `KeepEOA` or `TransferToMultisig`. all four entrypoints.

</td></tr>
<tr><td>

**✿ owner-controlled modules cannot pair with the curve**  
pausable, antibot, antiwhale carry `FLAG_REQUIRES_OWNER`. router blocks with `CurveRequiresOwner`.

</td></tr>
<tr><td>

**✿ pausable no longer exempts the owner**  
v1 exempted owner-origin transfers while paused (one-sided sell freeze). v2 removes the exemption; v1 hash `0xa831…803a` is permanently banned.

</td></tr>
<tr><td>

**✿ retired-airdrop hashes permanently banned**  
all 3 rugged airdrop v1 hashes stay in `Router.bannedConfigHash` at every deploy.

</td></tr>
<tr><td>

**✿ every buy leaves ≥ 1 wei-token in reserve**  
no configuration can reach graduation with `tokenReserve == 0`.

</td></tr>
<tr><td>

**✿ graduation is atomic**  
if the graduator reverts, the whole transaction unwinds.

</td></tr>
<tr><td>

**✿ hook config is mandatory and read back**  
`MultiHookHost.setPoolConfig` + `setCreator` results verified after the write; mismatch reverts.

</td></tr>
<tr><td>

**✿ every economic admin change is propose → activate**  
feesplitter, urudepositsink, urubuybackvault, nftrevenuevault all require a matured proposal for any keeper, target, rate, or config change.

</td></tr>
<tr><td>

**✿ router rotation is one atomic safe payload**  
`BuildRouterCutoverSafeBatch.s.sol` verifies pending state, old-router pointers, factory pointers, and old-router trust before signing. any drift reverts the whole batch.

</td></tr>
<tr><td>

**✿ reward publishing is fail-closed on the journal**  
`NftRevenueVault.activateEpoch` refuses to sign unless the local journal row matches the on-chain pending root + total.

</td></tr>
</table>

---

## ⌒ architecture ⌒

```text
              ╭──────────────────────────────────────────╮
              │           web/  (next.js 16)             │
              │  /create /trade /discover /profile       │
              │  wagmi 2 + viem 2 + lightweight-charts   │
              ╰───────────────────┬──────────────────────╯
                                  │
              ╭───────────────────┴──────────────────────╮
              │        indexer/ (ponder v0.7)            │
              │  launch · trade · graduated events       │
              │  dynamic bondingcurve + token subs       │
              ╰───────────────────┬──────────────────────╯
                                  │
              ╭───────────────────┴──────────────────────╮
              │           contracts/ (foundry)           │
              │                                          │
              │  nameregistry    ✿ name + ticker lock    │
              │  router          ✿ 4 launch entrypoints  │
              │  feesplitter     ✿ 40/35/25 eth router   │
              │  loyaltyoracle   ✿ discount tiers        │
              │  <base>factory   ✿ per-base deploys      │
              │  erc20template   ✿ module splice target  │
              │  bondingcurve    ✿ virtual x·y=k curve   │
              │  curvefactory    ✿ one curve per token   │
              │  graduatorv2     ✿ curve → v4 pool       │
              │  multihookhost   ✿ v4 hook (fee redirect)│
              │  urubuybackvault + nftrevenuevault       │
              │  urudepositsink + royaltyrouterfactory   │
              ╰──────────────────────────────────────────╯
                                  │
              ╭───────────────────┴──────────────────────╮
              │  compile-service/ (fastify + foundry)    │
              │  POST /compile       ✿ splice + build    │
              │  POST /wl/snapshot   ✿ merkle root       │
              │  POST /rewards/*     ✿ journaled epochs  │
              ╰──────────────────────────────────────────╯
```

---

## ♡ the flywheel ♡

every launch fee, curve trade, and post-graduation swap feeds a `FeeSplitter` contract that splits ETH three ways:

<div align="center">

| slice | % | destination |
|:---:|:---:|:---|
| **URU buyback** ✿ | 40% | `UruBuybackVault` → keeper swaps ETH → URU → forwards to `NftRevenueVault` |
| **NFT revenue** ✿ | 35% | `NftRevenueVault` → journaled merkle drops direct to urufu gemu holders |
| **treasury** ⌒ | 25% | platform, infra, audits |

</div>

### ✧ launch fee discounts (via `LoyaltyOracle`)

displayed at UI-time only when the live-read gate confirms the wiring is intact. discount claims degrade cleanly on RPC or oracle failure.

- hold ≥ 1 urufu gemu NFT ➜ **20% off**  
- hold ≥ 100,000 URU ➜ **40% off**  
- hold both ➜ **50% off** (hard-capped at 80% via `MAX_LOYALTY_DISCOUNT_BPS`)

a reverting oracle no longer bricks all launches. the discount is a fail-open read (URU-A14).

### ✧ post-graduation earnings

real creator earnings accrue **post-graduation** via v4 hooks. `MultiHookHost` takes 1% platform + 1% creator on every swap through a graduated pool. platform slice → feesplitter (loops into 40/35/25). creator slice → launcher wallet.

pre-graduation launcher earnings are zero. curve trade fees route to the platform, so wash-trading a curve earns the launcher nothing.

---

## ⌒ getting started ⌒

requires node 22+, pnpm, and foundry (nightly recommended for CI compatibility).

```bash
git clone https://github.com/urufu-labs/urufu-launchpad
cd urufu-launchpad

pnpm install
cd contracts && forge install && cd ..

cp .env.example .env
# fill ROBINHOOD_RPC_URL, DEV_PRIVATE_KEY, URU_TOKEN_ADDRESS, GEMU_NFT_ADDRESS
```

local development:

```bash
pnpm dev:web               # http://localhost:3000
pnpm dev:indexer           # http://localhost:42069  (ponder)
pnpm dev:compile-service   # http://localhost:3001   (fastify)
```

`/create` renders a "not live yet" splash while `LAUNCHPAD_LIVE = false`. other pages (`/discover`, `/trade`, `/profile`, `/recover`) remain usable against live V7 state.

---

## ✿ testing ✿

the launchpad ships with **934 tests** across contracts, compile-service, and fork suites. every audit round adds regressions for the specific behaviors under review.

```bash
# contracts non-fork (unit + integration + invariants, 10k fuzz runs)
cd contracts && FOUNDRY_PROFILE=ci forge test --no-match-path "test/**/*Fork*"

# live robinhood fork suites
source ../.env
FOUNDRY_PROFILE=ci forge test --match-path "test/audit/**Fork*"
FOUNDRY_PROFILE=ci forge test --match-path "test/integration/**Fork*"

# compile-service (node 22+ required for --experimental-strip-types)
cd ../compile-service
node --experimental-strip-types --disable-warning=ExperimentalWarning --test 'src/**/*.test.ts'

# slither static analysis
cd ../contracts && forge clean && bash security.sh
```

### ✧ round 6 test totals

<div align="center">

| suite | count | notes |
|:---|:---:|:---|
| ✿ contracts non-fork | **759** pass | `FOUNDRY_PROFILE=ci` = 10,000 fuzz runs per property |
| ✿ contracts audit-fork | **56** pass, 1 skip | 1 skip is the pre-existing URUFU-orphan test |
| ✿ contracts integration-fork | **9** pass | live RH RPC required |
| ✿ compile-service | **110** pass | node built-in test runner |
| ✿ slither | **0 high** | 56 medium, 46 low, 130 informational |

</div>

full slither triage lives at [`.github/SECURITY.md`](./.github/SECURITY.md).

---

## ⌒ deploy topology ⌒

the auditor's plan replaces V7 with a fresh full-stack V8 deploy. targeted rotation isn't viable because the live `NameRegistry` predates the two-phase timelock (`test_LiveRegistry_LacksRotationApi` proves this on every fork run).

```bash
# 1. rehearse in-fork (no broadcast; validates patched source against live chain state)
forge test --match-path "test/audit/DeployPathRhFork.t.sol" --fork-url "$ROBINHOOD_RPC_URL"

# 2. broadcast the fresh stack
bash contracts/deploy.sh DeployFreshLocal robinhood

# 3. verify wiring
forge script script/VerifyWiring.s.sol --rpc-url "$ROBINHOOD_RPC_URL"

# 4. configure the flywheel (URU-A11: propose → wait 2 days → activate)
export KEEPER=0xYourKeeperAddress
export SWAP_TARGET=0x8876789976dEcBfCbBbe364623C63652db8C0904   # RH universal router
bash contracts/deploy.sh ConfigureFlywheel robinhood

# 5. sync addresses into web + indexer
pnpm sync:addresses

# 6. hand ownership to the multisig
export MULTISIG_ADMIN=0xYourSafeAddress
pnpm contracts:handoff

# 7. flip the live flag
# edit web/src/lib/launchpadStatus.ts: LAUNCHPAD_LIVE = true
```

router cutover on subsequent rotations goes through a single safe multisendcallonly payload built by `BuildRouterCutoverSafeBatch.s.sol`. preflight checks pending state, ownership, manifest metadata, retired hashes, factory pointers, and old-router trust before signing.

uniswap v4 poolmanager on robinhood: `0x8366a39CC670B4001A1121B8F6A443A643e40951`

---

## ⌒ audit history ⌒

full round-by-round remediation table lives at [`PATCH-COVERAGE.md`](./PATCH-COVERAGE.md).

<div align="center">

| round | date | summary |
|:---:|:---:|:---|
| **1** | pre-branch | `updateImpl` removal, per-config module-count gate, initial `bannedConfigHash`, LP-lock via MHH revert |
| **2 v1–v5** | 2026-07-31 → 08-02 | loyaltyoracle on-chain repoint, all-entrypoint banned-hash guard, deployrouter / activaterouter split |
| **3** | 2026-08-03 | URU-A01…A14 + exact-output burn bypass |
| **4** | 2026-08-04 | runtime-vs-creation hash split, atomic safe cutover, exact-output burn revert, pending-reward reservation |
| **5** | 2026-08-04 | publisher wedge, `/test` + `/wl/*` admission controls, holder pagination, MHH LP-lock scoping, pull-based graduator refund |
| **6** | 2026-08-05 | asynclocalstorage test isolation, WL cache policy-inclusive key, activation fail-closed on journal, safe-batch starting-state preflight, 10 splicer-generated pair templates + full customize-mode graduation coverage |

</div>

merge is blocked pending external re-review at the round-6 tip.

---

## ♡ repository layout ♡

```
launchpad/
├── contracts/                # foundry workspace
│   ├── src/
│   │   ├── registry/         # nameregistry (two-phase router rotation)
│   │   ├── router/           # router, feesplitter, urudepositsink
│   │   ├── templates/        # erc20template + composed/ (26+ impls)
│   │   ├── factories/        # erc20factory, erc721afactory, erc1155factory
│   │   ├── curve/            # bondingcurve, curvefactory, graduatorv2
│   │   ├── hooks/            # multihookhost + basehook + hookminer
│   │   ├── flywheel/         # loyaltyoracle, nftrevenuevault, urubuybackvault, royaltyrouterfactory
│   │   └── types/            # launchparams, basetype, ownershipmode
│   ├── modules/              # .frag.sol fragments spliced by compile-service
│   ├── test/                 # unit/, integration/, curve/, hooks/, composed/, audit/*Fork.t.sol
│   ├── script/               # deploy scripts + BuildRouterCutoverSafeBatch + RhConfigManifest
│   └── deploy.sh
│
├── compile-service/          # fastify + foundry
│   └── src/
│       ├── server.ts         # /compile, /test, /health, /pin/*, /wl/*, /rewards/*
│       ├── compile.ts        # parseFragment + splice + compose
│       ├── rewards.ts        # journaled publication, PG advisory lock, fail-closed activation
│       ├── wl-snapshot.ts    # policy-inclusive cache, abort-safe pinning
│       ├── keeper.ts         # opt-in background loops
│       └── genComposedTemplates.ts   # reproducible splicer harness
│
├── web/                      # next.js 16
│   └── src/
│       ├── app/              # /, /create, /discover, /trade/[address], /profile/[address],
│       │                     # /recover, /catalog, /feed
│       └── lib/              # config, modules, abis, wagmi, indexer, launchpadStatus
│
├── indexer/                  # ponder v0.7
│   ├── ponder.config.ts      # env-driven multi-chain subscriptions
│   ├── ponder.schema.ts      # 13 tables
│   └── src/index.ts          # event handlers with in-memory correlation buffers
│
├── shared/                   # single source of truth (URU-A08 / A09)
│   ├── config-id.ts          # canonicalModuleString: imported by web AND compile-service
│   └── matrix.json           # module compatibility rules
│
├── tools/
│   └── sync-addresses.mjs    # deployment-fresh.<chain>.json → web + indexer
│
└── docs/
    ├── LAUNCHPAD-FULL-SCOPE.md      # technical reference (2700+ lines)
    ├── UNISWAP-HOOK-ALLOWLIST.md    # uniswap labs submission dossier
    ├── NFT-ACTIVATION.md            # checklist to enable ERC-721A / ERC-1155 launches
    └── decisions/log.md             # architectural decision records
```

---

## ⌒ known limitations ⌒

- **indexer** filters v4 swaps to the platform's own swap router and skips administrative events by design. don't treat indexer output as a security or volume authority; it's a UX feed, not a source of truth.
- **whitelist snapshots** fail loudly when blockscout truncates or the block-drift budget is exceeded. callers wanting partial data must pass `allowPartial: true` explicitly.
- **live V7 stack** on robinhood still enforces LP-lock at the hook layer. shipping the round-5 F5 hook change requires a full MHH + graduator rotation to a fresh address mined at mask `0x20C4`. existing pools on the old MHH stay LP-locked forever.
- **NFT bases** are disabled in v1 (`NFT_BASES_ENABLED = false`, no NFT impls registered on fresh deploys). direct-router bypass to an NFT base reverts loudly at the policy gate.

---

## ♡ license + contact ♡

dual-licensed. the SPDX header at the top of each source file is authoritative.

- [**BUSL 1.1**](./LICENSE) covers most files. source is available to read, audit, fork, and modify. production use is limited to personal, educational, research, and security-audit purposes. running a token launchpad, bonding-curve trading, curve graduation to uniswap v4, or the URU / gemu revenue flywheel for third parties requires a commercial license. **change date 2030-07-13** (four years after the license was applied) auto-converts to MIT.
- [**MIT**](./LICENSE-MIT) covers the v4 hook library in `contracts/src/hooks/` (`BaseHook`, `HookMiner`, `MultiHookHost`) and `contracts/src/types/VMTypes.sol`.

<div align="center">

**✿ public contact ✿**

[x.com/spoobsV1](https://x.com/spoobsV1)

security reports go through the same channel  
see [`.github/SECURITY.md`](./.github/SECURITY.md)

<sub>♡ built with kawaiicore aesthetics + zero rug tolerance ♡</sub>

</div>
