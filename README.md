# urufu labs

> **The composable token launchpad.** Users pick a base (ERC-20, ERC-721A, ERC-1155), stack audited feature modules, choose a launch mechanic (direct or bonding curve), and deploy real Solidity in one transaction. Bonding-curve launches graduate to Uniswap v4 with LP locked forever and swap fees routed through the urufu gemu flywheel.

**Status:** Phase 2 code-complete. Contracts + web + indexer wired. 521 tests passing. Broadcast-ready.

---

## The flywheel

urufu labs is not a standalone launchpad — it is the **fee engine for the urufu gemu
economy**. Every launch fee, every curve trade, and every post-graduation swap feeds a
smart `FeeSplitter` contract. It splits ETH three ways:

| Slice | % | Destination |
|---|---|---|
| **URU buyback** | 40% | `UruBuybackVault` → keeper swaps ETH → URU → forwards to urufu gemu NFT holders |
| **NFT revenue** | 35% | `NftRevenueVault` → merkle-drops ETH direct to urufu gemu NFT holders |
| **Treasury** | 25% | Platform + infra + audits |

### Why there's no launch-fee "creator" slot

An earlier draft had a fourth 10% slot that would route back to the launcher of the
specific token. **Removed on purpose.** Reason: it creates a spam-launch farming surface —
deploy → trigger a fake buy → collect kickback → walk away. The kickback per launch is
tiny (~0.005 ETH) but the attack scales linearly with cheap deploys, and every fake
launch pollutes the discovery feed for real users.

Real creator earnings accrue **post-graduation via v4 hooks** (`FeeRedirectHook`,
`MultiHookHost`). Those hooks take bps of every swap on the graduated pool. The pool only
exists once the bonding curve has actually graduated — a real 4-ETH market-cap threshold
that requires real buy volume from real traders, not a self-wash loop. That gate makes
farming uneconomical: you'd need to sink >4 ETH of real capital into a token you plan to
abandon, just to unlock a swap fee stream on a pool you no longer trade against.

### Launch-fee discount tiers (via `LoyaltyOracle`)

- Hold ≥ 1 urufu gemu NFT → **20% off** every launch fee
- Hold ≥ 100,000 URU → **40% off**
- Hold both → **50% off** (hard-capped at 80% by `HARD_MAX_DISCOUNT_BPS`)

Discounts apply at `Router.launch()` time via `Router.quoteFor(params, holder)`.

### Anti-rug guarantees

- **LP is locked forever.** At graduation, the Graduator mints a full-range v4 LP
  position and installs `LPLockedHook`, whose `beforeRemoveLiquidity` reverts on every
  call. The classic "drain the LP" rug is architecturally impossible.
- **Pre-graduation launcher earnings are zero.** Curve trade fees route to platform, not
  launcher. Wash-trading a curve pre-graduation earns the launcher nothing.
- **Curated modules neutralize insider dumps.** `AntiWhale`, `AntiBot`, `Vesting`,
  `Refundable` are opt-in but all audited and combinable via the drag-drop cart.
- **Timelock-gated splits.** `FeeSplitter.setConfig` requires `minConfigDelay` (default
  2 days) between changes. Users get a heads-up before splits shift.
- **Zero-sink rollover.** If a slice's destination is unset, its share rolls into the
  treasury instead of being lost.

### The reinforcing loop

Launches generate fees → 40% buys URU + 35% pays urufu gemu holders → URU price
appreciation + gemu NFT demand → more people qualify for launch-fee discount tiers →
more launches. The launchpad's own economics reinforce the game's economics reinforce
the launchpad's. Platform token, NFT collection, and launchpad revenue all pull the same
direction.

Ecosystem addresses (URU, gemu) documented in `docs/references/ecosystem-contracts.md`;
full spec + invariants in `docs/AUDIT-PREP.md`. Deploy the flywheel post-Phase 1 via
`CHAIN=base pnpm contracts:deploy:flywheel`.

---

## What ships today

| Layer | Count | Notes |
|---|---|---|
| Modules | **20 shipped** | AntiBot, FeeOnTransfer, AntiWhale, Pausable, Permit, Votes, OnChainSVG, ERC2981Royalty, Soulbound, DelayedReveal, Refundable, Airdrop, Vesting, Staking, GovernorBundle, PayableMint1155, SupplyPerToken1155, and more |
| v4 hooks | **5 shipped + 1 flywheel** | LPLocked, FeeRedirect, AntiSniper, MultiHookHost, BuybackBurn, **BuybackUruHook** |
| Flywheel contracts | **4 shipped** | FeeSplitter, LoyaltyOracle, NftRevenueVault, UruBuybackVault |
| Curated impls | **37 registered** | Every combo `DeployPhase1` puts in the factory registries |
| Contract tests | **521 passing** | In-memory + Sepolia-fork rehearsals + flywheel + invariants |
| Bonding curve | **live** | Virtual-reserve `x·y=k`, 1% fee, 4 ETH graduation → v4 pool + locked LP |
| Trade UI | **live** | Pump.fun-style feed, TradingView candles (gwei precision), buy/sell panel |
| Indexer | **wired** | Ponder handlers for Launch, Trade, Graduated, CurveInstalled |
| Mobile responsive | **yes** | Header wrap, chain switcher, breakpoint-based nav visibility |
| Deployed on chain | **not yet** | Broadcast playbook below |

---

## Architecture

```
                    ┌───────────────────────────────────────┐
                    │            web/  (Next.js 16)         │
                    │  /create  /catalog  /discover /trade  │
                    │  wagmi 2 + viem 2 + lightweight-charts│
                    └────────────────┬──────────────────────┘
                                     │
                    ┌────────────────┴──────────────────────┐
                    │       indexer/ (Ponder v0.7)          │
                    │  Launch · Trade · Graduated events    │
                    │  Dynamic BondingCurve subscription    │
                    └────────────────┬──────────────────────┘
                                     │
                    ┌────────────────┴──────────────────────┐
                    │        contracts/ (Foundry)           │
                    │                                       │
                    │  NameRegistry  ← ticker+name reserve  │
                    │  Router        ← user entry, one-tx   │
                    │  FeeSplitter   ← 3-way fee router     │
                    │  LoyaltyOracle ← discount tiers       │
                    │  <base>Factory ← per-base deploys     │
                    │  <base>Template ← splicer targets     │
                    │  BondingCurve  ← pump.fun-style       │
                    │  CurveFactory  ← one curve per token  │
                    │  Graduator     ← v4 pool + locked LP  │
                    │  <hook>        ← v4 hook contracts    │
                    │  UruBuybackVault + NftRevenueVault    │
                    └───────────────────────────────────────┘
```

### Flywheel data flow

```
launcher pays fee
       │
       ▼
   Router ── LoyaltyOracle.discountBpsFor(msg.sender) ──> quote
       │
       ▼
  FeeSplitter.receiveFee{value: fee}
       │
       ├── 40% ──> UruBuybackVault ──(keeper swap)──> URU ──> gemu holders
       ├── 35% ──> NftRevenueVault ──(merkle drops)──> gemu holders
       └── 25% ──> Treasury (platform + infra + audits)

(same splitter also receives post-graduation swap fees
 via BuybackUruHook.afterSwap on graduated v4 pools)
```

---

## Quickstart

```bash
# clone + install
pnpm install
cd contracts && forge install && cd ..

# run the full contract suite (in-memory)
pnpm contracts:test        # 454 tests

# run the same against a Sepolia fork (real chain state)
pnpm contracts:rehearse:combos

# spin up all three services locally
pnpm dev:web               # http://localhost:3000
pnpm dev:indexer           # http://localhost:42069 (Ponder)
pnpm dev:compile-service   # http://localhost:3001
```

Open `http://localhost:3000` — nav is `shop / shelf / launches / trade`. The `/discover` and `/trade/[address]` pages ship mock data by default so you can preview the UI before broadcasting.

---

## Broadcast playbook

The full path from cold-clone to a live Sepolia deploy the trade page can hit:

```bash
# 1. env
cp .env.example .env
# → fill SEPOLIA_RPC_URL, DEV_PRIVATE_KEY (funded ~0.5 ETH), ETHERSCAN_API_KEY

# 2. rehearsal (no broadcast; runs against forked Sepolia state)
pnpm contracts:rehearse:phase1
pnpm contracts:rehearse:combos     # every impl combo, one launch through Router each

# 3. broadcast
pnpm contracts:deploy:phase1        # writes contracts/deployment.11155111.json
pnpm contracts:deploy:hooks         # optional — needs V4_POOL_MANAGER env

# 4. verify on Etherscan
pnpm contracts:verify:phase1

# 5. sync addresses into web + indexer
pnpm sync:addresses                 # patches web/src/lib/config.ts + prints .env block
# → copy the printed .env block into your .env, restart web + indexer

# 6. smoke test against the live deploy
pnpm contracts:smoke                # launches a token, buys on its curve, prints trade URL

# 7. deploy the flywheel (Base recommended — where URU + gemu live)
export URU_TOKEN_ADDRESS=0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac
export GEMU_NFT_ADDRESS=0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A
export URU_THRESHOLD=100000000000000000000000   # 100,000e18
CHAIN=base pnpm contracts:deploy:flywheel

# 8. configure the flywheel: allowlist keeper + swap target + set splits
#    (splits step needs the 2-day timelock elapsed — re-run then if not)
export KEEPER=0xYourKeeperAddress
export SWAP_TARGET=0x6fF5693b99212Da76ad316178A184AB56D299b43   # Base Universal Router
CHAIN=base pnpm contracts:configure:flywheel

# 9. hand ownership to your multisig (once you're satisfied)
export MULTISIG_ADMIN=0xYourSafeAddress
pnpm contracts:handoff
```

All of these run against Sepolia by default. Swap the `sepolia` suffix / RPC env var for `mainnet`, `base`, or `base-sepolia`. **Base is where the flywheel lives** because URU and the urufu gemu NFT collection are already deployed there.

**Ownership model.** Every admin-controlled contract uses Solady `Ownable` (one-step transfer). The deploy key is expected to be hot / rotated out immediately via `HandoffOwnership.s.sol`. Router has a `paused` circuit breaker (`Router__Paused` on every `launch()` call) that the owner can flip in an incident.

**Pause runbook.**
```bash
# from the multisig, via Safe or cast:
cast send <ROUTER> "setPaused(bool)" true --rpc-url $SEPOLIA_RPC_URL --private-key $MULTISIG_KEY
# → all new launches revert until unpaused. Existing curves + trades unaffected.
```

---

## Repository layout

```
launchpad/
├── contracts/                # Foundry workspace
│   ├── src/
│   │   ├── registry/         # NameRegistry
│   │   ├── router/           # Router, FeeReceiver
│   │   ├── templates/        # ERC20Template, ERC721ATemplate, ERC1155Template
│   │   │   └── composed/     # spliced Gen contracts (33 configs)
│   │   ├── factories/        # per-base deploy factories
│   │   ├── curve/            # BondingCurve, CurveFactory
│   │   ├── hooks/            # 5 v4 hooks + BaseHook + HookMiner
│   │   ├── governance/       # VMGovernor
│   │   └── types/            # LaunchParams, enums
│   ├── modules/              # module fragments (.frag.sol)
│   ├── test/                 # 454 tests: unit/, integration/, curve/, hooks/, composed/
│   ├── script/               # DeployPhase1, DeployHooks, HandoffOwnership, PostDeploySmoke
│   ├── rehearse-*.sh         # fork rehearsal scripts
│   └── verify-phase1.sh      # Etherscan verification
│
├── compile-service/          # module splicer (Node + Foundry)
│   ├── src/                  # compile.ts, matrix.ts, cli.ts
│   └── fixtures/             # per-config JSON inputs
│
├── web/                      # Next.js 16
│   └── src/
│       ├── app/
│       │   ├── create/       # the shop
│       │   ├── catalog/      # module shelf
│       │   ├── discover/     # pump.fun-style feed
│       │   └── trade/        # /trade + /trade/[address]
│       ├── components/       # Mascot, TradeChart, WalletButton, ...
│       └── lib/              # abis, config, modules, mockLaunches, indexer, metadata
│
├── indexer/                  # Ponder v0.7
│   ├── ponder.config.ts      # networks + contracts (incl. dynamic BondingCurve)
│   ├── ponder.schema.ts      # launches, curves, trades, graduations
│   └── src/index.ts          # event handlers
│
├── shared/                   # cross-repo source of truth
│   └── matrix.json           # module compat rules — read by FE + BE
│
├── tools/
│   └── sync-addresses.mjs    # deployment.<chain>.json → web + indexer
│
└── docs/                     # per-contract specs, ADRs, phase roadmap
```

---

## Known follow-ups

**Phase 3** (post-Sepolia broadcast):
- External audit + Immunefi bug bounty per `docs/SECURITY.md`.
- Actual Base broadcast + multisig setup.
- B20 compliance module lineup (`B20PolicyAware`, `Blocklist`, `Jailable`) — planned.
- Ponder → hosted indexer migration.

**Deferred by design:**
- Payment splitter / RWA / DAO tooling — out of scope forever.
- On-chain metadata registry — kept off-chain to keep launches gas-efficient.
- Launch-fee creator kickback — kept off to prevent spam-launch farming; real creator earnings gated by post-graduation v4 hook swap fees.

---

## License

Dual-license: MIT for interfaces + templates, BUSL-1.1 for the bonding curve, hooks, and Router — the moat pieces.

---

## Contact

Brandon (@brand) — solo dev.
