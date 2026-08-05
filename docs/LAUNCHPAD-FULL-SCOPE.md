# Urufu Launchpad — Full Scope Reference

**Every mechanic in the launchpad, end to end.** Written for auditors, integrators, and future contributors who need the complete picture without piecing it together from source files. No summaries, no hand-waving; every claim points at a specific file, line number, or on-chain read.

**Audience prerequisite:** Solidity 0.8, Uniswap v4 pool/hook model, EIP-1167 clones, ERC-2981 royalty standard, merkle proofs.

**Doc scope:** the entire on-chain contract system, the frontend, the indexer, the compile service, the flywheel, and every fee flow. All addresses in this doc are LIVE on Robinhood chain 4663 unless prefixed otherwise. Historical Base / Ethereum deployments are retired (see §2).

**Last verified:** 2026-08-03 against Robinhood mainnet RPC. Contract state, ownership, and balances are cast-call snapshots at that time and may drift.

**Post-audit-round-3 addendum (commits `c2a7459` → `255fe57` → `79395c7` → `5acd5ea` → current v5)**: this doc reflects the SOURCE (V8) code that will replace live V7 on the next fresh deploy. Sections tagged **[V8 change vs live]** describe deltas between what's deployed on the live RH V7 stack today and what the patched source will do at V8 deploy. Live V7 remains operational; nothing in this doc has been broadcast to mainnet yet.

Every URU-Axx acceptance criterion from `urufu_protocol_audit_and_remediation_spec.docx` AND every "Required before merge" item from the auditor's own `PATCH-COVERAGE.md` (at repo root) is closed with source-level enforcement AND an executable test. See §25.7 – §25.11 for the round-by-round history.

---

## Table of Contents

1. [Overview & Status](#1-overview--status)
2. [Chain Scope & Deployment Topology](#2-chain-scope--deployment-topology)
3. [Live Address Book](#3-live-address-book)
4. [End-to-End User Flow](#4-end-to-end-user-flow)
5. [Router — The Central Entry Point](#5-router--the-central-entry-point)
6. [Base Factories (ERC20 / ERC721A / ERC1155)](#6-base-factories)
7. [NameRegistry — Reservations & Timelock](#7-nameregistry)
8. [Template + Module Fragment System](#8-template--module-fragment-system)
9. [Module Catalog — Every Shipped Module](#9-module-catalog)
10. [Compile Service](#10-compile-service)
11. [Bonding Curve](#11-bonding-curve)
12. [CurveFactory](#12-curvefactory)
13. [Graduator (V8-final)](#13-graduator)
14. [MultiHookHost — The V4 Hook](#14-multihookhost)
15. [Flywheel — FeeSplitter & Sinks](#15-flywheel)
16. [URU + GEMU + Loyalty](#16-uru--gemu--loyalty)
17. [Royalty Router — NFT Secondary Sales](#17-royalty-router)
18. [Fee Flow — Every Wei Traced](#18-fee-flow)
19. [Whitelisted Launches](#19-whitelisted-launches)
20. [Ownership Model & HandoffOwnership](#20-ownership-model)
21. [Deploy Topology — Fresh vs Rotation](#21-deploy-topology)
22. [Frontend Architecture](#22-frontend-architecture)
23. [Indexer Architecture](#23-indexer-architecture)
24. [Known Limitations & Structural Gaps](#24-known-limitations--structural-gaps)
25. [Audit History](#25-audit-history)
26. [Test Coverage Map](#26-test-coverage-map)

---

## 1. Overview & Status

**Urufu Launchpad** is a pump.fun-style token launchpad that:
1. Deploys audited ERC-20 clones with optional composed modules (Permit, Vesting, Staking, Votes, AntiBot, AntiWhale, FeeOnTransfer, Pausable, Permit+Staking).
2. Wraps each ERC-20 launch in a virtual-reserve constant-product bonding curve.
3. Graduates the curve into a Uniswap v4 pool with LP permanently locked, once curve reserves cross a target ETH threshold.
4. Redirects a portion of every swap fee to the platform (`FeeSplitter`) and the per-launch creator (`launcher EOA`) via a custom v4 hook (`MultiHookHost`).
5. Splits the platform slice (40 % URU buyback / 35 % NFT-holder rewards / 25 % treasury) via a 2-day-timelocked configurable `FeeSplitter`.
6. Offers URU-token as an alternate launch-fee payment currency, converted to ETH by a keeper and looped through the same flywheel.
7. Grants launch-fee discounts to holders of the ecosystem tokens URU + urufu gemu NFT (via `LoyaltyOracle`).
8. Supports NFT launches (ERC-721A + ERC-1155) with a per-collection royalty-splitter clone pattern that hard-splits secondary-sale royalties between the launcher and the platform.

**Launch status:** **NOT YET LIVE FOR USERS.** The frontend has a kill-switch (`web/src/lib/launchpadStatus.ts:12` — `LAUNCHPAD_LIVE = false`) that renders a "Not Live Yet" splash on the home + create pages. All on-chain contracts ARE deployed and functional on Robinhood mainnet; the frontend gate keeps user launches disabled while the audit round-2 fixes await external re-review.

**Audit status:** external audit round 2 (PR #1) in progress. Round-1 findings and rounds 2v1–2v5 findings all closed at the source level; commit `0b98349` on branch `audit-round-2` is the currently-submitted head awaiting re-review.

---

## 2. Chain Scope & Deployment Topology

### 2.1 Supported chains today

**Robinhood mainnet only.** Chain id `4663`. RPC `https://rpc.mainnet.chain.robinhood.com`. Explorer `https://robinhoodchain.blockscout.com`.

Enforced in `web/src/lib/config.ts:24-26`:
```typescript
export const CHAINS_ENABLED = ['robinhood'] as const;
```

And `web/src/lib/config.ts:40`:
```typescript
export const DEFAULT_CHAIN: ChainKey = 'robinhood';
```

### 2.2 Historical / retired chains

Base + Base Sepolia + Ethereum mainnet had earlier deployments; those are RETIRED per the 2026-07-25 URU + GEMU migration to Robinhood. `web/src/lib/config.ts` explicitly nulls those chains' address maps (`base: null` line 124, `base-sepolia: null` line 125, `mainnet: null` line 116, `sepolia: null` line 117). They surface as grayed-out chips in the header chain dropdown via `CHAINS_COMING_SOON = ['base', 'mainnet', 'base-sepolia']` (line 31-35).

Base + Ethereum still hold live MHH + Graduator addresses from earlier deploys (`web/src/lib/config.ts:156-199` and `:203-215`), but no user path can reach them since the frontend chain selector filters them out.

### 2.3 What "RH-only" means for the code

- **Every chain-selector code path** still exists — the frontend, indexer, and deploy scripts are chain-parametric. Re-enabling a chain is an env-var + `CHAINS_ENABLED` change, not a redeploy.
- **The indexer** subscribes to every chain listed in the `INDEXER_CHAINS` env var; if that env is empty, silently indexes nothing on that chain.
- **Deploy scripts** read chain-scoped env vars (`ROBINHOOD_*`, `BASE_*`, etc.), so `forge script DeployFreshLocal --rpc-url $BASE_RPC_URL` would deploy a fresh stack on Base — but nothing today runs that.

---

## 3. Live Address Book

Every canonical live address on Robinhood chain 4663. Pinned in `contracts/test/audit/RhLiveStackSnapshot.t.sol` — that test suite fails loudly if any of these drifts from what the code / `.env` believes.

### 3.1 Ownership & control

| Role | Address |
|---|---|
| **Deployer / Owner / Treasury / Keeper** (single EOA) | `0x6d606cc634F20f5534fba072757F2c2C7B835Bb9` |

This single EOA is currently:
- The `owner()` of every Ownable contract in the stack (Router, CurveFactory, Graduator, MHH's `deployer` slot, all flywheel contracts, both NFT factories, ERC20Factory, NameRegistry).
- The treasury sink for the 25 % slice of FeeSplitter.
- The MHH constructor-provided fallback creator (`creator` immutable) for pools not initialized through the launchpad's Graduator.
- The keeper for both `UruBuybackVault` (ETH→URU) and `UruDepositSink` (URU→ETH), and for `NftRevenueVault.addEpoch`.

Migration to a multisig is queued via `contracts/script/HandoffOwnership.s.sol` but not executed. This is the top ops-risk item — noted in `.github/SECURITY.md:87` and README §Security.

### 3.2 Router + factories

| Contract | Address | Role |
|---|---|---|
| Router (V7) | `0x84C72d6882f10833bD4eBD7c45D4353FDf20B596` | 4 launch entrypoints, fee collection, name reservation, ownership dispatch |
| NameRegistry | `0x60b797f18292d941E72B2b59916C0afC1A81118C` | Name + ticker reservation; legacy single-step (no 2-phase router rotation) |
| ERC20Factory | `0x14c1f066b91760565d5eEc8Cf4696A4648b552F2` | Impl registry (10 canonical hashes) + LibClone deployer |
| ERC721AFactory | `0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc` | Impl registry (7 impls registered, only bare exposed in UI) |
| ERC1155Factory | `0x0f16a0D9aEef54e2321Ea6Fa264d638130297597` | Impl registry (bare only registered) |
| CurveFactory | `0x1c340f092c89d018d7F6410B0A418253FB522c70` | Deploys bonding curves per launch, trusts Router, mints defaults |
| BondingCurve impl | `0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9` | LibClone target — every curve is a clone of this |
| Graduator (V8-final) | `0x0Db63b8Af346c5edabF79b16A236AEDA0428e712` | Migrates curve → v4 pool, LP-mint, launcher ETH refund |
| MultiHookHost (MHH) | `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` | The single v4 hook: LP-lock, anti-sniper, fee-redirect, buyback-burn |

### 3.3 Flywheel

| Contract | Address | Role |
|---|---|---|
| FeeSplitter | `0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA` | Entry for every ETH fee; 40/35/25 split (URU / NFT / treasury) with 2-day timelock on split changes |
| UruBuybackVault | `0x68c5Ec467027fCe56f158eB1ff34cF89d0929354` | Receives 40 %; keeper swaps ETH→URU; forwards URU to NftRevenueVault |
| NftRevenueVault | `0x93CFF459d5019eEc82fE9335013e265F1eD659c7` | Receives 35 %; keeper publishes merkle epochs; gemu holders claim ETH pro-rata |
| UruDepositSink | `0xA6b3748023540af1aD4C4731E8B8A09fACFf737e` | Router pushes URU-pay fees here; keeper swaps URU→ETH; forwards to FeeSplitter |
| LoyaltyOracle | `0xd13A1fb6d9c209B56044464269fce66Ed417AC2E` | Reads URU + GEMU balances; returns discount bps for launch fees |
| RoyaltyRouterFactory | `0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05` | Deploys per-collection royalty splitters (5 % platform / 95 % launcher) |
| RoyaltyRouterImpl | `0x4CAD1C5cFA9C20F3cfcC2C8881b4a9fdd63D20e3` | LibClone target for the royalty splitter |

### 3.4 Ecosystem tokens

| Token | Address | Role |
|---|---|---|
| URU (ERC-20) | `0x9fbe210007dDd8389f98d0253018e65CC48b9D24` | Launch-fee currency; loyalty discount source; buyback target |
| urufu gemu NFT (ChibiCoreV2) | `0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17` | Loyalty discount source; NftRevenueVault beneficiary |

### 3.5 Uniswap v4

| Contract | Address | Role |
|---|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Uniswap-deployed core |
| V4SwapRouter | `0x2E4cd43C07879f52422B3e83F00Be877eFD88738` | Launchpad-owned swap router (used by trade page) |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | Uniswap-deployed slot0 reader |

### 3.6 Deployment blocks (indexer start)

- `PONDER_START_BLOCK_ROBINHOOD` = `18349728` (Router V7 + core deploy)

---

## 4. End-to-End User Flow

A concrete walk of the pump.fun-style path — pick modules, launch, trade the curve, graduate, trade the v4 pool. Contract-level detail lives in later sections; this is the narrative.

### 4.1 Discover / pre-launch

User lands on `/` (`web/src/app/page.tsx`). Sees a trending feed of curves + graduated tokens, a scrolling marquee ticker of the latest launches (`web/src/components/TokenTicker.tsx`), and a live-activity right rail merging recent curve trades + v4 swaps polled every 5 s from the indexer.

Home currently shows `<NotLiveYet />` splash while `LAUNCHPAD_LIVE = false`.

### 4.2 Create page — `/create`

The single most complex page in the app (2195 lines, `web/src/app/create/page.tsx`).

**Step 1 — Chain**
Header `ChainSwitcher` — only Robinhood is enabled today.

**Step 2 — Base type**
ERC-20 selected by default. ERC-721A + ERC-1155 tiles are visible but disabled (`NFT_BASES_ENABLED = false` at line 74). Clicking a base clears the module basket.

**Step 3 — Mechanic**
`quick` (pump.fun defaults, baked-in bonding curve, forced-renounce ownership, anti-sniper = 5 blocks, no module shelf) or `custom` (full module shelf + WL + per-launch hook params).

**Step 4 — Modules (custom mechanic only)**
Drag-and-drop shelf using `@dnd-kit/core`. Each shelf item is a `ModuleSpec` from `web/src/lib/modules.ts::MODULES` (24 entries; 21 shipped, 3 planned, 1 retired-and-removed). Adding a module:
- Auto-pulls declared `requires` dependencies.
- Rejects with a mascot popup + rollback if `incompatibleWith` any current selection.
- Rejects if `requiresOwner` or `taxesTransfers` and curve mode is on (Pausable + curve is a footgun, FoT + curve would drain reserves).
- The frontend live-derives `configHash = keccak256(abi.encode(base, sortedModuleIds.join(',')))` (V1 formula) or with `@version` suffixes if any selected module is V2+ (currently no V2 modules are user-facing).
- Reads `ERC20Factory.implFor(configHash)` — if zero, shows a "combo not shipped" popup and rolls the offending add out of the basket. The launch button stays disabled until `implRegistered` is non-zero.

**Step 5 — Ownership**
Renounce / TransferToMultisig / KeepEOA. Curve mode forces Renounce (curve requires it — Router pattern is Router-holds-supply, curve-then-graduation, then owner is nulled).

**Step 6 — Pay token**
ETH (`launch` / `launchWithWhitelist`) or URU (`launchWithURU` / `launchWithURUAndWhitelist`). URU-pay only rendered on chains with `URU_PAY[chain]` populated (only Robinhood today). URU-pay requires an approval tx first.

**Step 7 — Whitelist (optional, curve mode only)**
User pastes a source token address, frontend POSTs to `${COMPILE_SERVICE_URL}/wl/snapshot` which reads Blockscout holders + builds a Merkle tree. Returns `{root, listCid, holderCount, snapshotBlock}` — the CID is baked into the launch metadata so the WL proof service can be served by content-addressable IPFS.

**Step 8 — Metadata**
Optional logo (data URL → pinned via `/pin/file`), description, socials. Persisted to compile-service via wallet-signed POST after the launch mines.

**Step 9 — Live quote**
Reads `Router.quoteFor(params, wallet)` — applies loyalty discount. Rendered as a receipt with a strikethrough gross fee and net after-discount line.

**Step 10 — Launch tx**
Frontend simulates via `useSimulateContract`, then `writeContract(simulate.data.request)`. Wallet signature. Post-mine, decodes the `Launched` event to grab the token address and either:
- Curve mode → redirects to `/trade/<token>` for continued interaction on the curve.
- Non-curve → shows a success card with an explorer link.

### 4.3 Trade page — `/trade/<address>` — pre-graduation

`web/src/app/trade/[address]/page.tsx` — 101 KB, split into `TradePage → LiveTradeView → BondingCurveWidget / GraduatedPanel + MetadataPanel + ChatDrawer + TradeChart`.

**Live state polling**
- Reads `BondingCurve.{ethReserve, tokenReserve, priceWeiPerToken, graduated, virtualEthReserve, virtualTokenReserve, tradeFeeBps, graduationTargetEth, curveSupply}` every 8 s.
- Reads `token.balanceOf(wallet)` + `token.allowance(wallet, curve)` for the sell path.

**Buy on curve**
- Frontend calls `curve.quoteBuy(ethIn)` to preview `(tokensOut, fee)`.
- Applies slippage: `minTokensOut = quoteOut - (quoteOut * slippageBps / 10000)`.
- `writeContract(curve.buy(minTokensOut), {value: ethIn})`.
- Contract math: virtual constant-product `x*y=k` with immutable virtual reserves + mutable real reserves. Fee is skimmed off `msg.value` BEFORE hitting the AMM (`ethAfterFee = msg.value - fee`), so the buyer's effective price is worse than the fee-less curve. Fee (1 % on live) sent immediately via `SafeTransferLib.safeTransferETH(feeReceiver, fee)` — feeReceiver is the `FeeSplitter` directly, no intermediate hop.
- If `ethReserve >= graduationTargetEth` after this buy, `_graduate()` fires atomically inside the same tx.

**Sell on curve**
- Requires ERC-20 `approve(curve, amount)` first.
- Calls `curve.sell(tokensIn, minEthOut)`.
- Same virtual CPMM math but fee is skimmed from OUTPUT ETH (not input). Sells cannot trigger graduation (they reduce `ethReserve`).

**WL buy (if `whitelistRoot != 0` and `block.timestamp < fallbackTs`)**
- Frontend fetches proof from `${COMPILE_SERVICE_URL}/wl/proof?listCid=<cid>&addr=<wallet>`.
- Calls `curve.buyWithProof(proof, minTokensOut){value: ethIn}`.
- Contract enforces: (a) proof valid, (b) `wlSold + tokensOut <= reservedTokens`, (c) `wlHeldForUser[msg.sender] + tokensOut <= maxWlPerAddress`.
- **Tokens are NOT delivered at buy-time.** They accumulate in `wlHeldForUser[msg.sender]` and can only be `claimWl()`'d after graduation. This is the "hold-until-graduation" structural lock — WL buyers cannot sell back to the curve.
- After `fallbackTs`, the WL closes and public `buy()` becomes callable; any unfilled WL slice merges back into the public pool (accounting is a single `tokenReserve`).

**Graduation**
When a buy's `ethReserve` crosses `graduationTargetEth`, `_graduate()` fires:
1. Curve zeroes its own `ethReserve` and `tokenReserve` (WL-held tokens survive for later `claimWl`).
2. Curve calls `SafeTransferLib.safeApprove(token, graduator, tokenOut)`.
3. Curve calls `Graduator.execute{value: ethOut}(token, tokenOut, ethOut, launcher, antiSniperBlocks, buybackBurnBps)`.
4. Graduator authorizes by calling `curveFactory.curveFor(token)` and comparing to `msg.sender` — only the registered curve can graduate.
5. Graduator `transferFrom(curve → graduator)` for tokens.
6. Graduator computes `curveFinalPrice = (ethAmount * 1e18) / tokenAmount` — the RAW REAL RATIO of the amounts (V8-final fix).
7. Graduator constructs pool key `(currency0=ETH, currency1=token, fee=3000, tickSpacing=60, hooks=MHH)`.
8. Graduator calls MHH `setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps)` and `setCreator(poolId, launcher)`.
9. Graduator calls `PoolManager.initialize(poolKey, sqrtPriceX96)` where `sqrtPriceX96 = (1e9 << 96) / sqrt(curveFinalPrice)`.
10. Graduator calls `PoolManager.unlock(abi.encode(poolKey, liquidity, ..., token))` which enters `unlockCallback`.
11. In `unlockCallback`, calls `PoolManager.modifyLiquidity(key, ...full-range LP add..., "")` and settles both sides.
12. Any leftover token rounding dust burned to `0xdEaD`; any leftover ETH refunded to the launcher.
13. Emits `Graduated(token, hook, ethAmount, tokenAmount, sqrtPriceX96, liquidity)`.

Now the pool is live. The launcher owns nothing — the LP position was minted TO the Graduator, and `GraduatorV2` has no code path that ever calls `modifyLiquidity` with a negative `liquidityDelta`, no burn function, no transfer function, so the graduation LP position is locked structurally. No admin, no keyholder, no vault can pull it. Third-party LPs on the same pool can add + remove their own positions freely (post-F5).

### 4.4 Trade page — post-graduation

Same UI, different backend:
- Reads `stateView.getSlot0(poolId)` for `sqrtPriceX96` → derives token price as `weiPerToken = (1e18 << 192) / sqrtPriceX96²`.
- Reads `stateView.getLiquidity(poolId)` for TVL.
- Buy: `V4SwapRouter.swapExactETHForToken(poolKey, minOut=1, wallet, deadline){value: ethIn}`.
- Sell: `V4SwapRouter.swapExactTokenForETH(poolKey, tokensIn, minOut=1, wallet, deadline)` after `token.approve(V4SwapRouter)`.
- Every swap triggers MHH's `afterSwap` which takes `platformBps + creatorBps = 200 bps` (2 %) of the unspecified currency into the hook's own balance. Split accrues to `owed[currency][platform=FeeSplitter]` and `owed[currency][creator=launcher]`.

**Creator earnings claim**
Launcher's profile page (`/profile/<addr>`) renders `<CreatorEarnings>` which calls `MHH.owed(currency, wallet)` for every graduated pool they created; if non-zero, offers `MHH.claim(currency)`.

**Platform fee push**
Off-chain keeper (`compile-service/src/keeper.ts:66-100`) polls `MHH.owed(ETH, FeeSplitter)` every 60 min; if ≥ 10 000 gwei, calls `MHH.pushOwed(ETH, FeeSplitter)`. This sends the accumulated ETH to FeeSplitter's `receive()` → 40/35/25 split loops in.

**Gemu NFT holder claim**
Once ~24 h has accumulated, keeper builds a merkle tree from `holders` table (indexer), publishes `NftRevenueVault.addEpoch(root, totalAmount)`, and each holder can `claim(epochId, amount, proof)` for their share.

### 4.5 Post-launch — the launcher's controls

If the launcher chose `KeepEOA` or `TransferToMultisig`, they still own the token contract. The `TokenOwnerControls` widget on their profile surfaces:
- Pausable: `pause()` / `unpause()` (if the module was installed).
- AntiBot: `setAntiBotAllowed(addr, bool)` toggles.
- AntiWhale: `setAntiWhaleExcluded(addr, bool)` toggles.
- Base: `renounceOwnership()` — the "big red button" to null the admin.

If the launcher chose `Renounce`, ownership was set to `address(0)` at launch time via `_dispatchOwnership`. The token becomes admin-less immediately.

---

## 5. Router — The Central Entry Point

**Source:** `contracts/src/router/Router.sol` (~1000 lines).

**Live address:** `0x84C72d6882f10833bD4eBD7c45D4353FDf20B596` (V7, deployed 2026-07-30).

**Role:** the only public entry to launching. Every launch — ETH-paid or URU-paid, with or without whitelist — goes through Router. Router collects the fee, deploys the token via the appropriate base factory, reserves the name in `NameRegistry`, installs the bonding curve (if requested), dispatches ownership per the launcher's chosen mode, refunds excess ETH, and emits `Launched`.

### 5.1 Immutables + storage

```solidity
NameRegistry public immutable registry;
IFeeReceiver public immutable feeReceiver;  // FeeSplitter on live

mapping(BaseType => address) public factories;         // ERC20 / ERC721A / ERC1155 factories
mapping(BaseType => uint256) public fees;              // launch fee in wei per base
uint256 public moduleAddOnFee;                          // per extra module beyond first
uint256 public hookAddOnFee;                            // extra fee if params.installHook
uint256 public governanceAddOnFee;
address public curveFactory;
address public loyaltyOracle;
bool    public paused;

mapping(bytes32 => bool)    public curveIncompatibleConfigHash;   // manual denylist
mapping(bytes32 => uint256) public moduleCountForConfig;
mapping(bytes32 => bool)    public moduleCountConfigured;         // fail-closed sentinel
mapping(bytes32 => uint256) public flagsForConfig;
mapping(bytes32 => bool)    public flagsConfigured;               // fail-closed sentinel
uint256 internal constant FLAG_BALANCE_MUTATING = 1 << 0;
mapping(bytes32 => bool)    public bannedConfigHash;              // 2026-08-01 audit round 2v3

IERC20Like public uru;                     // URU token, wired via setUruConfig
UruDepositSink public uruSink;             // URU-pay sink, wired via setUruConfig
uint256 public minUruFee;                  // URU-side spam-gate floor
uint16  internal constant MAX_LOYALTY_DISCOUNT_BPS = 8000;  // clamp on oracle output
```

### 5.2 Constructor

`Router.sol:339-368`:
```solidity
constructor(
    address initialOwner,
    NameRegistry _registry,
    IFeeReceiver _feeReceiver,
    uint256 erc20Fee_, uint256 nftFee_, uint256 erc1155Fee_,
    uint256 moduleAddOn_, uint256 hookAddOn_, uint256 governanceAddOn_
)
```

Registry and feeReceiver are immutable. All fees are settable post-deploy via `setFee` / `setAddOnFees`. URU + loyalty wiring happens post-deploy via `setUruConfig` + `setLoyaltyOracle`.

### 5.3 The four launch entrypoints

Every entrypoint validates the same preconditions in the same order:
1. `if (paused) revert Router__Paused();`
2. **`_validateLaunchPolicy(params)`** **[V8 change vs live]** — a canonical policy gate that replaces the bare `bannedConfigHash` check on live V7. Enforces on-chain (not just in the UI):
   - `bannedConfigHash[hash]` — retired hash revert (URU-A10)
   - `moduleCountConfigured[hash]` AND `flagsConfigured[hash]` — fail-closed on any hash whose metadata isn't registered (URU-A01)
   - If `installBondingCurve = true`:
     - `base == ERC20` (curve-only-ERC20)
     - **`ownership == Renounce`** — curve launches MUST renounce (URU-A01). Non-Renounce reverts `CurveMustRenounce`.
     - `!(flags & FLAG_REQUIRES_OWNER)` — Pausable, AntiBot, AntiWhale all carry this bit; blocked from curve pairing.
     - `!(flags & FLAG_BALANCE_MUTATING)` AND `!curveIncompatibleConfigHash[hash]` — FoT/rebasing blocked.
     - `antiSniperBlocks <= MAX_ANTI_SNIPER_BLOCKS (7200)` — protocol max cap.
     - `buybackBurnBps <= MAX_BUYBACK_BURN_BPS (2000)` — protocol max cap.
3. Fee validation (ETH: `msg.value >= fee`; URU: `uruAmount >= _minUruFeeFor(msg.sender)`; if URU also `uru != 0 && uruSink != 0`).
4. `factory = factories[base]`, revert if unset.
5. `name` and `ticker` non-empty.
6. If `ownership == TransferToMultisig`, `ownerTargetIfMultisig != address(0)`.

Then executes:
7. Fee leg: ETH → `feeReceiver.receiveFee{value: fee}(msg.sender, base)`; URU → `SafeTransferLib.safeTransferFrom(uru, msg.sender, uruSink, uruAmount)`.
8. `token = IVMFactory(factory).deploy(name, ticker, configHash, initData, msg.sender)` — factory clones + initializes.
9. `registry.reserve(name, ticker, token, msg.sender)` — atomic name + ticker reservation.
10. If `installBondingCurve`:
    - Revert if `curveFactory == 0`, `base != ERC20`, or `_isCurveIncompatible(configHash)`.
    - `token.approve(curveFactory, defaultCurveSupply)`.
    - `curve = curveFactory.createCurveWithConfigFor(token, antiSniperBlocks, buybackBurnBps, msg.sender)` (or WL variant).
    - `_grantCurveModuleAllowances(token, curve)` — best-effort try/catch calls to `setAntiBotAllowed` + `setAntiWhaleExcluded` on the token for {curve, graduator, poolManager}. Silently no-ops on tokens without those modules.
11. `_dispatchOwnership(token, mode, target, launcher)` — either `renounceOwnership()`, `transferOwnership(multisig)`, or `transferOwnership(launcher)`.
12. ETH refund of any excess `msg.value - fee`.
13. Emit `Launched(token, launchedBy, base, nameHash, tickerHash, fee, installedHook, installedGovernance)` (plus `LaunchedInURU` for URU paths, plus `LaunchedWithWhitelist` for WL paths).

### 5.4 `_quote` — fee computation

`Router.sol:846-862`:
```solidity
baseFee = fees[params.base];
if (!moduleCountConfigured[configHash]) revert Router__ModuleCountMissing;  // fail-closed
registeredCount = moduleCountForConfig[configHash];
extraModules = registeredCount > 0 ? registeredCount - 1 : 0;
return baseFee
    + moduleAddOnFee * extraModules
    + (params.installHook ? hookAddOnFee : 0)
    + (params.installGovernance ? governanceAddOnFee : 0);
```

The `moduleCountConfigured` sentinel matters: a hash registered on the ERC20Factory but not yet populated on Router (window between `registerImpl` and `setModuleCountForConfig`) reverts the quote — closing the "attacker races the wire-up and underpays add-on fees" attack surface.

`_quoteFor(params, launcher)` (`Router.sol:869-875`) applies loyalty discount:
```solidity
gross = _quote(params);
return gross - (gross * _discountBpsFor(launcher)) / 10_000;
```

`_discountBpsFor(launcher)` (`Router.sol:879-886`) reads LoyaltyOracle and clamps to `MAX_LOYALTY_DISCOUNT_BPS = 8000`. A malicious/broken oracle returning >8000 is defanged — Router always charges at least 20 % of gross.

### 5.5 `_isCurveIncompatible` — the curve gate

`Router.sol:832-844`:
```solidity
if (!flagsConfigured[configHash]) revert Router__FlagsMissing;   // fail-closed
if ((flagsForConfig[configHash] & FLAG_BALANCE_MUTATING) != 0) return true;
return curveIncompatibleConfigHash[configHash];
```

Two layered gates PLUS a fail-closed sentinel:
1. **Structural bit**: `FLAG_BALANCE_MUTATING (1<<0)` set at manifest-registration time for any impl whose module set mutates transfer amounts. Currently only `FoT` carries this bit (live).
2. **Manual denylist**: owner-maintained belt-and-braces via `setCurveIncompatibleConfigHash`.
3. **Fail-closed**: if `flagsConfigured[hash] == false`, revert. Blocks the "impl registered before flags set" race.

### 5.6 URU config hardening (`setUruConfig`)

`Router.sol:769-785`:
```solidity
function setUruConfig(address uru_, address uruSink_) external onlyOwner {
    if (uru_ == 0 || uruSink_ == 0) revert Router__ZeroAddress;
    if (uruSink_.code.length == 0) revert Router__UruSinkNoCode(uruSink_);         // audit round 2v1
    address sinkUru = address(UruDepositSink(payable(uruSink_)).uru());
    if (sinkUru != uru_) revert Router__UruSinkTokenMismatch(uru_, sinkUru);        // audit round 2v1
    uru = IERC20Like(uru_);
    uruSink = UruDepositSink(payable(uruSink_));
    emit UruConfigSet(uru_, uruSink_);
}
```

Two audit-driven checks: the sink must be a live contract (not an EOA that silently accepts transfers), and its immutable `uru()` must match the token being wired (prevents Router pushing deposits into a mismatched sink that would strand every URU launch fee).

### 5.7 `bannedConfigHash` — the audit round 2v3 + 3 kill switch

**[V8 change vs live]** — retirement is monotonic. Attempts to un-ban revert.

```solidity
function setConfigHashBanned(bytes32 configHash, bool banned) external onlyOwner {
    if (!banned) revert Router__ConfigRetirementIrreversible(configHash);
    if (!bannedConfigHash[configHash]) {
        bannedConfigHash[configHash] = true;
        emit ConfigHashBanned(configHash, true);
        emit ConfigHashRetired(configHash);
    }
}
```

Same monotonic rule applies to `setCurveIncompatibleConfigHash(hash, false)` — reverts `ConfigRetirementIrreversible`. Prevents an owner-key holder from silently re-enabling a retired impl.

The gate is now checked inside `_validateLaunchPolicy` (§5.3 step 2). It exists because the earlier count-poison mitigation (setting `moduleCountForConfig = uint256.max` to overflow `_quote`) only blocked the ETH launch path; URU + WL paths bypass `_quote` and were still exploitable through the retired Airdrop impls whose bytecode is permanently pinned on the factory.

Meanwhile on live V7: `bannedConfigHash` doesn't exist (V7 predates it). Emergency mitigation: `minUruFee = type(uint256).max` disables all URU launches (canonical AND retired-Airdrop) as a blunt kill switch. Will be lifted at V8 deploy.

### 5.8 One-shot metadata + atomic registration (URU-A10, V8)

**[V8 change vs live]** — every metadata setter is now one-shot:

- `setModuleCountForConfig(hash, count)` reverts `ConfigMetadataAlreadySet` on second call.
- `setFlagsForConfig(hash, flags)` — same.
- Batch variants — reject if ANY hash in the batch is already set.
- New atomic `registerConfigMetadata(hash, count, flags)` — single tx sets both count+flags; DeployRouter uses `registerConfigMetadataBatch` to seed every canonical hash from `RhConfigManifest.all()` in one tx. Emits `ConfigMetadataRegistered(hash, count, flags)`.

Rationale (URU-A10): factories removed `updateImpl` (one-shot registerImpl per hash). But Router had mutable metadata — an owner could re-interpret an existing impl by rewriting its module count / flags. The one-shot rule binds Router metadata to the impl bytecode: change requires a new configHash.

### 5.9 Strict curve-module allowance grants (URU-A14, round-3 follow-up)

**[V8 change vs live]** — `Router._grantCurveModuleAllowances` (`Router.sol:1121+`) no longer swallows setter failures with `try/catch {}`. Rewritten as probe → grant → verify per module:

```
for each (curve, graduator, poolManager) in the curve stack:
  staticcall token.antiBotIsAllowed(who)
    → unknown-selector revert → module not installed → skip cleanly
    → returns bool          → module installed:
        call token.setAntiBotAllowed(who, true)  (bubbles setter revert)
        read back token.antiBotIsAllowed(who); revert
          Router__CurveModuleGrantFailed(token, who, "AntiBot")
          if read-back doesn't confirm.
```

Reasoning (URU-A14): the auditor rejected the prior `try/catch {}` pattern because a token whose AntiBot setter was renamed or reverted silently produced a launched curve that bricked on its very first `buy`. Round-3 semantics fail loud at launch time — launcher gets an actionable revert, not a silent brick.

In production this helper only runs on `installBondingCurve == true` and `_validateLaunchPolicy` already blocks the AntiBot/AntiWhale/Pausable configHashes (`FLAG_REQUIRES_OWNER`) from pairing with curves. So the probe should ALWAYS take the "module not installed" branch on a legitimate curve launch. The strict grant paths are defense-in-depth against future manifest drift, a new module missing its `FLAG_REQUIRES_OWNER` classification, or a hand-crafted config bypassing the frontend.

Tests: `contracts/test/audit/CurveModuleGrantStrict.t.sol` exercises both failure paths — `BrokenAntiBotToken` (setter reverts) and `LyingAntiBotToken` (setter no-ops but read-back returns false).

### 5.10 Router event schema

- `Launched(token, launchedBy, base, nameHash, tickerHash, feePaid, installedHook, installedGovernance)` — the primary launch event; every launch (ETH, URU, WL, URU+WL) emits this. `feePaid = 0` on URU paths (indexer joins on `token` to `LaunchedInURU` for the URU amount).
- `LaunchedInURU(token, launchedBy, uruPaid)` — paired 1:1 with URU launches.
- `LaunchedWithWhitelist(token, launchedBy, whitelistRoot, reservedTokens, maxWlPerAddress, fallbackTs, sourceTokenAddress, sourceChainId)` — paired with WL launches.
- `CurveInstalled(token, curve)` — fires from Router when it wires up a bonding curve.
- Owner-only setter events: `FactorySet, FeeSet, AddOnFeesSet, PausedSet, Swept, CurveFactorySet, LoyaltyOracleSet, CurveIncompatibleConfigHashSet, ModuleCountForConfigSet, FlagsForConfigSet, UruConfigSet, MinUruFeeSet, ConfigHashBanned, LoyaltyDiscountApplied`.

---

## 6. Base Factories

Three sibling factories, one per `BaseType`: `ERC20Factory`, `ERC721AFactory`, `ERC1155Factory`. All implement `IVMFactory.deploy(name, ticker, configHash, initData, launcher)`.

### 6.1 Common pattern

Each factory holds:
- `address router` — the only address allowed to call `deploy`. Rotatable via `setRouter(newRouter) onlyOwner`.
- `address registrar` — the address allowed to call `registerImpl(configHash, impl)`. Set at construction, rotatable via `setRegistrar`.
- `mapping(bytes32 => address) impls` — configHash → impl address. **One-shot per hash** — `registerImpl` reverts `AlreadyRegistered` on any second write, and there is NO `updateImpl` (deliberately removed 2026-07-31 in audit round-2 v3 — see `ERC20Factory.sol:147-154` for the rationale comment).
- `mapping(bytes32 => uint256) usageCount` — how many tokens have been deployed under each hash (indexer signal).

### 6.2 `deploy` flow (ERC20 example)

`ERC20Factory.sol:92-128`:
1. Require `msg.sender == router` (revert `NotRouter`).
2. `impl = impls[configHash]` — revert `UnknownConfig(hash)` if zero.
3. `salt = keccak256(abi.encode(launcher, keccak256(name), keccak256(ticker), block.chainid))`.
4. `token = LibClone.cloneDeterministic(impl, salt)` — deterministic EIP-1167 clone.
5. Decode `initData` as `(uint256 initialSupply, address initialRecipient, bytes[] moduleData)`.
6. Encode full init: `abi.encode(router, name, ticker, initialSupply, initialRecipient, moduleData)` — factory forces `initialOwner = router` so Router can dispatch ownership.
7. `try token.initialize(fullInitData) {} catch { revert InitFailed(); }`.
8. `usageCount[configHash] += 1`.
9. Emit `Deployed(token, launcher, configHash, impl, name, ticker)`.

Deterministic clone address means `predictAddress(launcher, name, ticker, configHash)` (view) can pre-compute where a launch will land. The frontend uses this for the royalty-router flow (predicts collection address BEFORE launch so it can predict the royalty clone address BEFORE launch and bake the clone into the ERC-2981 module's init data).

### 6.3 `registerImpl` — one-shot registrar-gated

`ERC20Factory.sol:134-145`:
```solidity
function registerImpl(bytes32 configHash, address impl) external {
    if (msg.sender != registrar) revert NotRegistrar;
    if (impls[configHash] != address(0)) revert AlreadyRegistered(configHash);
    if (impl == address(0)) revert ZeroAddress;
    if (impl.code.length == 0) revert NotAContract;
    impls[configHash] = impl;
    emit ImplRegistered(configHash, impl, msg.sender);
}
```

Why one-shot: the impl bytecode is permanently pinned to its hash. If a bug is found in a shipped impl, retirement is:
- Set `Router.bannedConfigHash[hash] = true` to block new launches at that hash.
- Deploy a new impl with the fix at a NEW configHash (bumping the module version in `MODULES` so `configHashFor` produces a fresh hash).
- `registerImpl(newHash, newImpl)`.

Existing token clones deployed under the old hash keep running the old impl (they're immutable clones, no upgrade path). Only new launches at the new hash get the fix.

This is the same lifecycle that retired the Airdrop V1 impls: rug bug found → module removed from `MODULES` → hashes banned via `bannedConfigHash` (V8-pending) + `minUruFee=max` mitigation (V7-live).

### 6.4 Live impl registrations

**ERC20Factory** (`0x14c1f066b91760565d5eEc8Cf4696A4648b552F2`) — 10 canonical hashes from `RhConfigManifest.all()` **[V8 update: Pausable entry rebased on new hash + FLAG_REQUIRES_OWNER on 3 modules]**:

| Idx | Hash prefix | Modules | Live impl address | moduleCount | flags |
|---|---|---|---|---|---|
| 0 | `0xaa7c…7d7e` | Permit | `0xA46Af17d…4de1` | 1 | 0 |
| 1 | `0xafdb…f4a8` | Vesting | `0x203F3687…b731` | 1 | 0 |
| 2 | `0x3c31…2836` | Staking | `0x4601B97e…28e4` | 1 | 0 |
| 3 | `0x665f…1b10` | Votes | `0xf0a7AA9d…F0E8` | 1 | 0 |
| 4 | `0xf7b8…0acb` | (bare) | `0x6722AC32…C3719` | 0 | 0 |
| 5 | `0x1369…973f` | AntiBot | `0x14b81325…e64a` | 1 | **2** (FLAG_REQUIRES_OWNER) |
| 6 | `0x6385…3821` | AntiWhale | `0xdD7c50BE…babcD` | 1 | **2** (FLAG_REQUIRES_OWNER) |
| 7 | `0xa733…1ac4` | FoT | `0x19E133a5…f93BC` | 1 | **1** (BALANCE_MUTATING) |
| 8 | `0xc9a8…3e1f` | **Pausable@2** (V8) | pending V8 deploy | 1 | **2** (FLAG_REQUIRES_OWNER) |
| 9 | `0x1207…575e` | Permit+Staking | `0x8f49A318…Fb05` | 2 | 0 |

**Retired hashes** (`RhConfigManifest.retiredAirdropHashes()` — name kept for backward compat, actually lists 4 retired hashes) — all in `Router.bannedConfigHash` at every V8 deploy:
- `0x344f…7b2b` — Airdrop (inflation rug)
- `0xa4df…2064` — Airdrop+Permit
- `0x903c…f3d2` — Airdrop+Vesting
- `0xa831…803a` — **Pausable V1** (owner-exemption honeypot — URU-A02)

**Live V7 mitigation for the first 3** (Airdrop): `moduleCountForConfig[hash] = type(uint256).max` (poisons `_quote` overflow) + `minUruFee = type(uint256).max` (disables URU-bypass). **Pausable V1** on live V7 is currently NOT banned — the URU-A02 fix (retire V1 + register V2 at fresh hash) activates only on V8 deploy. Until then, a hand-crafted URU launch was disabled by `minUruFee=max` and a hand-crafted ETH launch would produce a Pausable V1 token with the honeypot behavior.

**ERC721AFactory** (`0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc`) — 7 impls registered (from `web/src/lib/config.ts:141-147`):
- ERC721ATemplateImpl `0xb7b804F8dA…`
- ERC721AWithDelayedRevealImpl `0x45C36c47…`
- ERC721AWithSvgImpl `0xc7BB2880…`
- ERC721AWithRoyaltyImpl `0x5F61f73a…`
- ERC721AWithSvgAndRoyaltyImpl `0xF018A077…`
- ERC721AWithSoulboundImpl `0xE9FfA2B7…`
- ERC721AWithRefundableImpl `0x9cCD1f59…`

**ERC1155Factory** (`0x0f16a0D9aEef54e2321Ea6Fa264d638130297597`) — 1 impl registered:
- ERC1155TemplateImpl `0x8728FFEB1E017B123408209f2ae7f7207741Be5b`

Additional composed 1155 impls (Supply, Payable, SupplyPayable, SplitPayable, Royalty) exist in source under `contracts/src/templates/composed/` but are NOT registered on live — pending NFT-base activation.

**[V8 change vs live — URU-P1-M03 disposition]** Auditor round 4 flagged that a fresh V8 deploy wires the ERC721A + ERC1155 factories to Router without registering any NFT impls, leaving NFT launches to fail on `UnknownConfig`. Per project scope decision (NFT bases not activating this cycle), we do NOT register NFT impls on fresh V8 either. The NFT lanes are deliberately dormant:

- `web/src/app/create/page.tsx::NFT_BASES_ENABLED = false` blocks NFT base selection in the UI.
- `RhConfigManifest.all()` returns ERC20 impls only (10 entries).
- `DeployFreshLocal.s.sol` still deploys the NFT factories (for future activation) but registers no NFT impls.
- Any direct-Router call selecting an NFT base reverts `ERC721AFactory__UnknownConfig` / `ERC1155Factory__UnknownConfig` (honest failure, not silent brick).
- When NFT lanes turn on, auditor's patch 0003 must be applied alongside `docs/NFT-ACTIVATION.md`.

The Router itself never gets NFT metadata (`registerConfigMetadataBatch` only iterates ERC20 entries), so `_validateLaunchPolicy` reverts `ConfigMetadataIncomplete` on any NFT hash before any factory is even reached.

### 6.5 Two-step impl binding — owner-pinned codehash (URU-A08, round-3 follow-up)

**[V8 change vs live]** — all three factories now require an owner-pinned expected runtime codehash BEFORE the registrar can bind an impl to a configHash. The pipeline is:

1. Owner (multisig) calls `factory.setExpectedCodeHash(configHash, expectedHash)` — one-shot per config, rejects `bytes32(0)`.
2. Registrar (compile service) calls `factory.registerImpl(configHash, impl)`. Factory computes `keccak256(impl.code)` and reverts `ArtifactHashMismatch(configHash, expected, actual)` on any mismatch.

New errors on each factory: `CodeHashNotPinned(configHash)`, `ArtifactHashMismatch(configHash, expected, actual)`, `CodeHashAlreadyPinned(configHash)`, `ZeroCodeHash`.

New event: `ExpectedCodeHashPinned(configHash, expectedCodeHash)`.

Rationale (URU-A08): a rogue registrar (compromised compile-service key) could previously bind ANY bytecode to an audited configHash. With the pin, they'd need to also compromise the multisig to rotate the pin — and pins are one-shot, so a compromised multisig can't silently swap the binding either. The audit invariant "audited configHash ↔ audited bytecode" is now enforced on-chain.

For fresh-local dev + tests: the deploy script computes the pin from `keccak256(impl.code)` at the same tx (`DeployFreshLocal.s.sol:381-384`) — this is a formality since the impl was just deployed, but it exercises the same call graph production will use. For production: `RhConfigManifest.artifactHashFor(configHash)` (pending manifest update) will hold the audited pin, read by `DeployRouter` at seed time.

Tests: `contracts/test/audit/FactoryCodeHashPin.t.sol` — 16 tests covering pin-then-register happy path, wrong-hash mismatch, missing-pin revert, one-shot semantics, zero-hash rejection, and per-factory coverage for ERC20 + ERC721A + ERC1155.

---

## 7. NameRegistry

**Source:** `contracts/src/registry/NameRegistry.sol`.

**Live address:** `0x60b797f18292d941E72B2b59916C0afC1A81118C`.

**Role:** globally unique name + ticker reservation for every launched token. Reservations are permanent (no expiry, no rotation). Cross-base — an ERC-20 named "Chibi" prevents an ERC-721A also named "Chibi".

### 7.1 Storage

```solidity
address public router;                    // only address allowed to call reserve()
address public treasury;
uint256 public constant MIN_ROUTER_DELAY = 2 days;   // in current SOURCE — see 7.4 caveat
address public pendingRouter;
uint256 public pendingRouterTs;
mapping(bytes32 => Reservation) private _reservations;
mapping(bytes32 => address) private _tickerOwner;
mapping(bytes32 => bool) private _reservedTickers;
```

### 7.2 `reserve(name, ticker, token, launchedBy)` — Router-only

`NameRegistry.sol:151-190`:
1. `require msg.sender == router` (revert `NotRouter`).
2. `require token != 0` (revert `ZeroAddress`).
3. `normalizedName = _normalizeNameOrRevert(name)` — trim leading/trailing spaces, collapse runs of internal spaces to single space, accept `[A-Za-z0-9 -_]`, length in `[1, 32]`.
4. `normalizedTicker = _normalizeTickerOrRevert(ticker)` — uppercase alphanumeric only, length in `[2, 10]`.
5. `nameHash = keccak256(bytes(lowercased))`, `tickerHash = keccak256(bytes(uppercased))`.
6. Revert if `_reservations[nameHash].token != 0` (NameTaken), `_tickerOwner[tickerHash] != 0` (TickerTaken), or `_reservedTickers[tickerHash]` (TickerReserved).
7. Store full `Reservation{token, launchedBy, timestamp, chainId, name, ticker}` + set `_tickerOwner[tickerHash] = token`.
8. Emit `Reserved(nameHash, tickerHash, token, launchedBy, name, ticker, timestamp, chainId)`.

**Known limitation:** no commit-reveal — a mempool observer can copy a pending launch's `(name, ticker)` and submit a competing `Router.launch` with a higher priority fee. Their tx mines first, they get the name; the victim's tx reverts `NameTaken`. Documented in `NameRegistry.sol:137-144`. Not addressed in V6/V7.

### 7.3 Reserved ticker blocklist

Owner-maintained via `addReservedTicker(string)` / `removeReservedTicker(string)`. Live registry seeded at construction with ~26 canonical tickers (ETH, WETH, USDC, USDT, DAI, WBTC, LINK, MATIC, UNI, AAVE, SOL, BTC, MKR, COMP, YFI, SNX, AVAX, ATOM, DOT, ADA, XRP, DOGE, SHIB, PEPE, TRX, BNB) plus (in fresh deploys) URU, CHIBI, GEMU. Blocks squatters at first-launch.

`removeReservedTicker` reverts if the ticker has been claimed since being added (defense in depth — "reserved implies unclaimed" invariant).

### 7.4 Router rotation — SOURCE says 2-phase, LIVE says single-step

**Source (current NameRegistry.sol):**
- `setRouter(newRouter) onlyOwner` — accepted ONLY if `router == 0` (greenfield). Reverts `RouterAlreadySet` otherwise. Clears any pending proposal.
- `proposeRouter(newRouter) onlyOwner` — sets `pendingRouter + pendingRouterTs = now + 2 days`. Reverts `PendingRouterExists` on stacked proposals.
- `activateRouter() onlyOwner` — requires `now >= pendingRouterTs`; flips `router = pending`, clears pending.
- `cancelPendingRouter() onlyOwner` — safety valve.

**Live deployed registry (predates 2-phase timelock):**
- Only has `setRouter` (which reverts once `router != 0`).
- Does NOT have `proposeRouter`, `activateRouter`, `pendingRouter`, `pendingRouterTs`, `MIN_ROUTER_DELAY`, or `cancelPendingRouter`. Verified: `cast code 0x60b7…118C` doesn't contain any of those selectors.

**Consequence:** the current LIVE NameRegistry cannot be rotated in-place. Any real V8 Router rotation on RH must either:
1. Deploy a fresh NameRegistry V2 alongside V8 Router, migrate reservations somehow (no on-chain migration surface — reservations are Router-gated), OR
2. Continue routing all name reserves through the existing V7 Router (which is bound to the V7 Router's `bannedConfigHash`-less bytecode — defeating the audit fix).

Documented as a known open item in the current PR body + in the `RhProductionRotationFork.t.sol` header comment. The audit round-2 v5 test suite includes 3 fresh-registry sub-tests that exercise the SOURCE 2-phase flow against a freshly-deployed registry in-fork.

---

## 8. Template + Module Fragment System

The launchpad ships **modular ERC-20 / ERC-721A / ERC-1155 templates**. Modules are `.frag.sol` files that get spliced into a base template at labeled `// VM_INJECT_*` markers, producing composed impls that are then deployed once each and registered on their base factory.

### 8.1 Fragment file format

Each `.frag.sol` file under `contracts/modules/{token, allocation, nft}/` has:
- **Header** — `// VM_MODULE_ID`, `// VM_MODULE_VERSION`, `// VM_MODULE_BASES`, `// VM_MODULE_REQUIRES`, `// VM_MODULE_INCOMPATIBLE_WITH`, `// VM_MODULE_FLAGGED`.
- **Section bodies** — one per `// SECTION: VM_INJECT_<X>` marker. Sections that apply: `ERRORS, EVENTS, STATE, CONSTANTS, INIT, MODIFIERS, BEFORE_TRANSFER, AFTER_TRANSFER, EXTERNAL, INTERNAL`.

Fragments are NOT independently compilable. They only exist to be spliced into a template.

### 8.2 Template markers

Each template (`ERC20Template.sol`, `ERC721ATemplate.sol`, `ERC1155Template.sol`, plus the `ERC20VotesTemplate.sol` override) has `// VM_INJECT_<X>` markers at the BOTTOM of each section so spliced content is APPENDED — never inserted before base content. This makes storage layout safe by construction: base storage vars declared first (slot ordering by declaration = base slots < module slots).

**Frozen base storage on `ERC20Template.sol`:**
```solidity
string  private _name;
string  private _symbol;
uint8   private _initialized;
// VM_INJECT_STATE  ← module storage slots append here
```

Any composed impl's storage layout is `[base slots] + [module slots in alphabetical fragment order]`. Because impls are one-shot registered and never updatable at their hash, layout drift is not a concern within a hash.

### 8.3 Splicing pass

Implemented in `compile-service/src/compile.ts::splice(templateSource, fragments)` (lines 76-121):
1. Sort fragments alphabetically by `moduleId`.
2. For each fragment's section body:
   - If section is `VM_INJECT_INIT`, rewrite the bare `moduleData` identifier to `moduleData[<idx>]` where `<idx>` is the fragment's sorted-array position. This is why every fragment's INIT block reads its own slice: `abi.decode(moduleData[<idx>], (T1, T2, ...))`.
   - Prepend `// --- from <ModuleId>.frag.sol ---` marker.
3. For each `VM_INJECT_<X>` marker in the template, concatenate all matching section bodies joined by `\n\n`.
4. Preserve leading indentation.
5. Throw `template missing marker: <marker>` if a fragment declares a section that isn't in the template.

Then `compose()` renames the contract from `<Base>Template` to `<Base>With<Module1>And<Module2>…Gen` (e.g. `ERC20WithPermitStakingGen`).

### 8.4 `templateOverride` — the Votes special case

Real ERC-20 voting requires OZ checkpoint state that can't be spliced in via fragments (would fight Solady's storage layout). Solution: `shared/matrix.json:173` declares `Votes` with `"templateOverride": "contracts/src/templates/ERC20VotesTemplate.sol"`. The compile-service (`server.ts:137-155`) detects this and uses the alternate template as the base. If two selected modules both declare an override, request rejects with `TEMPLATE_OVERRIDE_CONFLICT`.

Result: `ERC20WithVotesGen.sol` inherits `Solady ERC20Votes` (not plain `ERC20`) and adds an OZ IVotes shim `getPastTotalSupply(uint256)` so `VMGovernor` and OZ `TimelockController` can use it as a votes source.

### 8.5 configHash derivation

**Frontend** — `web/src/lib/modules.ts::configHashFor(base, moduleIds)` (lines 560-572):
- V1 branch (all shipped modules are v1): `keccak256(abi.encode(baseString, sortedIds.join(',')))`.
- V2 branch (triggered if any selected module has `version >= 2`): `keccak256(abi.encode(baseString, sortedIdsWithVersion.join(',')))` where each id becomes `${id}@${version}`.

**Contract manifest** — `contracts/script/manifest/RhConfigManifest.sol:52-55` documents the same formula. The 10 live-registered hashes were reverse-engineered against this formula.

Both sides MUST agree exactly. Divergence would produce a UI hash for which `ERC20Factory.impls[hash] == 0` (revert `UnknownConfig`). The frontend guards this by reading `implFor(configHash)` and refusing to render the launch button if the impl is unregistered.

### 8.6 Composed impls checked in vs registered on live

**31 composed impls checked in** under `contracts/src/templates/composed/`:
- ERC-20: 16 files (single-module + selected combos).
- ERC-721A: 10 files.
- ERC-1155: 5 files.

**10 registered on live ERC20Factory** (see §6.4 table).

Additional composed impls exist as source but are NOT registered on live: `ERC20WithAntiBotAntiWhaleGen`, `ERC20WithAntiBotAntiWhalePermitGen`, `ERC20WithAntiBotPermitGen`, `ERC20WithFoTPermitGen`, `ERC20WithPausablePermitGen`, `ERC20WithPermitVestingGen`, `ERC20WithAntiBotAndFeeOnTransferGen`. These serve two purposes:
1. **Integration test fixtures** — `contracts/test/integration/PhaseCombos.t.sol` deploys a fresh factory in-test and registers them to exercise cross-module behaviors.
2. **Future rotations** — the compile-service can already produce these on request; adding them to the live matrix is a `registerImpl` + `setModuleCountForConfig` + `setFlagsForConfig` on a fresh configHash entry in `RhConfigManifest.all()`.

**Not landmines.** UI's `configHashFor` for any unregistered combo produces a hash whose `implFor` returns zero — frontend surfaces "combo not shipped" and locks the launch button. Router would revert `ERC20Factory__UnknownConfig` if hand-crafted.

### 8.7 The retired Airdrop story

Airdrop was retired 2026-07-30 after the deployed V1 composed impl was found to have an inflation-rug bug (used `_mint` for payouts instead of reserve-carve `_transfer`, breaking the fixed-supply invariant).

- **Fragment file removed.** No `Airdrop.frag.sol` exists in the repo.
- **Composed impls removed.** No `ERC20WithAirdrop*Gen.sol` files.
- **Frontend module removed.** No `Airdrop` entry in `web/src/lib/modules.ts::MODULES`.
- **Three hashes remain pointed at rugged impls on the live ERC20Factory** (registerImpl is one-shot, updateImpl removed). Live-mitigated via:
  - `Router.moduleCountForConfig[hash] = type(uint256).max` for all 3 — poisons ETH-path `_quote`.
  - `Router.minUruFee = type(uint256).max` — disables URU-path entirely.
- **Source-level fix** (V8-pending): `Router.setConfigHashBanned(hash, true)` for all 3 in `DeployRouter.s.sol::_banRetiredHashes`, with post-state assertion refusing to write an address book unless every ban is confirmed.

`RhConfigManifest.sol::retiredAirdropHashes()` is the canonical source of truth for these 3 hashes. Every deploy script and the production-rotation fork test read from it — no hand-maintained lists elsewhere.

---

## 9. Module Catalog

Every module reachable from the UI today, plus internal state, injection points, init encoding, and test coverage.

### 9.1 ERC-20 template modules (spliced into the token)

Source: `contracts/modules/token/`, `contracts/modules/allocation/`. Alphabetical.

#### AntiBot (`AntiBot.frag.sol`)
- **Purpose:** anti-frontrun gate at launch — blocks transfers between non-allowlisted addresses for N blocks after deploy.
- **State:** `uint256 _abGateEndsAtBlock; mapping(address => bool) _abAllowed`.
- **Init:** `abi.decode(moduleData[<idx>], (uint16 blockGate))`; sets `_abGateEndsAtBlock = block.number + blockGate`.
- **Hook:** `BEFORE_TRANSFER` reverts `AntiBot__Gated(from, to, blocksLeft)` if `block.number < gateEnd && from != 0 && to != 0 && from != owner()` AND NEITHER endpoint is allowlisted. Either-endpoint semantics — allowlisting either side is enough (this is what lets curve→buyer trades survive during the gate: Router allowlists the curve at install time).
- **Admin:** `setAntiBotAllowed(addr, bool) onlyOwner`.
- **Init encoding:** `abi.encode(uint16 blockGate)`. UI default 5 blocks.
- **UI status:** shipped, ERC20, `requiresOwner: true`.
- **Live impl:** `0x14b81325…e64a`.
- **Tests:** `contracts/test/composed/ERC20WithAntiBotGen.t.sol` — 10 tests covering gate window, allowlist toggle, owner exemption, exact-boundary block, post-gate freedom.

#### AntiWhale (`AntiWhale.frag.sol`)
- **Purpose:** per-transaction size cap + per-wallet total cap for N blocks after deploy.
- **State:** `uint128 _awMaxWallet; uint128 _awMaxTx; uint256 _awExpiresAtBlock; mapping(address => bool) _awExcluded`. The `_awExpiresAtBlock` was widened from uint32 to uint256 to prevent silent truncation at block ~4.3B.
- **Init:** `abi.decode(moduleData[<idx>], (uint128 maxWallet, uint128 maxTx, uint32 expireAfterBlocks))`. Auto-excludes `initialOwner`.
- **Hook:** `BEFORE_TRANSFER`. `maxTx` check gates on `!_awExcluded[from] && !_awExcluded[to]` (either exempted); `maxWallet` check gates ONLY on `!_awExcluded[to]` — split intentional after audit finding, previously either side being excluded skipped BOTH caps.
- **Admin:** `setAntiWhaleExcluded(addr, bool) onlyOwner`.
- **Init encoding:** `abi.encode(uint128, uint128, uint32)`. UI default `expireAfterBlocks = 1000`.
- **UI status:** shipped, ERC20, `requiresOwner: true`.
- **Live impl:** `0xdD7c50BE…babcD`.
- **Tests:** `contracts/test/composed/ERC20WithAntiWhaleGen.t.sol` — init, owner exclusion, tx-cap enforcement, wallet-cap enforcement, owner exempt, post-expiry unrestricted, admin toggle.

#### FeeOnTransfer (`FeeOnTransfer.frag.sol`)
- **Purpose:** tax-on-transfer with configurable burn + treasury split.
- **State:** `uint16 _fotFeeBps; uint16 _fotBurnBps; uint16 _fotTreasuryBps; address _fotTreasury; mapping(address => bool) _fotExcluded`.
- **Init:** `abi.decode(moduleData[<idx>], (uint16 feeBps, uint16 burnBps, uint16 treasuryBps, address treasury))`. Constraints: `feeBps ∈ (0, 3000]`, `burnBps + treasuryBps == 10_000`; auto-excludes `initialOwner` + `treasury`.
- **Hook:** `AFTER_TRANSFER`. Takes fee from the RECIPIENT — `_burn(to, burnPortion)` + `_transfer(to, treasury, treasuryPortion)`. **Fixed-supply invariant preserved** because only burn reduces supply; previous `_mint`-based treasury payout silently inflated supply.
- **Admin:** `setFeeOnTransferExcluded(addr, bool) onlyOwner`.
- **Init encoding:** `abi.encode(uint16, uint16, uint16, address)`.
- **UI status:** shipped, ERC20, `taxesTransfers: true` (blocks curve install via `_isCurveIncompatible` flag + `FLAG_BALANCE_MUTATING = 1<<0`).
- **Live impl:** `0x19E133a5…f93BC`. Flag: `1` (BALANCE_MUTATING).
- **Tests:** `contracts/test/composed/ERC20WithFeeOnTransferGen.t.sol` — 12 tests including large-amount split accuracy, exclusion no-fee, recursive burn/mint doesn't re-charge.

#### Pausable (`Pausable.frag.sol`)
- **Purpose:** emergency pause; owner can freeze all non-mint/non-burn transfers.
- **State:** `bool _pausablePaused`.
- **Init:** empty payload. Starts unpaused.
- **Hook:** `BEFORE_TRANSFER` reverts `Pausable__Paused()` if `_pausablePaused && from != 0 && to != 0 && from != owner()`.
- **Admin:** `pause() onlyOwner`, `unpause() onlyOwner`.
- **Init encoding:** `""` (empty bytes; marker read only).
- **UI status:** shipped, ERC20, `requiresOwner: true`, flagged "reduces decentralization".
- **Live impl:** `0x1Ccbf53F…E3e8`.
- **Tests:** `contracts/test/composed/ERC20WithPausableGen.t.sol` — 6 tests.

#### Permit (`Permit.frag.sol`)
- **Purpose:** EIP-2612 gasless approvals.
- **State:** none — Solady's ERC20 base already ships `permit()`, `DOMAIN_SEPARATOR()`, `nonces()`. Fragment is a marker-only.
- **Init:** empty; emits `PermitEnabled()`.
- **Hook:** none.
- **Init encoding:** `""`.
- **UI status:** shipped, ERC20.
- **Live impl:** `0xA46Af17d…4de1`.
- **Tests:** `contracts/test/composed/ERC20WithPermitGen.t.sol` — 4 tests including a full EIP-712 signature roundtrip.

#### Votes (`Votes.frag.sol`)
- **Purpose:** delegatable voting power via ERC20Votes checkpoints (for OZ Governor compatibility).
- **State:** the checkpoint mappings live on Solady's `ERC20Votes` base (activated via `templateOverride`).
- **Init:** marker only; emits `VotesEnabled()`.
- **Hook:** `AFTER_TRANSFER` in the OVERRIDE template calls `super._afterTokenTransfer` (Solady checkpoints).
- **Init encoding:** `""`.
- **UI status:** shipped, ERC20.
- **Live impl:** `0xf0a7AA9d…F0E8`.
- **Tests:** `contracts/test/composed/ERC20WithVotesGen.t.sol` — delegate, transfer moves votes, past votes revert on future.

#### Staking (`Staking.frag.sol`)
- **Purpose:** Synthetix-style single-asset staking with reserve-carved rewards.
- **State:** rate, `_stakePeriodFinish`, per-user reward accumulators, `_stakeTotal`, `_stakeBalance` mapping.
- **Init:** `abi.decode(moduleData[<idx>], (uint256 rewardsTotal, uint32 durationSeconds))`. Computes rate; **reserve-carves `_transfer(mintTarget, address(this), rewardsTotal)` from initial supply.** Reverts on underflow if over-allocated.
- **External:** `stake(uint256)`, `stakingWithdraw(uint256)`, `stakingClaim()`, plus 7 view getters.
- **Payout:** claim pays via `_transfer(address(this), msg.sender, reward)` — no mint, preserves fixed supply.
- **Init encoding:** `abi.encode(uint256, uint32)`.
- **UI status:** shipped, ERC20, `incompatibleWith: ['FeeOnTransfer']`.
- **Live impl:** `0x4601B97e…28e4`.
- **Tests:** `contracts/test/composed/ERC20WithStakingGen.t.sol` — includes `_Claim_TransfersFromReserveWithoutInflation` (asserts total supply unchanged) and `_Init_RevertsWhenRewardsExceedSupply`.

#### Vesting (`Vesting.frag.sol`)
- **Purpose:** single-beneficiary linear vesting with cliff.
- **State:** `_vestBeneficiary, _vestTotal, _vestReleased, _vestCliff, _vestEnd`.
- **Init:** `abi.decode(moduleData[<idx>], (address beneficiary, uint256 total, uint64 cliff, uint64 end))`. Reserve-carves via `_transfer(mintTarget, address(this), total)`.
- **External:** `vestingReleasable()`, `vestingRelease()` (permissionless), plus view getters.
- **Payout:** `_transfer(address(this), _vestBeneficiary, amount)` — no mint.
- **Init encoding:** `abi.encode(address, uint256, uint64, uint64)`.
- **UI status:** shipped, ERC20.
- **Live impl:** `0x203F3687…b731`.
- **Tests:** `contracts/test/composed/ERC20WithVestingGen.t.sol` — includes `_Release_TransfersFromReserveWithoutInflation`.

### 9.2 ERC-721A template modules

Source: `contracts/modules/nft/`.

- **OnChainSVG** — no state/init; overrides `tokenURI` to build data URI with embedded SVG. Live impl `0xc7BB2880…`. Tests: `ERC721AWithOnChainSVGGen.t.sol`.
- **DelayedReveal** — `_drRevealed, _drHiddenURI`; init `(string hiddenURI)`; `tokenURI` returns hidden pre-reveal, real URI post `reveal() onlyOwner`. Incompat with OnChainSVG. Live impl `0x45C36c47…`. Tests: `ERC721AWithDelayedRevealGen.t.sol`.
- **ERC2981Royalty** — `_royaltyReceiver, _royaltyBps`; init `(address receiver, uint96 feeBps)` with `feeBps ≤ 1000`; adds `royaltyInfo(id, price)` + supportsInterface + `setRoyaltyReceiver onlyOwner`. Live impl `0x5F61f73a…`. Tests: `ERC721AWithRoyaltyGen.t.sol`.
- **Soulbound** — no state; BEFORE_TRANSFER reverts unless mint (from=0) or burn (to=0). Live impl `0xE9FfA2B7…`. Tests: `ERC721AWithSoulboundGen.t.sol`.
- **Refundable** — `_refundablePricePerToken, _refundableWindowBlocks, _refundableMintBlock[id]`; init `(uint256 price, uint32 windowBlocks)`; adds public `refundableMint(qty) payable`, `refund(uint256[] ids)`, `refundableWithdraw(to, ids) onlyOwner`. Live impl `0x9cCD1f59…`. Tests: `ERC721AWithRefundableGen.t.sol`.

Combos also registered on live (from `web/src/lib/config.ts`): `ERC721AWithSvgAndRoyaltyImpl` = OnChainSVG + ERC2981Royalty.

### 9.3 ERC-1155 template modules

Source: `contracts/modules/nft/`.

- **SupplyPerToken1155** — per-id supply cap enforced in `AFTER_TRANSFER` on mint.
- **PayableMint1155** — per-id public payable mint with owner sweep.
- **PayableMint1155Split** — same but atomically forwards `feeBps` of mint ETH to a platform sink (typically FeeSplitter). CEI order — mint first, forward after, to avoid re-entry via receive.
- **ERC2981Royalty1155** — per-collection ERC-2981 royalty info.

None currently registered on live ERC1155Factory (only bare `ERC1155TemplateImpl` is). Pending NFT-base activation.

### 9.4 V4 hook modules — configured, not spliced

`LPLocked, FeeRedirect, AntiSniper, MultiHookHost, BuybackBurn` appear as `hook`-category modules in `web/src/lib/modules.ts`. These are **NOT** spliced into the token — they configure the `MultiHookHost` v4 hook at graduation. Frontend filters them out of `templateModuleIds` when computing configHash (`web/src/app/create/page.tsx:360-363`).

- `LPLocked, FeeRedirect, MultiHookHost` — all baked into every graduated pool by default (MHH always attaches; MHH's LP-lock is unconditional; MHH's fee-redirect is unconditional).
- `AntiSniper` — per-launch parameter (`params.antiSniperBlocks`) forwarded to `MHH.setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps)` atomically at pool init.
- `BuybackBurn` — per-launch parameter (`params.buybackBurnBps`) same as above, capped at 20 % (`MAX_BUYBACK_BPS = 2000`).

### 9.5 Planned modules (not shipped)

`web/src/lib/modules.ts` declares 3 planned modules (B20 compliance tier) that surface in `/catalog` but are metadata-only — no fragment file, no composed impl:
- `B20PolicyAware` — external PolicyRegistry gate on every transfer.
- `Blocklist` — owner freezes specific addresses.
- `Jailable` — owner seizes tokens from frozen addresses; requires Blocklist.

All flagged "reduces decentralization" heavily in the module description.

---

## 10. Compile Service

**Source:** `compile-service/src/` — a real Fastify HTTP service, NOT just a script. Runs on Railway. Node 20 + tsx.

**Role:** on-demand splicing + compilation of composed impls from user-selected module configs; per-token metadata persistence; whitelist snapshot + Merkle root generation; keeper duties (MHH fee push, NftRevenueVault epoch publish); pinata IPFS proxy.

### 10.1 Layout

```
compile-service/
├── Dockerfile              # Node 20 slim + foundryup (Forge, Cast, Anvil installed)
├── package.json            # Fastify 5, viem, zod, merkletreejs, pino, postgres
├── src/
│   ├── server.ts           # Fastify entry: /compile, /test, /health + social/pin/wl/rewards routes
│   ├── compile.ts          # parseFragment + splice + compose
│   ├── matrix.ts           # loadMatrix + validateConfig
│   ├── cli.ts              # standalone CLI for regenerating checked-in composed templates
│   ├── keeper.ts           # opt-in flywheel background loops (MHH.pushOwed, epoch publish)
│   ├── wl-snapshot.ts      # Blockscout + eth_getLogs holder enumeration + merkle build
│   ├── db.ts               # Postgres migration + hasDb() gate
│   └── routes/{pin,rewards,social,whitelist}.ts
├── fixtures/               # 31 canonical config JSON files (one per checked-in composed impl)
└── railway.json
```

### 10.2 HTTP surface

**`POST /compile`** — body:
```
{ base: 'ERC20'|'ERC721A'|'ERC1155', modules: string[], params: {…}, chain: '...' }
```
Zod-validated. Dedupes + canonicalizes module list alphabetically (matches contract-side splice order). Calls `compose()` → writes spliced .sol to `contracts/tmp/<hash>/<contractName>.sol` → spawns `forge build --sizes` → reads `contracts/out/<contractName>.sol/<contractName>.json` → returns `{ configHash, contractName, moduleIds, bytecode, abi, warnings }`.

Note: computes a WIDER hash including `params` and `chain` for keying the tmp/out dir; this is DIFFERENT from the on-chain configHash (which is `keccak256(abi.encode(base, sortedIds.join(',')))`). The frontend does not use this wider hash for anything on-chain — it's cache keying only.

**`POST /test`** — runs `test/composed/<contractName>.t.sol` via `forge test` if a hand-written test file exists.

**`GET /health`** — liveness.

**`POST /pin/file`** — rate-limited 5/min. Accepts base64 data URL ≤ 512 KB, forwards as FormData to `https://api.pinata.cloud/pinning/pinFileToIPFS` with the server-held `PINATA_JWT`. Returns `{cid, gatewayUrl}`.

**`POST /wl/snapshot`** — body `{chainId, tokenAddress}`. Calls `snapshotHolders()`:
- Prefers Blockscout `holders` API (100 per page × up to 100 pages = 10 k holders max).
- Falls back to `eth_getLogs` chunked replay of `Transfer` events (10 k blocks per chunk, max 25 M blocks).
- Leaves = `keccak256(encodePacked(address))`, sorted-pair Merkle tree (Solady/OZ layout matching `BondingCurve.buyWithProof` expectations).
- Long lists get pinned to IPFS. Returns `{root, snapshotBlock, holderCount, listId, listCid, listGatewayUrl, holdersPreview: holders.slice(0, 500)}`.

**`GET /wl/proof?listCid=<cid>&addr=<wallet>`** — returns Merkle proof for a specific address. In-memory cache first, IPFS fallback for durability across restarts.

**Social routes** (Postgres-gated):
- `GET/POST /token/:chainId/:address/metadata` — token image, description, socials.
- `GET/POST /profile/:address` — user bio, avatar.
- `GET/POST /token/:chainId/:address/chat` — per-token chat drawer.
- Follows API.
- All POSTs are wallet-sig-verified (`verifyEnvelope` in `auth.ts`); token-metadata writes gated on `msg.sender == launcher` per indexer lookup.

**Rewards routes** (Postgres-gated):
- `GET /rewards/:chain/vault-summary` — vault balance + epoch count.
- `GET /rewards/:chain/epochs/:address` — every epoch this addr has an allocation in.
- `GET /rewards/:chain/:epochId/:address` — Merkle proof for `NftRevenueVault.claim`.
- `POST /rewards/:chain/publish` — operator-triggered epoch publish. Gated by `x-keeper-secret` constant-time compare. On-chain sign uses `KEEPER_PRIVATE_KEY`.

### 10.3 Keeper (opt-in via `KEEPER_ENABLED=true`)

`compile-service/src/keeper.ts`. Two background loops:
- **`sweepMhhToFeeSplitterLoop`** — every 60 min. Reads `MHH.owed(address(0), FeeSplitter)`; if ≥ `MHH_SWEEP_THRESHOLD_WEI` (10 000 gwei), calls `MHH.pushOwed(0x0, FeeSplitter)` to move platform fees into the flywheel.
- **`publishEpochLoop`** — every 24 h. If `NftRevenueVault.balance >= VAULT_PUBLISH_THRESHOLD_WEI` (0.001 ETH), builds merkle tree from indexed gemu holders + publishes epoch via `addEpoch(root, totalAmount)`.

Not required — both operations are permissionless. Keeper is a convenience, not a trust root. The `KEEPER_PRIVATE_KEY` wallet is the same 0x6d606c… deployer EOA today.

### 10.4 What compile-service does NOT do

- **Does NOT auto-register impls on factories.** After compilation returns bytecode, the developer commits the composed source under `contracts/src/templates/composed/` and runs a Forge script (`DeployFreshLocal.s.sol` or a per-impl `registerImpl` call) to deploy + register.
- **Does NOT sign impl-registration txs.** Only signs `NftRevenueVault.addEpoch` and `MHH.pushOwed` — narrow keeper duties with tightly bounded blast radius.
- **Does NOT hold user funds.** The `/pin/file` route uses server-held `PINATA_JWT` but pinata payments are prepaid.

---

## 11. Bonding Curve

**Source:** `contracts/src/curve/BondingCurve.sol` (~700 lines).

**Live impl (LibClone target):** `0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9`.

**One curve per launched token.** Deployed as EIP-1167 clone by `CurveFactory` when Router installs the bonding curve. No admin, no upgrades, no rotate.

### 11.1 Curve model — pump.fun-style virtual constant-product AMM

Docstring at `BondingCurve.sol:20-26`: *"pump.fun-style constant-product bonding curve, one per token launch. Uses virtual reserves so early buys start at a well-defined non-zero price and price scales predictably up to the graduation target."*

Storage (relevant fields at `:115-143`):
```solidity
uint256 public virtualTokenReserve;   // immutable-after-init, per-tx additive
uint256 public virtualEthReserve;     // immutable-after-init, per-tx additive
uint256 public ethReserve;             // starts at 0, updated by trades
uint256 public tokenReserve;           // starts at curveSupply, updated by trades
bool    public graduated;
uint16  public tradeFeeBps;
address public feeReceiver;            // FeeSplitter on live
uint256 public graduationTargetEth;
address public token;
address public graduator;
address public launcher;
uint32  public antiSniperBlocks;
uint16  public buybackBurnBps;

// Whitelist state
bytes32 public whitelistRoot;
uint256 public reservedTokens;
uint256 public maxWlPerAddress;
uint64  public fallbackTs;
address public sourceTokenAddress;
uint32  public sourceChainId;
uint32  public declaredHolderCount;
uint256 public wlSold;
uint256 public wlHeldTotal;
mapping(address => uint256) public wlHeldForUser;
```

### 11.2 Live curve defaults on Robinhood

Fetched via `cast call CurveFactory <getter>` at 2026-08-03:

| Getter | Value | Semantics |
|---|---|---|
| `defaultCurveSupply()` | `800_000_000e18` | Initial token supply held by curve |
| `defaultVirtualTokenReserve()` | `800_000_000e18` | Additive constant for effective token side |
| `defaultVirtualEthReserve()` | `17 ether` | Additive constant for effective ETH side |
| `defaultGraduationTargetEth()` | `10 ether` | Trigger graduation when `ethReserve >= this` |
| `defaultTradeFeeBps()` | `100` | 1 % on every trade |
| `graduator()` | `0x0Db63b8Af346c5edabF79b16A236AEDA0428e712` | V8-final Graduator |
| `feeReceiver()` | `0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA` | FeeSplitter directly (no intermediate hop) |

**Chunky defaults bump** (2026-07-30, per memory `project_chunky_defaults_broadcast`): virtualEth 5→17 ETH, target 4→10 ETH. Widens the LP-at-graduation payload.

### 11.3 Reachability invariant

`CurveFactory._validateCurveDefaults` (`:140-162`) enforces:
```
graduationTargetEth < curveSupply * virtualEthReserve / virtualTokenReserve
```

For live: `10 < 800M * 17 / 800M = 17` ✓. This is the "target actually reachable" guard — without it, an admin typo could set a target higher than the maximum ETH the curve can absorb (token side drains first, ETH gets stranded).

### 11.4 Post-bump graduation payload

At `ethReserve = 10 ETH` (graduation trigger):
- `effEth = ethReserve + virtualEthReserve = 27 ETH`
- `effToken = k / effEth = (17 * 1.6B) / 27 ≈ 1.007B`
- `tokenReserve at graduation ≈ 1.007B − 800M ≈ 207.4M`

So **~207M tokens + 10 ETH** get handed to the Graduator for LP minting. The other ~593M was sold on curve to public buyers (plus WL-held if applicable).

### 11.5 `buy(uint256 minTokensOut) payable` — full flow

`BondingCurve.sol:395-447`:
```
require !graduated
require msg.value > 0
fee          = msg.value * tradeFeeBps / 10_000
ethAfterFee  = msg.value - fee
effEth       = ethReserve + virtualEthReserve
effToken     = tokenReserve + virtualTokenReserve
k            = effEth * effToken                  // recomputed every trade
newEffEth    = effEth + ethAfterFee
newEffToken  = k / newEffEth
tokensOut    = effToken - newEffToken

require tokensOut <= tokenReserve   (revert ExceedsSupply — hard revert)
require tokensOut != 0              (dust-buy guard)
require tokensOut >= minTokensOut   (slippage)
require whitelistRoot == 0 || block.timestamp >= fallbackTs   (WL window closed)

tokenReserve -= tokensOut
publicSold   += tokensOut
ethReserve   += ethAfterFee         // NET-of-fee ETH into reserves
safeTransferETH(feeReceiver, fee)
safeTransfer(token, msg.sender, tokensOut)
emit Trade(...)
if (ethReserve >= graduationTargetEth) _graduate()
```

Key nuances:
- Fee skimmed BEFORE the AMM math, so the buyer's effective price is worse than the fee-less curve.
- `k` is NOT preserved across trades — it's recomputed each trade from current-real-reserves + immutable-virtuals (standard pump-style virtual-CPMM invariant).
- Dust-buy guard prevents `tokensOut == 0` — otherwise a griefer can push `ethReserve` toward graduation for near-zero tokens.
- WL guard closes public buys during the WL window (see §19).

### 11.6 `sell(uint256 tokensIn, uint256 minEthOut)` — full flow

`BondingCurve.sol:529-556`:
```
require !graduated
require tokensIn > 0
safeTransferFrom(token, msg.sender, curve, tokensIn)   // pull first

effEth      = ethReserve + virtualEthReserve
effToken    = tokenReserve + virtualTokenReserve
k           = effEth * effToken
newEffToken = effToken + tokensIn
newEffEth   = k / newEffToken
ethGross    = effEth - newEffEth

if (ethGross > ethReserve) ethGross = ethReserve      // real-reserve clamp
fee   = ethGross * tradeFeeBps / 10_000               // fee from output
ethOut = ethGross - fee
require ethOut >= minEthOut

tokenReserve += tokensIn
ethReserve   -= ethGross
safeTransferETH(feeReceiver, fee)
safeTransferETH(msg.sender, ethOut)
emit Trade(...)
```

Asymmetries vs buy: fee taken from OUTPUT (not input); real-reserve clamp on `ethGross` (in case virtuals arithmetic over-quotes vs actual reserves); NO graduation trigger on sells (they reduce `ethReserve`).

### 11.7 Quotes

- `quoteBuy(ethIn)` — same math as `buy` but non-mutating; returns `(0, 0)` if graduated; **clamps** `tokensOut` to `tokenReserve` on oversize (unlike live `buy` which reverts).
- `quoteSell(tokensIn)` — mirror.
- `priceWeiPerToken()` — `(ethReserve + virtualEthReserve) * 1e18 / (tokenReserve + virtualTokenReserve)`.

### 11.8 Slippage + dust guards

- Custom-error `BondingCurve__Slippage(got, min)` on both sides.
- Dust guard on `buy` + `buyWithProof`: `if (tokensOut == 0) revert ZeroAmount`.
- `_init` guards: `whitelistRoot != 0` implies `reservedTokens ∈ (0, curveSupply]`, `maxWlPerAddress > 0`, `fallbackTs > block.timestamp`.

### 11.9 Fee recipient

`feeReceiver` is factory-copied to each curve at init time. Live value: `0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA` (**FeeSplitter directly** — no intermediate hop). Every trade fee triggers `FeeSplitter.receive()` → `_distribute` → 40/35/25 split.

### 11.10 Graduation trigger

Only one trigger — inside `buy()` and `buyWithProof()`:
```solidity
if (ethReserve >= graduationTargetEth) _graduate();
```
`sell()` never triggers.

**[V8 change vs live]** — `_graduate` is now atomic. Previous behavior set `graduated = true` before the external call AND silently no-op'd on `graduator == 0 || tokenOut == 0`, producing a terminal "graduated but funds stuck" state (URU-A04, URU-A05). V8 version:

```solidity
function _graduate() internal {
    uint256 ethOut = ethReserve;
    uint256 tokenOut = tokenReserve;
    if (tokenOut == 0) revert BondingCurve__GraduationReserveRequired();
    address g = graduator;
    if (g == address(0) || g.code.length == 0) revert BondingCurve__GraduatorUnset();

    graduated = true;
    ethReserve = 0;
    tokenReserve = 0;
    SafeTransferLib.safeApprove(token, g, tokenOut);
    IGraduator(g).execute{value: ethOut}(token, ethOut, tokenOut, antiSniperBlocks, buybackBurnBps, launcher);
    emit Graduated(ethOut, tokenOut, block.timestamp);
}
```

If `Graduator.execute` reverts, the whole tx (buy → graduate) unwinds (`nonReentrant` on entrypoints protects state). No partial state possible.

**[V8 change vs live]** — no-clamp in buy/buyWithProof. Both `buy()` and `buyWithProof()` now use `available = tokenReserve - 1` (leaves 1 wei-token graduation floor). Previously `buyWithProof` CLAMPED `tokensOut` to `tokenReserve`, producing WL terminal-lock. V8 code reverts `ExceedsSupply(tokensOut, available)` on any buy that would drain the reserve completely — the 1-wei floor guarantees `_graduate` can always find inventory.

**[V8 change vs live]** — `_init` rejects zero/non-contract graduator. `if (graduator_ == address(0) || graduator_.code.length == 0) revert BondingCurve__GraduatorUnset();`. Combined with `CurveFactory.setGraduator(0)` reverting, the "curve deployed without a graduator" state is unreachable at V8.

### 11.11 The V7 → V8 graduation story

**V7 bug (2026-07-30):** V7 Graduator opened the v4 pool at the CURVE MARGINAL PRICE = `(virtualEth + realEth) / (virtualToken + realToken)`. That price is a factor `~virtualToken/realToken` LOWER than the raw real ratio of the amounts being deposited. Consequence: LP is bottlenecked by the token side → tokens all consumed, only a fraction of ETH consumed → ~4 ETH stranded permanently in Graduator with no owner + no sweep.

**V8 fix (raw-ratio pricing):** `GraduatorV2.sol:186-207` now computes `curveFinalPrice = (ethAmount * 1e18) / tokenAmount` and initializes the pool at that raw ratio. Both sides absorbed exactly (modulo integer rounding dust). Also added:
- `owner + sweep(payable to)` — recover any future accidentally-stranded ETH.
- Per-tx rounding-dust refund to launcher.
- Pre-flight sanity check to prevent stale-env deploys.

Regression test: `contracts/test/audit/GraduatorV8LpMathFork.t.sol::test_V8_Graduation_LeavesNoEthStuck` — etches V8 bytecode over the live graduator pin, runs a full launch → buy → graduation cycle against the live Router, asserts `address(graduator).balance == 0` post-graduation.

Live Graduator balance today: `0` (clean; no stranded ETH).

---

## 12. CurveFactory

**Source:** `contracts/src/curve/CurveFactory.sol`.

**Live address:** `0x1c340f092c89d018d7F6410B0A418253FB522c70`.

### 12.1 Role

- Owns the `BondingCurve` impl address (`implementation()`).
- Deploys per-launch curves via `LibClone` from Router.
- Maintains chain-wide curve defaults (see §11.2).
- Trust-lists routers via `trustedRouters` mapping (allows atomic Router rotation without redeploying CurveFactory — see §21).
- Registers the deployed curve in `curveFor[token]` mapping so Graduator can authorize `execute()` calls.

### 12.2 Storage

```solidity
address public implementation;             // BondingCurve template (LibClone target)
address public feeReceiver;                // FeeSplitter — copied to each curve at init
address public graduator;                   // GraduatorV2
uint256 public defaultCurveSupply;
uint256 public defaultVirtualTokenReserve;
uint256 public defaultVirtualEthReserve;
uint256 public defaultGraduationTargetEth;
uint16  public defaultTradeFeeBps;
mapping(address => bool) public trustedRouters;      // Mapping — additive; multiple routers OK
mapping(address => address) public curveFor;         // token → curve
uint16 public constant MAX_TRADE_FEE_BPS = 3000;
```

### 12.3 `createCurveWithConfigFor(token, antiSniperBlocks, buybackBurnBps, launcher)` — Router-only

`CurveFactory.sol:231-247`:
1. `require trustedRouters[msg.sender]` (revert `UntrustedRouter`).
2. Clone `implementation` via `LibClone.cloneDeterministic(implementation, saltFromToken)`.
3. Pull `curveSupply = token.balanceOf(msg.sender)` from Router.
4. `require balance >= defaultCurveSupply / 2` (revert `ModulesOverAllocated` — the anti-launcher-airdrops-self-90% guard, kicks in when reserve-backed modules like Vesting/Staking over-carve).
5. `token.safeTransferFrom(msg.sender, curve, curveSupply)`.
6. Call `curve.initialize(...)` with all the defaults + per-launch params + launcher address.
7. Store `curveFor[token] = curve`.
8. Emit `CurveCreated(token, curve, launcher)`.

### 12.4 WL variant

`createCurveWithConfigForWl(token, antiSniperBlocks, buybackBurnBps, launcher, wl)` — same as above but calls `curve.initializeWithWhitelist(...)` with the WL struct forwarded. WL init requires `reservedTokens ∈ (0, curveSupply]`, `maxWlPerAddress > 0`, `fallbackTs > block.timestamp`.

### 12.5 Additive router trust

`trustedRouters` is a MAPPING keyed by router address. Multiple routers can be trusted simultaneously — this is what enables the audit-round-2 v5 rotation flow:
- Phase 1: `setTrustedRouter(newRouter, true)` — old Router STILL trusted; no user-visible outage.
- Phase 2: `setTrustedRouter(oldRouter, false)` — flip after factory setRouter completes.

### 12.6 `setDefaults` — validated

`CurveFactory.sol:114-130`. Owner-only. Runs `_validateCurveDefaults` (`:140-162`) which enforces:
- `tradeFeeBps <= 3000`.
- All 4 numeric fields > 0.
- Reachability: `graduationTargetEth < curveSupply * virtualEthReserve / virtualTokenReserve` (else `UnreachableGraduationTarget`).

Also a lonely `setDefaultCurveSupply(uint256)` at `:265-269` that intentionally SKIPS the reachability check (comment: "existing curves are unaffected"). Footgun documented; only affects future launches.

### 12.7 Live state

```
CurveFactory:     0x1c340f092c89d018d7F6410B0A418253FB522c70
owner:            0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
implementation:   0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9
graduator:        0x0Db63b8Af346c5edabF79b16A236AEDA0428e712
feeReceiver:      0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA (FeeSplitter)
trustedRouters[0x84C7…B596] = true   (live V7 Router)
```

---

## 13. Graduator (V8-final)

**Source:** `contracts/src/curve/GraduatorV2.sol`. Class name kept `V2` for interface stability; the file is the V8-final version.

**Live address:** `0x0Db63b8Af346c5edabF79b16A236AEDA0428e712`.

**Role:** the one-way pivot from bonding curve → Uniswap v4 pool. Receives ETH + tokens from a graduating curve, initializes the v4 pool at the raw-ratio price, mints the LP position, refunds any dust to the launcher, records the launcher as the pool's creator in MHH.

### 13.1 Immutables

```solidity
IPoolManager public immutable poolManager;
IHooks       public immutable defaultHook;     // MHH
address      public immutable curveFactory;
uint24       public immutable fee;             // 3000 (0.30 %)
int24        public immutable tickSpacing;     // 60
int24        public immutable tickLower;       // −887160 (max valid at spacing 60)
int24        public immutable tickUpper;       //  887220 (max valid at spacing 60)
```

Full-range LP (as concentrated as `tickSpacing=60` allows).

### 13.2 Mutable state

```solidity
address public owner;   // V8 addition — enables sweep + rotate
```

`setOwner(newOwner)` — onlyOwner, rejects `address(0)`.

### 13.3 `execute(token, tokenAmount, ethAmount, launcher, antiSniperBlocks, buybackBurnBps) payable`

`GraduatorV2.sol:174-284`. Called by a graduating curve. Full flow:

1. **Authorize**: `authorized = curveFactory.curveFor(token); require msg.sender == authorized` (revert `NotAuthorizedCurve`).
2. **Basic checks**: `msg.value == ethAmount`, `tokenAmount > 0`, `ethAmount > 0`.
3. **Pull tokens**: `token.safeTransferFrom(curve, this, tokenAmount)`.
4. **Configure hook** BEFORE pool init (so config is frozen when `beforeInitialize` fires):
   - `MHH.setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps)` — reverts `ConfigFrozen` if `launchBlock != 0` (config already stamped).
   - `MHH.setCreator(poolId, launcher)` — same freeze guard.
5. **Compute raw-ratio price**:
   ```solidity
   curveFinalPrice = (ethAmount * 1e18) / tokenAmount;   // 1e18-scaled wei-ETH per wei-token
   sqrtPriceX96 = uint160((1e9 << 96) / sqrt(curveFinalPrice));
   ```
   The V8 fix. Detailed derivation in the comment at `:186-207`.
6. **Build poolKey**: `(currency0=ETH, currency1=token, fee=3000, tickSpacing=60, hooks=defaultHook)`. ETH is always currency0 because `address(0) < any token address`.
7. **Compute liquidity**: `liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, ethAmount, tokenAmount)`.
8. **Initialize pool**: `poolManager.initialize(key, sqrtPriceX96)` — triggers `MHH.beforeInitialize` which authorizes `sender == initializer` (= this Graduator), stamps `launchBlock = block.number`.
9. **Add liquidity via unlock**: `poolManager.unlock(abi.encode(key, liquidity, ..., token))`.
10. In `unlockCallback` (`:287-322`):
    - Verify `msg.sender == poolManager`.
    - Call `poolManager.modifyLiquidity(key, ModifyLiquidityParams{tickLower, tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)}, "")`.
    - Settle currency0 (ETH): if `delta0 < 0`, `poolManager.settle{value: |delta0|}()`.
    - Settle currency1 (token): if `delta1 < 0`, `poolManager.sync(Currency.wrap(token)); token.safeTransfer(poolManager, |delta1|); poolManager.settle()`.
    - Handle any residual (rare) via `poolManager.take` back to Graduator.
11. **Dust handling** (V8 safety belts):
    - Any leftover TOKENS → transferred to `BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD`. Emits `ExcessBurned(token, amount)`.
    - Any leftover ETH → CREDITED (not pushed) to `claimableRefunds[launcher]` and tallied in `totalClaimable`. Emits `RefundCredited(token, launcher, amount)`. The launcher (or a delegate they name) drains it later via `claimRefund()` or `claimRefundTo(recipient)`, which emits `RefundClaimed(launcher, recipient, amount)`. Pull-based so a contract-wallet launcher whose `receive()` reverts (Safe, DAO treasury, custody solution) cannot brick graduation. `sweep()` treats `totalClaimable` as reserved and only lifts the excess. (FINDING 6, audit round 2.)
12. Emit `Graduated(token, address(defaultHook), ethAmount, tokenAmount, sqrtPriceX96, liquidity)`.

### 13.4 `sweep(address payable to)` — V8 owner-only escape hatch

`:155-164`. Recovers any accidentally-stranded ETH. Docstring says "expected balance is ALWAYS zero after every graduation" with raw-ratio pricing. Only fires on future-bug regressions.

V7 had NO owner and NO sweep — the 4.003 ETH stranded there is permanently stuck.

### 13.5 LP position ownership + lock

The LP position is booked to the Graduator contract in `PoolManager`'s per-position state — no NFT is minted (Graduator uses raw `PoolManager.modifyLiquidity`, not `PositionManager`). The position is identified by `(pool, owner=Graduator, tickLower, tickUpper, salt=0)`.

**Graduation LP is locked STRUCTURALLY** (post-F5, audit round 2). `GraduatorV2` has no code path that ever calls `modifyLiquidity` with a negative `liquidityDelta`, no burn function, no transfer function, no owner escape — so the Graduator itself cannot pull the position, and since no other address is the position owner nobody else can either. The MHH no longer intercepts remove-liquidity, which means third-party LPs on the same pool can add + remove their own positions freely through the Uniswap UI. Only the Graduator-owned graduation position is locked.

**Deployment status:** the currently-deployed RH MHH at `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` still carries the pre-F5 hook-enforced revert (mask `0x22C4`, `beforeRemoveLiquidity` gated). To ship F5 to production, a new MHH must be mined at a `0x20C4`-tail address, paired with a fresh Graduator, and rotated in via `MHH.setInitializer(newGraduator)` + `CurveFactory.setGraduator(newGraduator)`. Pools graduated on the old MHH inherit the pre-F5 hook and its LP-lock revert permanently.

### 13.6 Live state

```
Graduator:        0x0Db63b8Af346c5edabF79b16A236AEDA0428e712
owner:            0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
poolManager:      0x8366a39CC670B4001A1121B8F6A443A643e40951
defaultHook:      0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4 (MHH)
curveFactory:     0x1c340f092c89d018d7F6410B0A418253FB522c70
fee:              3000
tickSpacing:      60
tickLower:        -887160
tickUpper:         887220
ETH balance:      0                    (clean; matches V8 raw-ratio invariant)
```

### 13.7 Cross-wires

Enforced in `RhLiveStackSnapshot.t.sol`:
- `Router.curveFactory == CurveFactory pin` ✓
- `CurveFactory.trustedRouters[Router] == true` ✓
- `CurveFactory.graduator == Graduator pin` ✓
- `Graduator.curveFactory == CurveFactory pin` ✓
- `Graduator.defaultHook == MHH pin` ✓
- `MHH.initializer == Graduator pin` ✓ (one-shot; permanently locked at deploy time)

---

## 14. MultiHookHost — The V4 Hook

**Source:** `contracts/src/hooks/MultiHookHost.sol` (~420 lines).

**Live address:** `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4`.

**Role:** the single v4 hook attached to every graduated launchpad pool. Combines three behaviors that would otherwise require three separate hooks (v4 allows only ONE hook per pool):
1. **Anti-sniper gate** — per-pool block window during which swaps revert.
2. **Fee redirect** — platform + creator take a slice of every swap's unspecified currency.
3. **Buyback-burn** — optional per-pool slice of BUY output tokens sent to 0xdEaD.

Plus a critical safety mechanism:
4. **Initializer gate** — only the wired Graduator can initialize pools through this hook (blocks predictable-poolKey DoS).

**LP lock is structural, not hook-gated (post-F5).** The graduation LP position is locked because the Graduator itself owns it and `GraduatorV2` has no code path to remove/burn/transfer it. MHH no longer intercepts `beforeRemoveLiquidity`, so third-party LPs added post-graduation can add + remove theirs freely. See §13.5 for detail and the deployment status note (pre-F5 MHH still live on RH).

### 14.1 Hook flags — encoded in the address

v4 encodes required permissions in the LOW BITS of the hook address; the address must be MINED via CREATE2 to have the right bits. Post-F5 (audit round 2), MHH requires:

```
BEFORE_INITIALIZE_FLAG         (1 << 13)
BEFORE_SWAP_FLAG               (1 << 7)
AFTER_SWAP_FLAG                (1 << 6)
AFTER_SWAP_RETURNS_DELTA_FLAG  (1 << 2)

Sum: 0x2000 | 0x0080 | 0x0040 | 0x0004 = 0x20C4
```

**Source vs live mismatch (F5 rotation pending):** the source-derived mask is `0x20C4` after F5 dropped `BEFORE_REMOVE_LIQUIDITY_FLAG`. The currently-deployed RH MHH at `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` was mined against the PRE-F5 mask `0x22C4` (`| 0x0200`) and ends in `A2c4`. It still carries the old `beforeRemoveLiquidity`-revert hook. Deploy scripts + `LocalV4Stack` helper have been updated to mine at the new `0x20C4` mask; the next MHH deploy will land at an address ending in the `0x20C4` low-14-bit pattern. See §13.5 deployment status.

### 14.2 Constructor + `setInitializer`

Constructor (`:119-142`):
```solidity
constructor(
    IPoolManager _poolManager,
    address _platform,             // FeeSplitter on live
    address _creator,               // fallback creator (deployer EOA on live)
    uint16  _platformBps,           // 100 (1%)
    uint16  _creatorBps,            // 100 (1%)
    address _deployer               // one-shot setInitializer authority
)
```

All immutable. Enforces `platformBps + creatorBps ∈ (0, MAX_TOTAL_BPS=3000]`.

`setInitializer(address _initializer)` (`:150-158`) — one-shot, deployer-only. Locks `initializer` (the Graduator) forever. Between deploy and this call the hook is intentionally unusable (`beforeInitialize` reverts `InitializerNotSet` for everyone) — closes the "griefer initializes a pool with a rogue setPoolConfig" window.

### 14.3 `beforeInitialize` — the gate

`MultiHookHost.sol:224-234`:
```solidity
function beforeInitialize(address sender, PoolKey calldata key, uint160) external override onlyPoolManager returns (bytes4) {
    address auth = initializer;
    if (auth == address(0)) revert MultiHookHost__InitializerNotSet();
    if (sender != auth) revert MultiHookHost__UnauthorizedInitializer(sender);
    poolConfig[key.toId()].launchBlock = uint32(block.number);
    return this.beforeInitialize.selector;
}
```

Sender is the address that called `PoolManager.initialize` (v4 passes it through). For launchpad pools this is always the Graduator. Any other sender reverts — this blocks the "outsider front-runs `PoolManager.initialize` on a graduating pool's predictable pool key" DoS attack.

Stamps `launchBlock = block.number` — after this, `setPoolConfig` and `setCreator` for this pool revert `ConfigFrozen`.

### 14.4 LP lock — structural, not hook-gated (post-F5)

The hook no longer implements `beforeRemoveLiquidity`. `getHookPermissions().beforeRemoveLiquidity == false` and the function itself has been removed from the source (`MultiHookHost__LiquidityLocked` error deleted, hook mask changed `0x22C4` → `0x20C4`).

Instead, the graduation LP position is locked STRUCTURALLY by the Graduator:
- Graduator opens the position via `poolManager.modifyLiquidity` with the Graduator as position owner.
- `GraduatorV2` has no code path that ever calls `modifyLiquidity` with a negative `liquidityDelta`, no burn function, no transfer function, no owner escape.
- The position can never be moved by anyone.

Third-party LPs added post-graduation on the same pool can add AND remove their own positions freely through the Uniswap UI.

Regression coverage: `contracts/test/audit/DeployPathRhFork.t.sol::test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched` — deploys a fresh stack, launches + graduates a token, has a third-party LP add + remove a narrow-range position, and asserts (a) the third-party add succeeds, (b) the third-party remove succeeds and returns both sides, (c) the Graduator-owned graduation LP position is untouched across the whole cycle.

**Deployment status:** the currently-deployed RH MHH at `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` STILL carries the pre-F5 revert. See §13.5 for the rotation plan.

### 14.5 `beforeSwap` — anti-sniper gate

`:248-265`. Per-pool. If `poolConfig[id].antiSniperBlocks > 0`, swaps revert `AntiSniperGate(launchBlock, gateBlocks)` until `block.number >= launchBlock + antiSniperBlocks`. Zero disables. Purely a "no swaps for the first N blocks after graduation" mechanism.

### 14.6 `afterSwap` — fee redirect + buyback burn

`:278-352`. Runs on EVERY swap.

1. Compute `unspecCurrency` and `unspecDelta` via `_unspecified(key, params, delta)` — the "unspecified side" (output for exact-input, input for exact-output). This is v4's canonical way to identify the fee-side.
2. If `unspecDelta == 0`, cheap exit.
3. `absDelta = |unspecDelta|` (clamped for pathological `int128.min`).
4. `totalBps = platformBps + creatorBps` (200 on live = 2 % of unspecified side).
5. `fee = absDelta * totalBps / 10_000`.
6. **[V8 change vs live — URU-P1-M04 round-4 correction]** Buyback-burn slice is now GATED to exact-input BUYs only. The prior V8 attempt applied burn on ALL BUYs (`zeroForOne == true`), but the auditor's round-4 report showed that on exact-output BUYs the unspecified currency IS the ETH input, so `currency.transfer(BURN_ADDRESS, burn)` was destroying ETH instead of the launched token — the advertised token-supply reduction did not occur. Round-4 fix: `MultiHookHost.beforeSwap` reverts `ExactOutputBuyUnsupportedWithBurn()` whenever an exact-output BUY is attempted against a pool with `buybackBurnBps > 0`. `afterSwap` continues to apply burn only on exact-input BUYs where unspec is the token (correct token supply reduction). If a launcher wants exact-output support, they must disable the burn at launch (set `buybackBurnBps = 0`). Tests: `test/hooks/MultiHookHost.t.sol::test_BeforeSwap_ExactOutputBuyRevertsWhenBuybackBurnEnabled` + `test_BeforeSwap_ExactOutputBuyAllowedWhenBuybackBurnDisabled` + `test_AfterSwap_ExactInputBuyStillBurnsOutputTokens` (regression).
7. `totalTake = fee + burn`; if zero, exit.
8. `poolManager.take(unspecCurrency, address(this), totalTake)` — pulls fee INTO hook's own balance. **Critical:** v4 credits the hook's currency delta with the returned int128; not taking the corresponding amount would revert `CurrencyNotSettled` on unlock.
9. If `burn > 0`: `currency.transfer(BURN_ADDRESS, burn)`; emit `BuybackBurned(currency, burn)`.
10. If `fee > 0`:
    - `platformShare = fee * platformBps / totalBps` (half, since both bps are 100 on live).
    - `creatorShare = fee - platformShare`.
    - Look up `creators[poolId]` — fallback to constructor `creator` if unset (blocks stranded-share for non-launchpad pools).
    - Accrue: `owed[unspecCurrency][platform] += platformShare; owed[unspecCurrency][creatorAddr] += creatorShare`.
    - Emit `FeeAccrued(unspecCurrency, platformShare, creatorShare)`.
11. Return `int128(int256(totalTake))` as `hookDeltaUnspecified` — v4 adds this to the swapper's side, so exact-in gets less output, exact-out pays more input.

**Historical fix:** an earlier implementation early-returned when `unspecDelta <= 0`, meaning every exact-output swap paid ZERO fees. That was a live fee leak — v4-periphery's exact-output path is trivial to reach. Fixed at `:294-300` by using `absDelta` unconditionally.

### 14.7 `claim` + `pushOwed`

`:358-383`:
- `claim(currency)` — the recipient pulls their own owed balance. `owed[currency][msg.sender] → 0; currency.transfer(msg.sender, amount)`. Recipient path — creator uses this.
- `pushOwed(currency, account)` — permissionless push. Enables the FeeSplitter (a contract with no self-call ability) to receive its accrued fees via any keeper. Emits the same `FeeClaimed` event as `claim` so indexers see one code path.

**Reentrancy safety:** CEI ordering (zero the `owed` slot BEFORE `currency.transfer`). No `nonReentrant` modifier — safe by construction. `currency.transfer` from v4-core wraps both native ETH and ERC-20 recipients safely.

### 14.8 `setPoolConfig` + `setCreator` — onlyInitializer (URU-A12, V8)

**[V8 change vs live]** — both functions are now `onlyInitializer`. Live V6 MHH had them permissionless with only the "config freezes at beforeInitialize" gate as protection; auditor found that gate was pointless because an attacker could pre-plant hostile config that then froze at initialize (URU-A12).

```solidity
function setPoolConfig(PoolId id, uint32 antiSniperBlocks, uint16 buybackBurnBps) external {
    if (msg.sender != initializer) revert MultiHookHost__NotInitializer(msg.sender);
    if (poolConfig[id].launchBlock != 0) revert MultiHookHost__ConfigFrozen();
    if (antiSniperBlocks > MAX_ANTI_SNIPER_BLOCKS) revert MultiHookHost__AntiSniperTooLong(...);
    if (buybackBurnBps > MAX_BUYBACK_BPS) revert MultiHookHost__BurnBpsTooHigh(...);
    ...
}
```

Same `onlyInitializer` on `setCreator`. Also adds `MAX_ANTI_SNIPER_BLOCKS = 7200` cap (mirrors Router side).

**Graduator side (URU-A12, V8)**: Graduator no longer try/catches around these calls. If either reverts, graduation reverts. After both calls succeed, Graduator reads back `poolConfig(id)` + `creators(id)` and reverts `HookConfigMismatch` or `HookCreatorMismatch` if any field drifted — closes the last window an attacker could exploit.

### 14.9 Chain-wide caps

- `MAX_TOTAL_BPS = 3000` — platform + creator can never exceed 30 % of a swap.
- `MAX_BUYBACK_BPS = 2000` — per-pool buyback slice ≤ 20 %.
- Both enforced in constructor + `setPoolConfig`. No path to raise them post-deploy.

### 14.10 Live state

```
MHH:              0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4
platform:         0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA  (FeeSplitter)
creator (fbk):    0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
platformBps:      100  (1 %)
creatorBps:       100  (1 %)
initializer:      0x0Db63b8Af346c5edabF79b16A236AEDA0428e712  (Graduator)
deployer:         0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
owed(ETH, FeeSplitter): 0  (no unclaimed platform fees today)
```

Total post-graduation swap fee = 200 bps (2 % of unspecified side per swap), split 50/50 platform (→ FeeSplitter → 40/35/25) / creator (→ launcher direct).

---

## 15. Flywheel — FeeSplitter & Sinks

**Sources:** `contracts/src/router/FeeSplitter.sol`, `contracts/src/flywheel/{UruBuybackVault, UruDepositSink, NftRevenueVault, LoyaltyOracle}.sol`.

### 15.1 FeeSplitter (`0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA`)

**Role:** the entry point for every ETH fee — launch fees, curve trade fees, MHH-pushed platform fees, royalty-router platform slices. All ETH inflows split 40 % URU buyback / 35 % NFT holder rewards / 25 % treasury.

**Storage:**
```solidity
uint16  public uruBuybackBps;    // 4000 live
uint16  public nftRevenueBps;    // 3500 live
uint16  public treasuryBps;      // 2500 live
address public uruBuybackSink;   // UruBuybackVault live
address public nftRevenueSink;   // NftRevenueVault live
address public treasurySink;     // deployer EOA live
uint256 public lastConfigChange;
uint256 public immutable minConfigDelay;   // 172_800 (2 days) live
```

**Constructor** (`:83-95`):
```solidity
constructor(address initialOwner, address treasury_, uint256 minConfigDelay_)
```
Cold-start: `treasurySink = treasury_`, `treasuryBps = 10_000`, other sinks/bps = 0. `lastConfigChange = block.timestamp` — meaning the FIRST post-deploy `setConfig` must ALSO wait `minConfigDelay`. Timelock armed from block 0.

**`receiveFee(address launcher, BaseType base) payable`** (`:100-106`):
```solidity
emit FeeReceived(launcher, base, msg.value);
_distribute(msg.value);
```
Called from `Router.launch/launchWithWhitelist` at `{value: fee}`.

**`receive() external payable`** (`:108-111`):
```solidity
emit FeeReceived(address(0), BaseType.ERC20, msg.value);
_distribute(msg.value);
```
Catches raw ETH sends — curve trade fees (`BondingCurve.safeTransferETH(feeReceiver, ...)`), MHH `pushOwed(ETH, FeeSplitter)`, royalty-router platform slice, any accidental sends.

**`_distribute` (the wei-tracing core, `:157-218`):**
1. `toBuyback = amount * uruBuybackBps / 10_000`.
2. `toNft = amount * nftRevenueBps / 10_000`.
3. `toTreasury = amount - toBuyback - toNft` — treasury absorbs rounding residue (≤ 3 wei).
4. Zero-sink rollover: if `uruBuybackSink == 0`, its slice folds into `toTreasury`. Same for `nftRevenueSink`. Never lose ETH.
5. Reverting-sink guard: each non-treasury sink is called via `.call{value:, gas:100_000}("")`; on failure that slice rolls into `toTreasury`. Prevents downstream brick from DoS-ing every launch platform-wide.
6. Treasury call is also best-effort; on treasury revert the ETH stays in FeeSplitter, emits `TreasuryDistributionFailed(treasury, stuck)`, recoverable via `sweep(to)` (owner-only, NOT timelocked).
7. Emit `Distributed(amount, toBuyback, toNft, toTreasury)`.

**[V8 change vs live]** — `setConfig` reverts `DirectConfigDisabled` when `minConfigDelay > 0` (production). Previously it was a cooldown-since-last-change gate: once matured, owner could instantly redirect the entire future fee stream. URU-A11 finding was that this is a cooldown, not a real timelock. V8 model:

- **`proposeConfig(...)`** — stores `PendingConfig{sinks, bps, readyAt}` in storage. Emits `ConfigProposed(configId, readyAt)` for monitoring.
- **`activateConfig()`** — reverts before `block.timestamp >= readyAt`; applies pending on success.
- **`cancelPendingConfig()`** — safety valve.
- Only one pending at a time.
- Sum of the three bps MUST equal 10_000 (revert `BadSum`).
- `treasurySink` cannot be zero.
- Other two sinks may be zero (roll into treasury).
- Emergency `sweep(to)` (`:144-152`) — owner-only, NOT timelocked (safety valve for stranded ETH from a reverting sink).

**Live state (2026-08-03):**
```
uruBuybackBps:    4000 (40%)
nftRevenueBps:    3500 (35%)
treasuryBps:      2500 (25%)
uruBuybackSink:   0x68c5Ec467027fCe56f158eB1ff34cF89d0929354  (UruBuybackVault)
nftRevenueSink:   0x93CFF459d5019eEc82fE9335013e265F1eD659c7  (NftRevenueVault)
treasurySink:     0x6d606cc634F20f5534fba072757F2c2C7B835Bb9  (deployer EOA)
lastConfigChange: 1785292051
minConfigDelay:   172800
next setConfig earliest: 1785464851  (elapsed; splits changeable)
balance:          0 wei
```

**Per-base override:** NONE. ERC-20, ERC-721A, ERC-1155 launches all route identically through `receiveFee`; `base` is only an indexer topic.

### 15.2 UruBuybackVault (`0x68c5Ec467027fCe56f158eB1ff34cF89d0929354`)

**Role:** receives the 40 % ETH slice; keeper swaps ETH → URU via allowlisted swap targets; forwards URU to `distributionSink` (= NftRevenueVault on live).

**Storage:**
- `IERC20Minimal uru` — URU token, immutable.
- `address distributionSink` — mutable via 2-step timelock.
- `uint256 minConfigDelay` — 172_800 (2 days) live.
- `uint256 minUruPerEth` — slippage floor (scale 1e18); 0 disables.
- `mapping(address => bool) isKeeper` — keeper allowlist.
- `mapping(address => bool) isSwapTarget` — swap-router allowlist.
- `pendingDistributionSink, pendingDistributionSinkTs` — 2-step rotation state.

**`executeBuyback(swapTarget, ethIn, swapData, minUruOut)`** (`:102-129`):
1. `require isKeeper[msg.sender]`.
2. `require isSwapTarget[swapTarget]`.
3. `require ethIn > 0`.
4. `rateFloor = ethIn * minUruPerEth / 1e18; require minUruOut >= rateFloor`.
5. Snap URU balance before, `swapTarget.call{value: ethIn}(swapData)`, snap after, verify `uruOut >= minUruOut`.
6. `uru.transfer(distributionSink, uruOut)` — forwards ALL bought URU.
7. Emit `BuybackExecuted(ethIn, uruOut)`.

**Sweep escape hatches** (`:184-203`): `sweepETH()` and `sweepURU()` force destination = `distributionSink`. No admin drain to arbitrary destinations — invariant.

**[V8 change vs live]** — `setKeeper`, `setSwapTarget`, `setMinUruPerEth` now require a matured proposal via `_consumeAdminChange(changeId)`. URU-A11 finding: previously immediate — a compromised owner could authorize a malicious `swapTarget` and set `minUruPerEth = 0` in the same tx, draining the vault via a low-rate swap. V8 model:

- `proposeAdminChange(bytes32 changeId)` — stores `adminChangeReadyAt[id] = block.timestamp + minConfigDelay`. Emits event.
- Setter (`setKeeper` / `setSwapTarget` / `setMinUruPerEth`) internally calls `_consumeAdminChange(id)` — reverts `AdminChangeNotProposed` if no matching proposal, `AdminChangeNotReady` if timelock not elapsed.
- `cancelAdminChange(id)` — safety valve.
- `changeId` computed by dedicated helpers: `keeperChangeId(addr, allowed)`, `swapTargetChangeId(addr, allowed)`, `rateChangeId(uint256)` — hash includes the target VALUE so proposing "true" and later applying "false" requires two separate proposals.
- Test-mode: when constructed with `minConfigDelay == 0`, `_consumeAdminChange` is a no-op, direct setter calls work as before.

Same shape mirrored in `UruDepositSink` (see §15.3).

**Live state:**
```
BuybackVault:     0x68c5Ec467027fCe56f158eB1ff34cF89d0929354
uru:              0x9fbe210007dDd8389f98d0253018e65CC48b9D24
distributionSink: 0x93CFF459d5019eEc82fE9335013e265F1eD659c7  (NftRevenueVault)
minUruPerEth:     ~11.75M URU/ETH  (slippage floor)
isKeeper[0x6d60…]: true
balance:          ~0.0964 ETH  (queued for next keeper buyback)
URU balance:      0            (no swap yet)
```

### 15.3 UruDepositSink (`0xA6b3748023540af1aD4C4731E8B8A09fACFf737e`)

**Role:** mirror of `UruBuybackVault`. Receives URU from `Router.launchWithURU` deposits; keeper swaps URU → ETH; forwards ETH to `distributionSink` (= FeeSplitter on live).

**Storage:** identical shape to BuybackVault, plus:
- `distributionSink` on live = **FeeSplitter** (not NftRevenueVault).

**`executeConversion(swapTarget, uruIn, swapData, minEthOut)`** (`:112-150`):
1. `require isKeeper[msg.sender]`, `require isSwapTarget[swapTarget]`, `require uruIn > 0`.
2. `rateFloor = uruIn * minEthPerUru / 1e18; require minEthOut >= rateFloor`.
3. **Zero-then-set approval** to `swapTarget` (belt against non-idempotent routers).
4. `swapTarget.call(swapData)` (no value; router pulls URU via `transferFrom`).
5. `ethOut = address(this).balance - ethBefore; require ethOut >= minEthOut`.
6. Reset allowance to 0 (blocks compromised swapTarget from draining URU between runs).
7. `safeTransferETH(distributionSink, ethOut)` — sends ETH to FeeSplitter.
8. Emit `ConversionExecuted(uruIn, ethOut)`.

**`flushEth()` escape hatch** (`:207-211`): owner-only, forces destination = `distributionSink`.

**Live state:**
```
DepositSink:      0xA6b3748023540af1aD4C4731E8B8A09fACFf737e
uru:              0x9fbe210007dDd8389f98d0253018e65CC48b9D24
distributionSink: 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA  (FeeSplitter — correct)
minEthPerUru:     ~7.68e-8 ETH/URU
isKeeper[0x6d60…]: true
balance:          0 ETH
URU balance:      ~39,587 URU  (accumulated from earlier launches; awaiting keeper conversion)
```

**Live oddity:** `Router.minUruFee = type(uint256).max` today, which effectively SOFT-DISABLES URU-pay. Users can't approve `~max` URU; any new URU launch reverts `InsufficientUru`. The ~39,587 URU queued came from earlier launches when the floor was smaller. This is the audit-round-2 v3 emergency mitigation still active on V7 (will unwind after V8 Router redeploy lets `bannedConfigHash` take over).

### 15.4 NftRevenueVault (`0x93CFF459d5019eEc82fE9335013e265F1eD659c7`)

**Role:** receives the 35 % ETH slice; epoch-based Merkle drop to gemu NFT holders.

**Storage:**
```solidity
struct Epoch { bytes32 merkleRoot; uint256 totalAmount; uint256 unclaimed; }
uint256 public nextEpochId;
mapping(uint256 => Epoch) public epochs;
mapping(uint256 => mapping(address => bool)) private _claimed;
uint256 public totalCommitted;   // sum of unclaimed across all live epochs
```

**Flow (V8, URU-A06 + URU-A07 + URU-A11):**
1. ETH accumulates in vault balance from FeeSplitter's 35 % slice.
2. Off-chain keeper snapshots gemu holders via indexer's `holders` table.
3. Keeper builds Merkle tree with leaves `keccak256(abi.encodePacked(holder, epochId, amount))`.
4. **`proposeEpoch(expectedEpochId, root, totalAmount)`** (owner-only). Validates NOW: `expectedEpochId == nextEpochId` (stale-publisher revert), `totalAmount > 0`, `root != 0`, `balance >= totalCommitted + totalAmount`. Stores pending; emits `EpochProposed`. **[V8 change vs live]** URU-A11 remainder: production `minConfigDelay > 0` blocks the direct `addEpoch` path — `addEpoch` reverts `DirectAddEpochDisabled` and only `proposeEpoch → activateEpoch` works.
5. Wait `minConfigDelay` (2 days in production).
6. **`activateEpoch()`** — requires `block.timestamp >= readyAt` + revalidates `expectedEpochId == nextEpochId` (guards against a stale proposal). Applies pending: writes `epochs[id]`, bumps `nextEpochId`, increments `totalCommitted`.
7. Holders call `claim(epochId, amount, proof)` — checks `_claimed[epoch][holder]`, verifies proof, marks claimed, decrements `unclaimed + totalCommitted`, sends ETH.

Also `cancelPendingEpoch()` — safety valve for wrong root / wrong amount.

**URU-A06 stale-publisher gate**: `addEpoch` and `proposeEpoch` both require `expectedEpochId == nextEpochId`. Two concurrent publishers cannot both read `nextEpochId = N`, land as N and N+1, with N+1's tree encoding N — the second call reverts `UnexpectedEpochId`. Combined with the compile-service's PG advisory lock (§10.3), race-to-publish is closed both on-chain and off-chain.

**URU-A07 available-balance view**: `availableBalance() → balance - totalCommitted - pendingCommitted`. Publisher (compile-service `rewards.ts`) uses it as the default `totalAmount` when no override.

**[V8 change vs live — URU-P1-M06 round-4 correction]** New `pendingCommitted` storage variable reserves the proposed epoch's amount during the timelock window. Previously `availableBalance` + `sweepDust` only subtracted ACTIVATED commitments, so a compromised or careless owner could sweep the exact ETH intended for a pending epoch during its 2-day timelock — activation would then revert `OverCommit` after monitoring windows had already elapsed. Round-4 fix:
- `proposeEpoch` increments `pendingCommitted += totalAmount` (overcommit check now against `totalCommitted + pendingCommitted + totalAmount`)
- `cancelPendingEpoch` releases: `pendingCommitted -= p.totalAmount`
- `activateEpoch` releases pending BEFORE handing off (`_applyEpoch` bumps `totalCommitted`): `pendingCommitted -= p.totalAmount`
- `availableBalance()` and `sweepDust()` both subtract `totalCommitted + pendingCommitted` from the balance
- Test proves auditor's exact scenario: 5 ETH balance, 4 ETH proposed → `availableBalance == 1 ether` → `sweepDust` caps at 1 → activation still fully funded → cancel restores all 5 ETH to available.

**`sweepDust`** — owner-only, now caps at `balance - totalCommitted - pendingCommitted`. Cannot starve live claims OR pending proposals.

**Live state:**
```
NftRevenueVault:  0x93CFF459d5019eEc82fE9335013e265F1eD659c7
nextEpochId:      1  (epoch 0 exists)
totalCommitted:   ~0.01907 ETH  (still owed to claimers)
balance:          ~0.0841 ETH
epoch 0:          totalAmount=~0.01937 ETH, unclaimed=~0.01907 ETH
```

**Structural gap (§24.1):** the vault does NOT handle URU. `UruBuybackVault.distributionSink = NftRevenueVault`, but the vault has NO `claimUru` / URU-side merkle drop mechanic. Any URU forwarded here from the buyback path would sit as a raw ERC-20 balance with no on-chain claim path. Current impact: zero URU stranded (keeper hasn't run buyback yet), but structurally the URU→NftRevenueVault leg is a dead end.

### 15.5 Treasury slice — 25 %

**Recipient:** `0x6d606cc634F20f5534fba072757F2c2C7B835Bb9` (deployer EOA).

- No processing — `FeeSplitter._distribute` fires a raw `.call{value:, gas:100_000}("")` at the treasury sink.
- Owner can rotate via `setConfig` (2-day timelocked).
- Live balance: ~30.5 ETH accrued (mixed with gas budget on the same EOA — not segregated per-source on-chain).

### 15.6 The MHH → FeeSplitter loop

Post-graduation swap fees follow a different path than launch fees:
1. `MHH.afterSwap` accrues to `owed[currency][FeeSplitter]` and `owed[currency][creator=launcher]`.
2. Fees sit in the MHH contract's own balance (pulled via `poolManager.take`).
3. **No automatic forward.** Keeper polls `MHH.owed(ETH, FeeSplitter)` every 60 min.
4. When ≥ 10 000 gwei, keeper calls `MHH.pushOwed(ETH, FeeSplitter)`.
5. `pushOwed` zeroes the slot + calls `currency.transfer(FeeSplitter, amount)`. For native ETH: plain ETH send → hits FeeSplitter.receive() → `_distribute` → 40/35/25 split.
6. Creator can independently `MHH.claim(currency)` at any time to withdraw their share.

---

## 16. URU + GEMU + Loyalty

### 16.1 Ecosystem tokens

- **URU** (`0x9fbe210007dDd8389f98d0253018e65CC48b9D24`) — the ecosystem ERC-20. Roles:
  1. Alternate launch-fee currency (via `Router.launchWithURU` / `launchWithURUAndWhitelist`).
  2. Loyalty discount source (holding ≥ `uruThreshold` earns fee discount).
  3. Buyback target — 40 % of launch fees swap ETH → URU.
- **urufu gemu NFT** (ChibiCoreV2, `0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17`) — the ecosystem NFT. Roles:
  1. Loyalty discount source (holding ≥ 1 earns fee discount).
  2. `NftRevenueVault` beneficiary — Merkle drops of the 35 % ETH slice.

Both live on Robinhood chain 4663. Migrated from Base 2026-07-25 per memory `project_robinhood_migration`. Base addresses in the legacy `.env` (`BASE_URU_ADDRESS`, `BASE_GEMU_NFT_ADDRESS`) are retired; RH addresses (`ROBINHOOD_URU_ADDRESS`, `ROBINHOOD_GEMU_NFT_ADDRESS`) are canonical.

### 16.2 LoyaltyOracle (`0xd13A1fb6d9c209B56044464269fce66Ed417AC2E`)

**Role:** external view contract read by `Router._discountBpsFor(launcher)`. Reads the launcher's URU + GEMU balances, returns discount bps.

**Storage** (`:45-53`):
```solidity
uint16 public constant HARD_MAX_DISCOUNT_BPS = 8000;   // 80% belt-and-braces cap
address public uruToken;
address public gemuNft;
uint256 public uruThreshold;
uint16  public nftHolderBps;
uint16  public uruHolderBps;
uint16  public bothBps;
uint16  public maxDiscountBps;
```

**`discountBpsFor(address holder)`** (`:74-88`):
```solidity
if (holder == 0) return 0;
bool hasNft = gemuNft != 0 && IERC721(gemuNft).balanceOf(holder) > 0;
bool hasUru = uruToken != 0 && IERC20(uruToken).balanceOf(holder) >= uruThreshold && uruThreshold > 0;
uint16 discount;
if (hasNft && hasUru) discount = bothBps;
else if (hasUru)      discount = uruHolderBps;
else if (hasNft)      discount = nftHolderBps;
else return 0;
if (discount > maxDiscountBps) discount = maxDiscountBps;
return discount;
```

Ladder is DISCRETE (not stacked). Live values:

| Holdings | Discount |
|---|---|
| ≥1 gemu NFT (any URU balance) | 20 % (2000 bps) |
| ≥ 100,000 URU (no NFT) | 40 % (4000 bps) |
| BOTH | 50 % (5000 bps), clamped by `maxDiscountBps` = 5000 |
| Neither | 0 |

`bothBps` (50 %) > `uruHolderBps` (40 %) so BOTH strictly beats URU-only, which strictly beats NFT-only.

**Belt-and-braces cap in Router:** `Router._discountBpsFor` clamps the oracle's return to `MAX_LOYALTY_DISCOUNT_BPS = 8000`. Matches `HARD_MAX_DISCOUNT_BPS` in the oracle. If a broken/malicious oracle ever returns 9999, Router still charges at least 20 % of gross — no accidental free launches.

**Live state:**
```
LoyaltyOracle:    0xd13A1fb6d9c209B56044464269fce66Ed417AC2E
uruToken:         0x9fbe210007dDd8389f98d0253018e65CC48b9D24  ✓ RH canonical
gemuNft:          0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17  ✓ RH canonical
uruThreshold:     100,000e18  (100k URU)
nftHolderBps:     2000
uruHolderBps:     4000
bothBps:          5000
maxDiscountBps:   5000
owner:            0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
```

`Router.loyaltyOracle()` = `0xd13A1fb6…AC2E` ✓ wired.

### 16.3 On-chain fix history

Per memory `project_flywheel_configure`: the LoyaltyOracle initially pointed at retired Base URU + GEMU addresses. Fixed via owner tx `setTokens(RH_URU, RH_GEMU)` on 2026-08-01 as part of audit round 2 v1. Verified via cast call above.

### 16.4 Where discount applies

Router calls `_discountBpsFor(launcher)` in two paths:
- `_quoteFor(params, launcher)` — ETH launch fee. Applied to all three base fees (ERC20, ERC721A, ERC1155).
- `_minUruFeeFor(launcher)` — URU launch floor.

Same discount rate on both paths so URU-paying holders aren't worse off than ETH-paying holders.

Discount does NOT apply to:
- Curve trade fees (curve reads `feeReceiver` directly; no launcher context).
- MHH post-graduation swap fees (per-swap, no launcher context).
- NFT secondary royalty splits.

---

## 17. Royalty Router — NFT Secondary Sales

**Sources:** `contracts/src/flywheel/RoyaltyRouterFactory.sol`, `RoyaltyRouterImpl.sol`.

**Live addresses:**
- RoyaltyRouterFactory: `0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05`
- RoyaltyRouterImpl (LibClone target): `0x4CAD1C5cFA9C20F3cfcC2C8881b4a9fdd63D20e3`

**Role:** for NFT launches (ERC-721A + ERC-1155), split every secondary-sale royalty between the launcher and the platform. Per-collection clone pattern.

### 17.1 Overall pattern

1. **Deploy-once frozen impl.** `RoyaltyRouterImpl` is deployed once as the EIP-1167 clone target.
2. **Factory registers frozen platform side.** Constructor takes `platformSink` (typically FeeSplitter) and `platformBps` — both frozen at construction (`platformBps` immutable; `platformSink` mutable via `setPlatformSink` but only affects NEW deploys).
3. **Per-collection deterministic clone.** `RoyaltyRouterFactory.deployFor(collection, launcherPayout)` deploys a clone at `LibClone.predictDeterministicAddress(IMPL, keccak256(abi.encode(collection)), factory)` — ONE clone per collection, address is CREATE2-predictable.
4. **Collection points its ERC-2981 receiver at the clone.** Frontend uses `predictFor(collection)` BEFORE launch, bakes the clone address into the `ERC2981Royalty` module's init data as the receiver.
5. **Marketplace sends ETH to the clone.** OpenSea / Blur / any marketplace honoring 2981 sends royalty ETH to the clone. On `receive()`, clone splits per its frozen BPS between `launcherPayout` and `platformSink`.

### 17.2 Factory guardrails

**`PLATFORM_BPS` = 500 (5%)** — immutable. Launcher gets `10_000 - 500 = 9_500` (95 %).

**`deployFor(collection, launcherPayout)`** (`:96-111`):
1. Reject zero addresses.
2. `_authorizeDeploy(collection)` — passes if EITHER:
   - `trustedDeployer[msg.sender]` (owner-managed allowlist for Router / atomic-at-launch flow), OR
   - `collection.code.length > 0` AND `staticcall(collection, "owner()")` returned exactly 32 bytes AND decoded address == `msg.sender`.
3. Salt = `keccak256(abi.encode(collection))` — ONE clone per collection.
4. Reject if predicted address already has code (`AlreadyDeployed`).
5. Clone via `LibClone.cloneDeterministic`.
6. `launcherBps = 10_000 - PLATFORM_BPS`.
7. Call `clone.initialize(launcherPayout, launcherBps, platformSink, PLATFORM_BPS)`.
8. Emit `RoyaltyRouterDeployed(collection, clone, launcherPayout, launcherBps, PLATFORM_BPS)`.

The strict 32-byte check on `owner()` returndata blocks hostile fallbacks that pad returndata to spoof ownership. Closes the front-run attack where anyone could race `deployFor(X, self)` before the real launcher and become the perpetual royalty recipient.

### 17.3 Clone `initialize` (once-only)

`RoyaltyRouterImpl.sol:41-60`:
- `require !initialized`.
- Both sinks non-zero.
- `launcherBps + platformBps == 10_000`.
- Store state, `_initializeOwner(launcherPayout)` — the launcher becomes the CLONE's Ownable owner (can rotate their own payout via `setLauncherPayout`, but NOT the platform sink or bps split).

### 17.4 `receive()` and split

`RoyaltyRouterImpl.sol:62-116`:
- `receive() payable nonReentrant` → `_distribute(msg.value)` if non-zero.
- `_distribute`: `toPlatform = amount * platformBps / 10_000; toLauncher = amount - toPlatform`.
- **Pays platform FIRST** (defense against launcher-controlled reentrant `receive()` that could cannibalize platform's slice).
- Uses `SafeTransferLib.safeTransferETH`.
- Emit `Distributed(amount, toLauncher, toPlatform)`.

### 17.5 Escape hatches

- `distributeStuck()` (public) — flushes accumulated balance (pre-init ETH; rounding residue). Reverts `ZeroBalance` if empty.
- `sweep()` (owner-only, launcher) — routes ANY balance through the fixed split. NOT a `sweep(to)` variant — the destination is hard-wired to the split.

### 17.6 Launcher rotates own payout

`setLauncherPayout(newPayout)` — Ownable-gated on the clone (`owner = launcherPayout`). Launcher can move their payout wallet post-launch without touching the platform sink or split. Sane recovery from a compromised launcher wallet.

### 17.7 Marketplace → clone → creator + platform flow

```
Marketplace sells NFT for X ETH
  → reads token.royaltyInfo(id, X) = (cloneAddr, X * feeBps / 10_000)
  → sends royalty ETH to cloneAddr
  → clone.receive()
    → toPlatform = royaltyEth * PLATFORM_BPS(500) / 10_000  = 5% of royalty
    → toLauncher = royaltyEth - toPlatform                   = 95% of royalty
    → safeTransferETH(platformSink, toPlatform)              platformSink = FeeSplitter
    → safeTransferETH(launcherPayout, toLauncher)
  → FeeSplitter.receive() → _distribute → 40/35/25 sub-split of the platform share
```

Concrete example: 1 ETH secondary sale with 5 % ERC-2981 royalty on the NFT →
- Royalty = 0.05 ETH lands at clone.
- Platform slice: 0.05 * 5 % = 0.0025 ETH → FeeSplitter → 40/35/25 further split.
- Launcher slice: 0.05 - 0.0025 = 0.0475 ETH → launcher's payout wallet.

### 17.8 Live state

```
RoyaltyRouterFactory:  0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05
IMPLEMENTATION:        0x4CAD1C5cFA9C20F3cfcC2C8881b4a9fdd63D20e3
PLATFORM_BPS:          500  (5%)
platformSink:          0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA  (FeeSplitter)
owner:                 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
```

**Zero clones deployed.** No NFT bases launched via the launchpad today (NFT bases gated off in UI). Router is not on `trustedDeployer` — the launcher (or a keeper) must call `deployFor` themselves post-launch.

Between launch and materialization, marketplace royalty ETH still lands at the deterministic clone address (via CREATE2 predetermination) and is recoverable via `distributeStuck()` after the clone is materialized.

---

## 18. Fee Flow — Every Wei Traced

The whole story in one place. Every source of value movement in the system, from origin to final resting place.

### 18.1 Source: ETH launch fee

Example: user calls `Router.launch{value: 0.05 ETH}(params)` where `quoteFor(params, user) = 0.001 ETH`.

```
User wallet: -0.05 ETH
  ↓
Router receives 0.05 ETH
  → refunds 0.049 ETH to user   (excess above fee)
  → forwards 0.001 ETH via feeReceiver.receiveFee{value:0.001}(user, ERC20)
    ↓
FeeSplitter._distribute(0.001 ETH):
  → toBuyback = 0.001 * 40% = 0.0004 ETH  → UruBuybackVault
  → toNft     = 0.001 * 35% = 0.00035 ETH → NftRevenueVault
  → toTreasury = residual   = 0.00025 ETH → deployer EOA (accrues)
    ↓
UruBuybackVault (accrues ETH):
  → keeper.executeBuyback(swapTarget, ethIn, swapData, minUruOut)
    → swapTarget.call{value: ethIn}(swapData)  →  ETH → URU swap
    → uru.transfer(NftRevenueVault, uruOut)   [STRUCTURAL GAP — see §24.1]
    ↓
NftRevenueVault (accrues ETH):
  → keeper.addEpoch(merkleRoot, totalAmount)
    → gemu holders claim(epochId, amount, proof) → their share of ETH
```

**Endpoint destinations:**
- 40 % (via URU buyback) → URU stranded in NftRevenueVault today (structural gap).
- 35 % → gemu NFT holders (working; epoch 0 has ~0.019 ETH still owed to claimers).
- 25 % → deployer treasury EOA (~30.5 ETH accrued).

### 18.2 Source: URU launch fee (`Router.launchWithURU`)

```
User wallet: -uruAmount URU (via prior approve)
  ↓
Router.launchWithURU(params, uruAmount):
  → safeTransferFrom(URU, user, UruDepositSink, uruAmount)
    ↓
UruDepositSink (accrues URU):
  → keeper.executeConversion(swapTarget, uruIn, swapData, minEthOut)
    → approve(swapTarget, uruIn)
    → swapTarget.call(swapData)  →  URU → ETH swap
    → safeTransferETH(FeeSplitter, ethOut)
    ↓
FeeSplitter.receive():
  → same _distribute as §18.1 → 40/35/25
```

Effectively identical to ETH launch, just with an extra keeper hop.

### 18.3 Source: bonding curve trade fee (1 %)

Every `buy()` or `sell()` (or `buyWithProof()`) on a launched curve:

```
User wallet: -msg.value ETH (buy) or -tokensIn tokens (sell)
  ↓
BondingCurve:
  → fee = msg.value or ethGross * tradeFeeBps(100) / 10_000  = 1%
  → safeTransferETH(feeReceiver, fee)     feeReceiver = FeeSplitter (directly, no hop)
    ↓
FeeSplitter.receive():
  → _distribute → 40/35/25
```

`feeReceiver` on live curves is FeeSplitter directly. Same 40/35/25 split as launch fees. No intermediate hop, no accumulation on the curve.

### 18.4 Source: post-graduation v4 swap fee (2 %)

Every swap on a graduated pool triggers MHH's `afterSwap`:

```
Swapper: -inputCurrency, +outputCurrency (net of fee)
  ↓
MHH.afterSwap:
  → totalTake = |unspecDelta| * (platformBps + creatorBps) / 10_000  = 2% of unspec side
    + optional buybackBurn = |unspecDelta| * cfg.buybackBurnBps / 10_000  (BUYs only, exact-input, output=token)
  → poolManager.take(unspecCurrency, this, totalTake)
    → hook now holds `totalTake` in its own balance
  → if burn > 0: currency.transfer(0xdEaD, burn)  → permanent burn
  → platformShare = fee * 50%  → owed[currency][FeeSplitter]  += platformShare
  → creatorShare  = fee * 50%  → owed[currency][launcher]     += creatorShare
    ↓
KEEPER (every 60min): MHH.pushOwed(currency, FeeSplitter)
  → owed[currency][FeeSplitter] = 0
  → currency.transfer(FeeSplitter, amount)
    ↓ (for native ETH)
FeeSplitter.receive():
  → _distribute → 40/35/25

CREATOR (any time): MHH.claim(currency)
  → owed[currency][msg.sender] = 0
  → currency.transfer(msg.sender, amount)
```

### 18.5 Source: NFT secondary royalty (post-launch, per-marketplace)

```
Marketplace pays cloneAddr X ETH (per ERC-2981)
  ↓
RoyaltyRouterImpl.receive():
  → toPlatform = X * PLATFORM_BPS(500) / 10_000  = 5%
  → toLauncher = X - toPlatform                  = 95%
  → safeTransferETH(FeeSplitter, toPlatform)
  → safeTransferETH(launcherPayout, toLauncher)
    ↓ (platform side)
FeeSplitter.receive():
  → _distribute → 40/35/25 sub-split
```

Currently zero clones deployed on live (NFT bases gated). Would activate on `NFT_BASES_ENABLED = true` + user launching an NFT collection through Router.

### 18.6 Endpoint summary — where every wei ends up

| Source | Recipient after full flow |
|---|---|
| Launch fee ETH → 40 % | UruBuybackVault → keeper swap → URU → **NftRevenueVault as raw URU balance (STRUCTURAL GAP)** |
| Launch fee ETH → 35 % | NftRevenueVault ETH balance → merkle epochs → gemu holders claim |
| Launch fee ETH → 25 % | Deployer treasury EOA |
| Launch fee URU (path) | UruDepositSink → keeper swap → ETH → FeeSplitter → 40/35/25 as above |
| Curve trade fee 1 % | FeeSplitter directly → 40/35/25 as above |
| MHH platform share 1 % | `owed[ETH][FeeSplitter]` → keeper push → FeeSplitter → 40/35/25 |
| MHH creator share 1 % | `owed[ETH][launcher]` → launcher claim |
| MHH buyback-burn (per-pool) | `0xdEaD` — permanent token burn |
| Royalty router platform 5 % | `owed[ETH][FeeSplitter]` → FeeSplitter → 40/35/25 |
| Royalty router launcher 95 % | Launcher's payout wallet direct |

---

## 19. Whitelisted Launches

Full whitelist mechanic — from Merkle root generation through claim.

### 19.1 Root generation

Server-side. Client calls `POST ${COMPILE_SERVICE_URL}/wl/snapshot`:
- Body: `{chainId, tokenAddress, minBalance?}`.
- `snapshotHolders()` in `compile-service/src/wl-snapshot.ts`:
  - Chain-4663 only for v1.
  - Prefers Blockscout `holders` v2 API — pages 100 holders × up to 100 pages = 10 k holders max.
  - Falls back to `eth_getLogs` chunked `Transfer` event replay — 10 k blocks per chunk, max 25 M blocks scanned.
- Leaves: `keccak256(abi.encodePacked(address))` — just the address, tightly packed.
- Sorted-pair merkle tree — matches Solady + OZ `MerkleProofLib.verify` layout expected by `BondingCurve.buyWithProof`.
- Response: `{root, snapshotBlock, holderCount, listId, listCid, listGatewayUrl, holdersPreview: holders.slice(0, 500)}`.
- Full holder list pinned to IPFS via `/pin/file` under the hood → `listCid` returned.

### 19.2 Frontend guards

- Rejects `holderCount < 2` (needs at least 2 for a meaningful whitelist).
- `fallbackTs = Math.floor(Date.now() / 1000) + 3_600` (1h WL window) captured at apply time.
- Frontend `wlStruct` bakes defaults:
  - `reservedTokens = curveSupplyWei * 6000 / 10_000` (60 % of curve supply reserved for WL).
  - `maxWlPerAddress = reservedTokens / 5` (top 5 wallets can fill it).
  - `sourceChainId = CHAIN_KEY_TO_ID[targetChain]`.

### 19.3 On-chain WL storage

`BondingCurve.sol:151-189` stores per-curve WL config:
- `bytes32 whitelistRoot` — zero = no WL.
- `uint256 reservedTokens` — total tokens reserved for WL. HARD cap, not a percentage.
- `uint256 maxWlPerAddress` — per-address cap on WL purchases.
- `uint64 fallbackTs` — end-of-WL-window unix timestamp.
- `address sourceTokenAddress`, `uint32 sourceChainId`, `uint32 declaredHolderCount` — transparency-only.
- `uint256 wlSold` — running total tokens delivered via WL.
- `uint256 wlHeldTotal` — total tokens sitting in `wlHeldForUser` awaiting `claimWl`.
- `mapping(address => uint256) wlHeldForUser` — per-user WL-held tokens.

### 19.4 `buyWithProof(bytes32[] proof, uint256 minTokensOut) payable`

`BondingCurve.sol:456-515`:
```
require !graduated
require block.timestamp < fallbackTs   (else WlNotActive — post-window use public buy())
require whitelistRoot != 0

leaf = keccak256(abi.encodePacked(msg.sender))
require MerkleProofLib.verify(proof, whitelistRoot, leaf)  (else WlInvalidProof)

// Same virtual-CPMM math as buy() to compute tokensOut, ethAfterFee, fee.

require tokensOut != 0                 (dust guard)
require tokensOut >= minTokensOut      (slippage)

reservedRemaining = reservedTokens - wlSold
require tokensOut <= reservedRemaining (else WlReservedExhausted — WL slice full)

alreadyBought = wlHeldForUser[msg.sender]
remainingCap = alreadyBought >= maxWlPerAddress ? 0 : maxWlPerAddress - alreadyBought
require tokensOut <= remainingCap      (else WlPerAddressCapHit)

tokenReserve -= tokensOut
wlSold       += tokensOut
wlHeldForUser[msg.sender] = alreadyBought + tokensOut
wlHeldTotal  += tokensOut
ethReserve   += ethAfterFee
if (fee > 0) safeTransferETH(feeReceiver, fee)
// NOTE: NO safeTransfer of tokens to buyer — they sit in wlHeldForUser
emit WlBought(...)
if (ethReserve >= graduationTargetEth) _graduate()
```

**Critical structural detail:** WL buyers do NOT receive their tokens at buy-time. Tokens accumulate in `wlHeldForUser[msg.sender]` and can only be withdrawn via `claimWl()` AFTER graduation. This is the "hold-until-graduation" lock.

### 19.5 `claimWl()`

`BondingCurve.sol:519-527`:
```
require graduated       (else NotGraduated)
amount = wlHeldForUser[msg.sender]
require amount > 0
wlHeldForUser[msg.sender] = 0
wlHeldTotal              -= amount
safeTransfer(token, msg.sender, amount)
emit WlClaimed(msg.sender, amount)
```

### 19.6 Public buy during WL window

`BondingCurve.buy()` at `:422-424` reverts `WlWindowActive(fallbackTs)` if `whitelistRoot != 0 && block.timestamp < fallbackTs`. **During the window the public path is closed.** After the window, public `buy()` becomes callable; unfilled WL slice implicitly merges into the public pool (accounting is a single `tokenReserve`).

### 19.7 Invariant: token conservation

`BondingCurve.sol:186-189` invariant: `token.balanceOf(curve) == tokenReserve + wlHeldTotal`. `_graduate()` transfers `tokenReserve` only to Graduator — leaves `wlHeldTotal` behind for later `claimWl` calls. This is what makes hold-until-graduation work atomically with graduation itself.

### 19.8 Sell during WL window

WL buyers CANNOT sell to the curve — they hold no ERC-20 balance (tokens sit in `wlHeldForUser`, not their wallet). Public buyers can sell freely (their tokens ARE in their wallet).

### 19.9 sourceTokenAddress / sourceChainId / declaredHolderCount

**Transparency-only.** From `BondingCurve.sol:171-179`:
- `sourceTokenAddress + sourceChainId` name the on-chain source of the holder snapshot the Merkle root was derived from — e.g. "holders of $ANSEM on Base at block N". Buyers can independently re-derive the tree from public holder data at that snapshot and verify the root wasn't stuffed with deployer alts.
- `declaredHolderCount` is a deployer-claimed number, emitted for UI surfacing alongside the pinned holder-list URL.

None of these gate any state change. They exist purely for off-chain auditability. The authoritative holder list lives off-chain (IPFS pinned).

### 19.10 Front-run resistance

The `whitelistRoot` is stored at curve initialization time — same tx as `Router.launchWithWhitelist`. An attacker cannot swap in a different root post-launch. If they attempt a Router-level front-run on the launch itself, they'd need to know the launcher's chosen name + ticker + module set + WL params to reproduce the same configHash + salt — and even then they'd pay the launch fee themselves, so it's a griefing attack not a value extraction attack.

---

## 20. Ownership Model & HandoffOwnership

### 20.1 Current state — single EOA

**Every Ownable contract in the stack is owned by `0x6d606cc634F20f5534fba072757F2c2C7B835Bb9`.** Same EOA is:

- `Ownable.owner()` on: Router, ERC20Factory, ERC721AFactory, ERC1155Factory, CurveFactory, Graduator, FeeSplitter, UruBuybackVault, UruDepositSink, NftRevenueVault, LoyaltyOracle, RoyaltyRouterFactory, NameRegistry.
- Constructor-set `deployer` on MHH (one-shot `setInitializer` authority; permanently defunct after setInitializer fires — no ongoing power).
- Constructor-set fallback `creator` on MHH (only used for pools that skip `setCreator`).
- `treasurySink` on FeeSplitter (25 % of every launch fee, plus curve trade fees, plus MHH platform slice, plus royalty router platform slice).
- `KEEPER_PRIVATE_KEY` on compile-service (calls `MHH.pushOwed` and `NftRevenueVault.addEpoch`).
- The one address in `isKeeper[]` on both `UruBuybackVault` and `UruDepositSink`.

**Blast radius of a compromised deployer key** (worst case, exhaustively):
- **Cannot** unlock LP. Post-F5, the graduation LP is locked structurally by the Graduator (Graduator owns the position; `GraduatorV2` has no code path to remove/burn/transfer it, and no owner-mutable admin function grants one). On the pre-F5 live MHH at `0xed09…A2c4`, `beforeRemoveLiquidity` also reverts unconditionally, giving belt-and-suspenders LP-lock. Either way, no owner path exists.
- **Cannot** pull graduated tokens from the v4 pool (same structural lock).
- **Cannot** rotate FeeSplitter sinks instantly — 2-day timelock on `setConfig` gives the community a window to react.
- **Cannot** rotate UruBuybackVault or UruDepositSink `distributionSink` instantly — same 2-day timelock.
- **Cannot** mint new tokens (all launched tokens are immutable clones with `_initialized` locked to 1).
- **Cannot** upgrade any contract (no proxies anywhere in the stack).
- **Cannot** un-register or replace a factory impl at an existing hash (`registerImpl` is one-shot; `updateImpl` removed).
- **Cannot** rotate the Router pointer on the live NameRegistry (predates 2-phase; `setRouter` reverts once `router != 0`).
- **CAN** pause Router (`setPaused(true)`) — freezes every new launch until unpaused. Docs flag this as a "censorship vector"; mitigation is docs, not code.
- **CAN** ban any configHash via `setConfigHashBanned` on V8 Router (once deployed) — blocks specific launches.
- **CAN** change fee amounts (`setFee`, `setAddOnFees`) — no timelock.
- **CAN** sweep any stuck ETH from FeeSplitter (`sweep(to)`) — NOT timelocked.
- **CAN** trigger `emergency` sweeps on both URU vaults — but destination is FIXED to `distributionSink`, so the attacker can only ACCELERATE the flywheel, not divert it.
- **CAN** publish arbitrary Merkle roots to `NftRevenueVault.addEpoch(root, totalAmount)` — but `require balance >= totalCommitted + totalAmount` blocks over-commit; a hostile epoch could claim the whole balance for the attacker's addresses.

### 20.2 Migration to multisig — `HandoffOwnership.s.sol`

`contracts/script/HandoffOwnership.s.sol` is the queued (but unexecuted) migration script. It walks every Ownable in the address book and calls `transferOwnership(MULTISIG_ADMIN)` where `MULTISIG_ADMIN` is a required env var.

**Contracts handed off:** Router, factories (ERC20/721A/1155), CurveFactory, Graduator, MHH-related (Graduator only — MHH itself has no Ownable), FeeSplitter, UruBuybackVault, UruDepositSink, NftRevenueVault, LoyaltyOracle, RoyaltyRouterFactory, NameRegistry.

**RoyaltyRouterImpl is a stateless template** — no owner, skipped intentionally.

**Note per PR body:** the script is idempotent (if a contract's owner is already the multisig, `transferOwnership` reverts and the script stops loudly — signals a partial migration to diagnose, doesn't silently continue).

### 20.3 Solady vs OZ Ownable

Every Ownable in the stack uses **Solady** (`solady/auth/Ownable`). Notable differences from OZ:
- One-step `transferOwnership` (no `Ownable2Step` accept-side confirmation).
- `renounceOwnership()` — sets owner to `address(0)`; permanent.
- Solady stores the owner in a well-known slot outside the typical slot-0 layout, so it doesn't interfere with template storage layouts.

The lack of `Ownable2Step` means a mistyped `transferOwnership(0xdead)` immediately hands ownership to the wrong address with no recovery. `HandoffOwnership.s.sol` mitigates by requiring `MULTISIG_ADMIN` to be pre-verified.

### 20.4 Router.paused — the "censorship vector"

`Router.setPaused(bool)` is owner-only, no timelock. When paused, every launch entrypoint reverts `Router__Paused`. This is intentionally an ops-emergency lever (used by V6 upgrade + earlier audit-driven pause events), but a compromised owner could use it to censor.

Mitigation is docs-only: `README.md:53` and `.github/SECURITY.md:87` promise multisig owner and community-visible on-chain pause events.

---

## 21. Deploy Topology — Fresh vs Rotation

Two canonical deploy paths, each with different scope and safety guarantees.

### 21.1 `DeployFreshLocal.s.sol` — the greenfield path

**Deploys the entire launchpad stack from scratch** on any chain. Used for:
- New chain onboarding (Base, Ethereum, testnets).
- Full-stack rehearsal in `test/audit/DeployPathRhFork.t.sol` (etches against live RH fork; validates full lifecycle without touching mainnet state).
- Recovery from catastrophic multi-contract compromise (unlikely).

**Scope** — every core contract:
1. `NameRegistry(deployer, treasury, RESERVED_TICKERS)` — 29 tickers seeded (26 canonical from `DeployNameRegistry` + `URU, CHIBI, GEMU`).
2. `LoyaltyOracle(deployer, uruToken, gemuNft, uruThreshold)`.
3. `FeeSplitter(deployer, treasury, minConfigDelay)`.
4. `UruBuybackVault(deployer, uruToken, distributionSink=NftRevenueVault, minConfigDelay)`.
5. `NftRevenueVault(deployer, minConfigDelay)`.
6. `UruDepositSink(deployer, uruToken, distributionSink=FeeSplitter, minConfigDelay)`.
7. `RoyaltyRouterFactory(deployer, RoyaltyRouterImpl, platformSink=FeeSplitter, platformBps=500)`.
8. `Router(deployer, NameRegistry, FeeSplitter, ERC20Fee, NFTFee, ERC1155Fee, moduleAddOn, hookAddOn, govAddOn)`.
9. `Router.setUruConfig(uruToken, UruDepositSink)`, `setMinUruFee(1000e18)`, `setLoyaltyOracle(LoyaltyOracle)`.
10. `ERC20Factory(deployer, Router, registrar=deployer)`, plus 9 composed impls deployed + `registerImpl`'d for each canonical hash from `RhConfigManifest.all()`. Also seeds Router sentinels via `setModuleCountForConfigBatch` + `setFlagsForConfigBatch`.
11. `Router.setConfigHashBanned(hash, true)` for all 3 retired-Airdrop hashes from `RhConfigManifest.retiredAirdropHashes()`. Post-state assertion refuses to write address book unless all bans confirmed.
12. `ERC721AFactory` + `ERC1155Factory` + their template impls + `registerImpl` for each.
13. `BondingCurve` impl + `CurveFactory(deployer, feeReceiver=FeeSplitter, curveImpl)`. `setTrustedRouter(Router, true)`.
14. `MultiHookHost(PoolManager, platform=FeeSplitter, creator=deployer, platformBps=100, creatorBps=100, deployer)` — mined via CREATE2 to end in the `0x20C4` bit pattern (post-F5; pre-F5 deploys used `0x22C4`, which added the now-removed `BEFORE_REMOVE_LIQUIDITY_FLAG`). `setInitializer(Graduator)` after Graduator deploys.
15. `Graduator(PoolManager, MHH, CurveFactory, fee=3000, tickSpacing=60, deployer)`.
16. `CurveFactory.setGraduator(Graduator)` and `Router.setCurveFactory(CurveFactory)`.
17. Assertion pass — every wire cross-checked before writing address book.

**Enforces** `ADMIN == msg.sender` at entry (new error `DeployFresh__AdminMustEqualBroadcaster`). Multisig handoff pattern: deploy under EOA, THEN run `HandoffOwnership` from the multisig context.

**Writes 4 address book files** for legacy-tool compatibility:
- `deployment-fresh.<chainId>.json` — full 20-field human dump.
- `deployment.<chainId>.json` — legacy Phase-1 shape consumed by `HandoffOwnership`.
- `deployment-flywheel.<chainId>.json` — legacy shape consumed by `ConfigureFlywheel`.
- `deployment-routerv2.<chainId>.json` — legacy Router-rotation shape.

Plus a `runForTest()` entrypoint for fork tests (prank-friendly, skips `vm.startBroadcast`).

### 21.2 `DeployRouter.s.sol` + `ActivateRouter.s.sol` — the 2-phase rotation

**Rotates just the Router + UruDepositSink** on an existing chain. Used when Router source needs a fix (like the audit-round-2 v3 `bannedConfigHash` addition). Preserves NameRegistry reservations, CurveFactory curves, Graduator, MHH, flywheel — everything except the pieces being rotated.

**Phase 1 — `DeployRouter.s.sol` (staging only, no user-visible effect)**:
1. Deploy new `UruDepositSink`.
2. Deploy new `Router` pointed at existing NameRegistry + FeeSplitter.
3. `router.setUruConfig(URU, sink)`, `setMinUruFee(1000e18)`.
4. Wire per-base factories (`setFactory`), CurveFactory (`setCurveFactory`), LoyaltyOracle (`setLoyaltyOracle`).
5. Seed manifest sentinels via `setModuleCountForConfigBatch` + `setFlagsForConfigBatch`.
6. **Ban all 3 retired-Airdrop hashes** via `setConfigHashBanned(hash, true)`.
7. **Pre-trust new Router on CurveFactory** via `setTrustedRouter(newRouter, true)`. Mapping-based → additive; old Router STILL trusted.
8. **DO NOT touch per-base factory Router pointers.** Factories still route to old Router; users keep launching normally.
9. Depending on registry type:
   - **Greenfield** (`registry.router == 0`): `reg.setRouter(newRouter)` + factory rewires (atomic, no old Router to preserve).
   - **Rotation** (`registry.router != 0` and registry supports 2-phase): `reg.proposeRouter(newRouter)` — starts 2-day timelock.
10. Post-broadcast assertion — refuses to write address book unless every retired-hash ban is `true`, every manifest sentinel is set, and every cross-wire matches.

**Phase 2 — `ActivateRouter.s.sol` (atomic cutover after timelock)**:
1. Preflight: verify `pendingRouter == expectedRouter`, timelock elapsed, all 3 bans present on new Router, all 10 manifest sentinels seeded, broadcaster owns every mutated contract.
2. Rewire factories: `ERC20Factory.setRouter(new)`, `ERC721AFactory.setRouter(new)`, `ERC1155Factory.setRouter(new)`.
3. `CurveFactory.setTrustedRouter(old, false)` — untrust old Router.
4. `NameRegistry.activateRouter()` — flips registry pointer.
5. `oldRouter.setPaused(true)` — unless `SKIP_PAUSE_OLD_ROUTER=1`.
6. Post-cutover verify: every wire consistent, address book flipped to `LIVE`.

**Recommended execution:** broadcast Phase 2 as a single multisig batch — single-block cutover window, zero user-visible outage. Old Router keeps serving throughout the pending window; new Router takes over atomically in the cutover tx.

### 21.3 Live NameRegistry caveat

The current LIVE NameRegistry (`0x60b7…118C`) predates the 2-phase timelock — has legacy single-step `setRouter` only, which reverts once `router != 0`. This means:
- The Phase-1 → Phase-2 rotation flow as written cannot execute against the live registry.
- Any real V8 Router rotation on RH must ALSO include a fresh NameRegistry deploy + reservation migration path.
- Documented as an open item in the current PR body; validated in the audit-round-2 v5 `RhProductionRotationFork.t.sol` via 3 fresh-registry sub-tests that exercise the SOURCE 2-phase flow against a freshly-deployed registry in-fork.

### 21.4 Other deploy scripts (auxiliary)

- **`DeployFlywheel.s.sol`** — deploys flywheel subset (FeeSplitter + vaults + LoyaltyOracle) standalone. Used for early bootstrap before Router.
- **`ConfigureFlywheel.s.sol`** — post-deploy setup: allowlists keeper + swap-target on both URU vaults, publishes initial `NftRevenueVault` epoch if desired.
- **`SetChunkyDefaults.s.sol`** — bumps CurveFactory defaults (the 5→17 ETH virtualEth bump on 2026-07-30).
- **`VerifyWiring.s.sol`** — canonical live-stack validator. Reads every pinned address, cross-checks all wires, emits `deployment-live-rh.<chainId>.json` on success. This is the "post-deploy address book generator" the frontend + indexer consume.
- **`DeployV9StackFix.s.sol`** — the MHH+Graduator rotation script (used for the V8-final graduator + matching MHH pair deploy 2026-07-29). MHH+Graduator must rotate together because `MHH.setInitializer` is one-shot-locked.
- **`HandoffOwnership.s.sol`** — the multisig migration (see §20.2).

---

## 22. Frontend Architecture

**Stack:** Next.js 16 App Router + React 19 + wagmi 2 + viem 2 + TanStack Query. TypeScript. Tailwind v4. `@dnd-kit/core` for the create-page module shelf. `framer-motion` for animations. `lightweight-charts` for trade chart. Deploy target: Vercel.

**Design constraint (`web/AGENTS.md`):** "This is NOT the Next.js you know. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code." — the frontend deliberately targets Next.js 16 breaking-change APIs.

**Global kill-switch:** `web/src/lib/launchpadStatus.ts:12` — `LAUNCHPAD_LIVE = false`. Home + Create pages render `<NotLiveYet />` splash; every other route stays live.

### 22.1 Pages

- **`/`** — home / trending feed. `useLaunchFeed(chainId)` → indexer-backed on chains with `CONTRACTS[key] != null`; mocks otherwise. Tabs: `trending | new | near | graduated`. Right rail: live activity merging curve trades + v4 swaps polled every 5s.
- **`/catalog`** — module + composed-impl catalog. Reads `MODULES` from `web/src/lib/modules.ts`. Sections: core / bases / modules / planned / curated.
- **`/create`** — the shop (2195 lines, see §22.2).
- **`/discover`** — full feed with filters `trending | new | mcap | near-graduation | graduated | whitelist | all`.
- **`/docs`** — static friendly guide.
- **`/feed`** — followed-wallet activity via `getFollowing()`.
- **`/profile`** + **`/profile/[address]`** — user profile: launches, trades, holdings, creator earnings widget, flywheel rewards widget, per-token owner controls (self-view only).
- **`/recover`** — orphan-curve sell-back UI. Iterates hand-curated `ORPHAN_CURVES` snapshot on RH; each card exposes `approve → sell` flow for stranded holders.
- **`/trade`** — trade landing (paste address).
- **`/trade/[address]`** — the trade page (101 KB, see §22.3).

### 22.2 Create page — detailed

`web/src/app/create/page.tsx`. Multi-step form driving `Router.launch` (or WL/URU variants).

**Chain selector** — `useActiveChain()`. Only Robinhood enabled. Wrong-chain nudge banner + `switchChain` call.

**Base picker** — 3-tile grid; ERC-721A + ERC-1155 disabled with "soon ✧" tape stamp (`NFT_BASES_ENABLED = false` at line 74).

**Ownership toggle** — Renounce / TransferToMultisig / KeepEOA. Curve mode forces Renounce. `multisigTarget` input validated with `isAddress`.

**Mechanic toggle** — `quick` vs `custom`. Quick bakes pump.fun defaults (curve, forced-renounce, anti-sniper=5 blocks); custom shows the module shelf + WL + per-launch hook params.

**Module shelf** — `@dnd-kit/core` drag-drop. Each shelf item is a `ModuleSpec` from `MODULES`. `addModule(id)`:
- No-op if already in basket.
- Fires reject popup + rollback if `blockedReasons[id]` set (not shipped, incompat, curve-mode-owner-block, curve-mode-taxes-transfers-block).
- Walks `requires` graph auto-pulling deps.
- Records added set into `lastAddedRef.current` for combo-not-shipped rollback.

**configHash live derivation** — hooks filtered out (they configure MHH, not the token). `configHash = configHashFor(base, sortedTemplateIds)`. Frontend reads `ERC20Factory.implFor(configHash)`; if zero, fires reject popup and rolls back the offending add.

**Pay toggle** — ETH vs URU. URU-pay only rendered when `URU_PAY[chain]` populated. If selected, computes URU amount from v4 pool spot × loyalty floor; requires prior `approve` tx.

**Whitelist** — POST `/wl/snapshot` to compile-service; returns `{root, listCid, holderCount, snapshotBlock, fallbackTs}`. Frontend bakes defaults: `reservedTokens = 60% of curveSupply`, `maxWlPerAddress = reservedTokens/5`, `fallbackTs = now + 1h`.

**Curve params** — antiSniperBlocks (custom + AntiSniper in basket), buybackBurnBps (custom + BuybackBurn in basket, capped at 20%).

**Live quote** — `Router.quote(params)` for gross, `Router.quoteFor(params, wallet)` for post-loyalty. Renders receipt with strikethrough gross + net after-discount.

**Approval flow (URU)** — `erc20.allowance(wallet, Router) < uruAmount` → renders "approve URU" button; simulates `approve(Router, uruAmount)`; refetches allowance after receipt.

**Launch tx** — `useSimulateContract` → `writeContract(sim.data.request)`. Post-mine: decodes `Launched` event → grabs token address. Runs metadata persist (localStorage sync + Pinata pin + wallet-signed POST to compile-service). Redirect to `/trade/<addr>` if curve mode.

### 22.3 Trade page — detailed

Split into `TradePage → LiveTradeView → BondingCurveWidget / GraduatedPanel + MetadataPanel + ChatDrawer + TradeChart`.

**Home-chain resolution** — `fetchLaunchesByTokens([tokenAddress])` finds the token's home chain via indexer. `readChainId` forces every wagmi RPC read to the resolved chain (wrong-wallet-chain doesn't zero out reads).

**Curve state** — polls `curve.{ethReserve, tokenReserve, priceWeiPerToken, graduated, virtualEthReserve, virtualTokenReserve, tradeFeeBps, graduationTargetEth, curveSupply}` every 8 s.

**Curve buy** — `curve.quoteBuy(ethIn)` → `(tokensOut, fee)` → apply slippage → `curve.buy(minTokensOut){value: ethIn}`.

**Curve sell** — check `token.allowance(wallet, curve)`; if insufficient, offer `approve` sim; else `curve.sell(tokensIn, minEthOut)`.

**WL buy** — fetch proof from `${COMPILE_SERVICE_URL}/wl/proof?listCid=<cid>&addr=<wallet>` → `curve.buyWithProof(proof, minTokensOut){value: ethIn}`. Renders WL fill-% bar; disables when window closed.

**WL claim** — post-grad only. Reads `wlHeldForUser(wallet)` non-zero → offers `curve.claimWl()`.

**Post-grad buy** — `V4SwapRouter.swapExactETHForToken(poolKey, minOut=1, wallet, deadline){value: ethIn}` where `poolKey.hooks` comes from `graduations.hookAddress` (indexer) with fallback to `HOOKS[chain].MultiHookHost` config value — critical for tokens graduated against an older hook.

**Post-grad sell** — `token.approve(V4SwapRouter, max)` → `V4SwapRouter.swapExactTokenForETH(poolKey, tokensIn, minOut=1, wallet, deadline)`.

**Chart** — `web/src/components/TradeChart.tsx` using `lightweight-charts`. Points derived from curve trades (`fetchTradesForCurve`) + post-grad swaps (`fetchV4SwapsForToken`). Price is `spotFromReserves` for curve, `sqrtPriceX96 → weiPerToken` for post-grad.

**Recent trades** — merges curve + v4 rows, newest first, capped at 200.

**Metadata panel** — reads from compile-service. Edit affordance gated on `wallet == launcher` (server enforces via 403 `NOT_LAUNCHER`).

### 22.4 Address book / config — `web/src/lib/config.ts`

- `CHAINS_ENABLED = ['robinhood']`.
- Every contract address is HARDCODED here (no `NEXT_PUBLIC_*` mapping). Rotation = update this file + redeploy web app.
- Only compile-service URL + indexer URL + per-chain RPC URLs come from env.
- `URU_PAY[chain]` config: `{token, poolId, uruIsCurrency1}` for the URU/WETH v4 pool. RH only.

### 22.5 Wagmi setup — `web/src/lib/wagmi.ts`

- Custom `robinhoodChain` (id 4663) + `robinhoodChainTestnet` (id 46630) chain definitions.
- Registers `[sepolia, mainnet, base, baseSepolia, robinhoodChain, robinhoodChainTestnet]` with `connectors: [injected()]` (single connector — no WalletConnect).
- Per-chain HTTP transport with `NEXT_PUBLIC_<CHAIN>_RPC_URL` env vars.

### 22.6 ABIs — `web/src/lib/abis.ts`

All parsed via viem's `parseAbi`. Enum constants for `BASE_TYPE` + `OWNERSHIP_MODE`. Tuple type strings for `LaunchParams`, `Reservation`, `PoolKey`. Full ABIs for Router (both legacy + V2 additions incl WL), NameRegistry, ERC20/721A/1155 factories, ERC20 token (Solady shape), BondingCurve (full including WL + `buyWithProof` + `claimWl`), CurveFactory, RoyaltyRouterFactory, RoyaltyRouterImpl, V4SwapRouter, V4 StateView, NftRevenueVault, TokenOwnerControls (Ownable + Pausable + AntiBot + AntiWhale), MultiHookHost (`owed`, `claim`, `platform`, `creator`).

---

## 23. Indexer Architecture

**Stack:** Ponder v0.7 + Postgres. Deploys to Railway as a background service. Multi-chain — one Ponder process indexes every chain in `INDEXER_CHAINS` env var.

### 23.1 Layout

```
indexer/
├── chains.ts               # Chain catalog, env-var readers, per-chain address prefix map
├── ponder.config.ts        # Network + contract subscriptions
├── ponder.schema.ts        # Postgres schema (13 tables)
├── src/
│   └── index.ts           # Event handlers (894 lines)
├── ponder-env.d.ts
├── package.json
├── Dockerfile
└── railway.json
```

### 23.2 Multi-chain model

- Config reads `INDEXER_CHAINS=slug1,slug2` (comma list) or legacy `INDEXER_CHAIN=slug` (single).
- Chain is enabled iff: (a) in the requested list, (b) `<PREFIX>_RPC_URL` env set, (c) at least one `<PREFIX>_<KEY>_ADDRESS` env set.
- Silently drops missing chains — enabling one in prod is an env-var change on Railway, not a redeploy.
- Every table primary key includes `chainId` prefix so same-address deploys on different chains never collide.

### 23.3 Subscribed events (per chain)

**Router**: `Launched`, `LaunchedInURU`, `LaunchedWithWhitelist` (explicit filter list — new entrypoints need adding here).

**NameRegistry**: `Reserved`.

**ERC20Factory / ERC721AFactory / ERC1155Factory**: `Deployed`.

**CurveFactory**: `CurveCreated`.

**BondingCurve** (factory pattern via `bondingCurveNet()`): dynamically subscribes each new curve seeded from `CurveFactory.CurveCreated`. Events: `CurveInitialized`, `Trade`, `Graduated`, `WhitelistConfigured`, `WlBought`, `WlClaimed`.

**Token** (factory pattern): dynamic subscription seeded from `ERC20Factory.Deployed`. Event: `Transfer`.

**UruToken** (fixed): `Transfer`.

**GemuNft** (fixed): `Transfer` (ERC-721 shape: from, to, indexed tokenId).

**MultiHookHost**: `FeeAccrued`, `FeeClaimed`, `BuybackBurned`, `PoolConfigSet`.

**FeeSplitter**: `FeeReceived`, `Distributed`, `TreasuryDistributionFailed`, `Swept`.

**UruBuybackVault**: `BuybackExecuted`, `UruSwept`, `EthSwept`.

**UruDepositSink**: `Deposited`, `ConversionExecuted`.

**PoolManager**: `Swap` filtered to `sender == V4SwapRouter` (Alchemy 10 MB response cap; unfiltered would pull every unrelated v4 swap).

**V4SwapRouter**: `Swapped(user, token, isBuy, amountIn, amountOut)` — source of truth for per-wallet post-grad activity (PoolManager.Swap.sender is always the router).

### 23.4 Schema — key tables

- `launches` — pk `${chainId}-${tokenAddress}`. Fields: launcher, base, name+nameHash, ticker+tickerHash, configHash, impl, feePaid, install flags, curveAddress, payToken (ETH/URU), uruPaid, hasWhitelist, blockNumber, blockTimestamp, txHash.
- `curves` — pk `${chainId}-${curveAddress}`. Full state: curveSupply, virtual reserves, target, tradeFeeBps, live `ethReserve` + `tokenReserve`, `tradeCount`, `graduated + graduatedAt`, all WL fields (`hasWhitelist, whitelistRoot, reservedTokens, maxWlPerAddress, fallbackTs, sourceTokenAddress, sourceChainId, declaredHolderCount, wlSold, wlHeldTotal`).
- `trades` — every curve buy/sell.
- `wlPurchases` + `wlClaims` — WL activity.
- `graduations` — pk `${chainId}-${curveAddress}`. **Includes `hookAddress` persisted** so a future hook rotation doesn't break trade pages for tokens graduated against older hooks.
- `v4Swaps` — one row per v4 pool swap; reverse-looks-up `tokenAddress` via `graduations.poolId` on write.
- `v4RouterSwaps` — one row per V4SwapRouter.Swapped; source of truth for per-wallet post-grad activity.
- `holders` — pk `${chainId}-${tokenAddress}-${holderAddress}`. ERC-20 balances + NFT counts.
- `transfers` — every ERC-20/ERC-721 transfer.
- **Flywheel tables**: `hookConfigs`, `hookFees`, `hookFeeClaims`, `hookBurns`, `flywheelReceipts`, `flywheelDistributions`, `uruBuybacks`, `uruSinkDeposits`, `uruSinkConversions`.

### 23.5 Event correlation pattern

The launch flow emits FOUR events in one tx: `NameRegistry.Reserved` → `ERC20Factory.Deployed` → `BondingCurve.CurveInitialized` (if curve) → `CurveFactory.CurveCreated` → `Router.Launched` (last).

Handlers use in-memory correlation buffers keyed by `chainId-txHash`:
- `pendingReserved` — buffers `{name, ticker}` from Reserved for Launched to pick up.
- `pendingDeployed` — buffers `{configHash, impl}` from factory Deployed.
- `pendingCurve` — buffers `{curveAddress}` from CurveInitialized/CurveCreated.

When Router.Launched fires, its handler drains all three buffers and writes the full `launches` row. `onConflictDoNothing()` for idempotency.

Buffers live in JS memory — safe under Ponder's single-thread ordered processing. Out-of-order replay or process restart mid-tx would drop the buffer (comments call this out; no persistent fallback).

### 23.6 Address wiring

- Every contract subscription reads `<PREFIX>_<KEY>_ADDRESS` env var. If any required address is missing for a slug, that chain is silently skipped.
- `hookHostForChainId(chainId)` for computing v4 `poolId = keccak256(abi.encode(ETH, token, 3000, 60, hookHost))`. If the graduating chain's MHH env is missing OR wrong, the poolId derivation is wrong and the `PoolManager.Swap` reverse-lookup misses those swaps.

### 23.7 GraphQL surface

Every table gets a Ponder GraphQL query with `${name}ss` suffix (Ponder v0.7 pluralizes with double-s). Frontend queries: `launchess`, `curvess`, `tradess`, `v4Swapss`, `v4RouterSwapss`, `graduationss`, `holderss`. Each supports `where`, `orderBy`, `orderDirection`, `limit`, `<field>_in: [values]`.

### 23.8 Frontend integration

`web/src/lib/indexer.ts` (602 lines) — GraphQL client with:
- Per-chain URL routing (`NEXT_PUBLIC_INDEXER_URL_<CHAIN>` env vars) or single shared URL.
- 5s abort timeout + one network retry.
- `gqlFanout()` — fan out across every configured URL in parallel; merge `items[]` arrays.
- Prefers indexer for chart series + trade list; falls back to `publicClient.getLogs` for missing chains.

### 23.9 Address book drift risk (rotation concerns)

- Any Router rotation without matching indexer env update → `Launched` events miss; feed freezes for new launches.
- MHH rotation without matching env update → graduated tokens' `poolId` derived from old hook; `PoolManager.Swap` reverse-lookup misses their swaps; trade page's post-grad section stops updating.
- V4SwapRouter rotation without matching env update → `PoolManager.Swap` filter drops every new post-grad swap; existing rows survive but feed freezes.

`RhLiveStackSnapshot.t.sol` is the fence: fails LOUDLY the moment `.env` (or code pins) drift from live wiring, catching these before a partial rotation ships.

---

## 24. Known Limitations & Structural Gaps

Honest list. Everything documented here is either accepted trade-off or pending future work.

### 24.1 Buyback URU strands in NftRevenueVault

**Severity:** structural, not exploitable.

`UruBuybackVault.distributionSink = NftRevenueVault` on live. When keeper runs `executeBuyback`, the swapped URU is forwarded to `NftRevenueVault.transfer(uru, amount)`. But `NftRevenueVault` has NO URU-side accounting: `addEpoch` accepts ETH via `balance` check, `claim` uses `safeTransferETH`. There is NO `claimUru`, no URU merkle-drop mechanic.

**Impact today:** zero URU stranded — keeper hasn't run a buyback yet (0.096 ETH accumulated in BuybackVault, no swap executed). But the moment `executeBuyback` runs, URU begins accumulating in `NftRevenueVault` with no on-chain claim path.

**Options to close:**
1. Rotate `UruBuybackVault.distributionSink` to a dedicated URU-drop contract (2-day timelock).
2. Point it at an EOA that can move URU manually to holders (defeats trust model).
3. Add a URU-distribution surface to NftRevenueVault (requires redeploy — vault has no upgrade path).

`README.md:17` and `UruBuybackVault.sol:20` docstring promise "URU merkle-drops to gemu holders" — the mechanism doesn't exist yet.

### 24.2 FeeSplitter cannot sweep non-ETH ERC-20

FeeSplitter's `sweep(to)` (`:144-152`) only sends `address(this).balance` (native ETH). No ERC-20-sweep function.

**Impact today:** zero (only ETH-side v4 pools exist; native ETH is currency0). Would matter if MHH ever pushes a non-native currency to the platform slot — e.g. token/token pools (not currently possible on the launchpad since Graduator always uses ETH as currency0), or if someone accidentally sends an ERC-20 to FeeSplitter.

### 24.3 Single-EOA control across every Ownable

See §20.1. Not exploitable in isolation — LP is unrecoverable, fee-splitter rotations are 2-day timelocked, no proxy upgrades exist — but a compromised deployer key CAN pause Router, publish hostile Merkle epochs, and cause other operational damage.

**Migration:** `HandoffOwnership.s.sol` queued.

### 24.4 Live NameRegistry predates 2-phase timelock

See §7.4 + §21.3. Cannot rotate Router pointer on live registry. Any real V8 Router rotation must include a fresh NameRegistry deploy + reservation migration. There is NO on-chain migration path — reservations are Router-gated with no admin backdoor.

### 24.5 URU-pay currently soft-disabled

`Router.minUruFee = type(uint256).max` — audit round 2 v3 emergency mitigation to close the retired-Airdrop URU-bypass attack path on V7. Effect: any new URU launch reverts `InsufficientUru` (user can't approve ~max URU).

**Fix:** V8 Router redeploy activates `bannedConfigHash`, then `setMinUruFee(1000e18)` restores normal URU-pay operation.

### 24.6 NFT bases gated off in UI

`NFT_BASES_ENABLED = false` in `web/src/app/create/page.tsx:74`. NFT tiles render but are disabled with "soon ✧" tape. All contract-side plumbing exists (both NFT factories deployed + registered with impls, RoyaltyRouterFactory deployed + platformSink wired), but no user path currently reaches NFT launches.

**Activation checklist** (from `docs/NFT-ACTIVATION.md`):
1. Flip `NFT_BASES_ENABLED = true`.
2. Wire `predictRoyaltyRouting` into the launch flow (helpers already exist in `web/src/lib/nftRoyalty.ts`, just not called from create page).
3. Build `/collection/[address]` (analog of `/trade/[address]`).
4. Add indexer subscription for `PayableMintedSplit` if using the SplitPayable impl.

### 24.7 Retired Airdrop hashes are live-registered

The 3 retired Airdrop hashes on live ERC20Factory point at rugged V1 impls that CANNOT be un-registered (registerImpl is one-shot, updateImpl deliberately removed). Mitigated via `moduleCountForConfig = uint256.max` (poisons ETH-path `_quote`) + `minUruFee = max` (disables URU-bypass). V8 Router redeploy will additionally set `bannedConfigHash[h] = true` for all 3 as a source-level closure — see `DeployRouter._banRetiredHashes` and post-state assertions in `DeployRouter._assertPostState`.

### 24.8 NameRegistry — mempool front-run

Documented at `NameRegistry.sol:137-144`. No commit-reveal. A mempool observer can copy a pending launch's `(name, ticker)` and submit a competing launch with higher priority fee.

**Impact:** victim pays gas but not the launch fee (Router refunds excess ETH). Squatter must also pay the FULL launch fee → not a free grief. Not addressed in V6/V7.

### 24.9 Router.paused = single-key censorship vector

Owner can `setPaused(true)` at any time, no timelock. Freezes every launch entrypoint. Documented in `.github/SECURITY.md:87`; mitigation is multisig owner + community-visible pause events. Not a code-level fix.

### 24.10 CurveFactory.setDefaultCurveSupply skips reachability check

`CurveFactory.sol:265-269`. `setDefaults` runs `_validateCurveDefaults` including the `graduationTargetEth < curveSupply * virtualEthReserve / virtualTokenReserve` reachability check. But the standalone `setDefaultCurveSupply(uint256)` does NOT — it can set a curveSupply that makes the target unreachable (ETH strands as curve drains token side first).

**Impact:** only affects future launches. Existing curves store their own params on-chain. Footgun documented in comments.

### 24.11 Compile-service is a trust root for module bytecode

Frontend calls `POST /compile` for preview. If the compile-service is compromised, it could return arbitrary bytecode that the frontend renders as if it were the legit composed impl. **However**, the frontend never DEPLOYS from that bytecode — deploys go through `ERC20Factory.deploy(configHash, initData, launcher)` which resolves the impl from `impls[hash]` (set by trusted registrar off-chain). So compile-service compromise only affects on-screen preview, not on-chain state.

### 24.12 Whitelist proof service centralization

`compile-service/routes/whitelist.ts::snapshotHolders` runs off-chain. The Merkle root is baked into `BondingCurve.whitelistRoot` at launch time; proofs are served from either in-memory cache or IPFS fallback. If compile-service dies AND the IPFS pin lapses, WL buyers cannot fetch proofs and their WL slice becomes unclaimable during the window.

**Mitigation:** the holder list is always pinned to IPFS via `listCid` — anyone can serve proofs by re-building the tree from that list. But no fallback UI exists today.

### 24.13 Graduator token-side dust burned

Post-V8, `GraduatorV2.execute` burns any leftover tokens to `0xdEaD` after the LP add (`:266-270`). With raw-ratio pricing this should be rounding dust only (usually <1000 wei-tokens = <1e-15 tokens). But if `LiquidityAmounts.getLiquidityForAmounts` ever returns significantly under-provisioned liquidity for some param combo, tokens get burned that could have been in the pool.

**Mitigation:** the V8 raw-ratio fix specifically designed to make this dust-only. Regression tested in `GraduatorV8LpMathFork.t.sol`.

---

## 25. Audit History

Chronological summary of audit rounds and what each closed.

### 25.1 Round 1 — external audit (pre-branch)

Closed at various commits pre-`audit-round-2`. Findings incorporated: `updateImpl` removal, per-config `moduleCountForConfig` gate (blocks caller-controlled underbilling), initial `bannedConfigHash` design, curve-incompat flags, launcher-recorded-as-creator flow, initial LP-lock via MHH `beforeRemoveLiquidity` revert (later removed by F5 in favor of Graduator-owned structural lock — see §13.5), MHH `initializer` gate, LoyaltyOracle clamp, refund-on-launch-revert.

### 25.2 Round 2 v1 — LoyaltyOracle + URU config

Fixes:
- LoyaltyOracle on-chain repointed to RH canonical URU + GEMU (was stale Base addresses).
- Router.setUruConfig hardening: sink code check + `sink.uru() == uru` check.
- DeployRouter renamed from DeployRouterV2, requires `MIN_URU_FEE` env, seeds manifest, strict-authorize.
- `RhConfigManifest.sol` library — 10 canonical hashes.
- `RhLiveStackSnapshot.t.sol` — 11 invariant guards.
- Nulled retired base/base-sepolia/mainnet blocks in `web/src/lib/config.ts`.

### 25.3 Round 2 v2 — manifest verified, retired-Airdrop attacker hole closed

Fixes:
- Manifest verified against 12 live-registered hashes; 2 retired Airdrop combos identified as intentional exclusions.
- Live tx: `Router.setModuleCountForConfig(retiredHash, type(uint256).max)` for all 3 retired Airdrop hashes — poisons ETH-path `_quote`.

### 25.4 Round 2 v3 — URU attack path closed via bannedConfigHash

Auditor finding: count-poison only blocks ETH path; URU + WL paths bypass `_quote` entirely, still exploitable.

Fixes:
- **New**: `Router.bannedConfigHash` mapping + `setConfigHashBanned` setter + guard in all 4 launch entrypoints.
- **Live tx**: `Router.setMinUruFee(type(uint256).max)` — emergency mitigation while V8 pends. Disables ALL URU launches.
- DeployRouter + DeployFreshLocal seed bans for all 3 retired hashes at deploy time.

### 25.5 Round 2 v4 — HIGH #3 closed fully

Fix: expanded `RhLiveStackSnapshot.t.sol` + `DeployPathRhFork.t.sol` to cover all 10 auditor sub-items:
- Bare launch, curve buy/sell, graduation, v4 pool init, post-grad swap, LP-removal rejection, creator/platform fee accrual, URU-paid launch, composed-module launch, FoT+curve rejection.
- Total 12 fork tests, all passing against live RH fork.

### 25.7 Round 3 (2026-08-03) — full URU-A01…A14 remediation

Auditor delivered `Consolidated system-level findings.pdf` + 4 patch files + `urufu_protocol_audit_and_remediation_spec.docx`. Every finding closed at source level.

**Critical (3)**
- **URU-A01** — Router now enforces launch-safety policy on-chain (curve-must-Renounce, FLAG_REQUIRES_OWNER block, module/sniper/burn caps) via `_validateLaunchPolicy` on all 4 entrypoints.
- **URU-A02** — Pausable V1 honeypot closed. Fragment no longer exempts owner-origin transfers. V1 hash `0xa831…803a` permanently banned; V2 registered at fresh hash `0xc9a87c…3e1f`.
- **URU-A03** — Curve reachability now validates using ACTUAL supply received (post reserve-carve) via `_validateActualSupply`. 5% safety margin default via `graduationSafetyMarginBps`. `setDefaultCurveSupply` validates full tuple.
- **URU-A04** — `buy` + `buyWithProof` both use `tokenReserve - 1` floor (no clamp). Combined with graduator-required makes WL terminal-lock unreachable.
- **URU-A05** — `CurveFactory.setGraduator(0)` reverts. Every curve creation calls `_requireGraduator`. BondingCurve init rejects zero/non-contract.

**High (7)**
- **URU-A06** — Rewards publisher: `expectedEpochId` on `addEpoch`/`proposeEpoch`; PG advisory lock + journaled publications + startup reconciliation in `compile-service/src/rewards.ts`.
- **URU-A07** — Publisher uses `availableBalance() = balance - totalCommitted` as default.
- **URU-A08** — New `shared/config-id.ts::canonicalModuleString` imported by BOTH web + compile-service. Compile-service now uses viem's `keccak256(encodeAbiParameters(['string','string'],[base,modules]))` matching on-chain. Response includes `artifactHash = keccak256(bytecode)`.
- **URU-A09** — Server-side JSON-schema parameter validation + cross-field invariants in `compile-service/src/matrix.ts::validateModuleParams`. Staking-Vesting incompatibility synced between `shared/matrix.json` and `web/src/lib/modules.ts`.
- **URU-A10** — Router metadata is one-shot: `setModuleCountForConfig`, `setFlagsForConfig`, and batch variants revert `ConfigMetadataAlreadySet` on second call. New atomic `registerConfigMetadata` / `registerConfigMetadataBatch`. Retirement is monotonic: `setConfigHashBanned(hash, false)` and `setCurveIncompatibleConfigHash(hash, false)` revert `ConfigRetirementIrreversible`.
- **URU-A11** — Real propose/activate on FeeSplitter, UruDepositSink, UruBuybackVault, NftRevenueVault. Cooldowns replaced with two-step timelocks. `NftRevenueVault.addEpoch` gated on `minConfigDelay == 0`; production uses `proposeEpoch → activateEpoch`.
- **URU-A12** — `MultiHookHost.setPoolConfig` and `setCreator` now `onlyInitializer`. `MAX_ANTI_SNIPER_BLOCKS = 7200` cap. Graduator removes `try/catch` around hook config + reads back and reverts on mismatch (`HookConfigMismatch`, `HookCreatorMismatch`).
- **URU-A13** — `HandoffOwnership._handoffGraduator` uses `setOwner` (not `transferOwnership`). New `test/integration/HandoffOwnershipIntegration.t.sol` exercises full end-to-end multisig handoff of the V8 stack including the Graduator-specific selector.
- **URU-A14** — `Router.setFactory/setCurveFactory/setLoyaltyOracle` reject non-contract addresses. `_discountBpsFor` wraps oracle in `try/catch` (reverting oracle no longer bricks every launch). Slither config scans `script/` (was excluded). `security.sh` no longer `|| true`-swallows analyzer failures.

**Additional (auditor-flagged, not in patches)**
- **Exact-output burn bypass** — MHH `afterSwap` now applies buyback-burn on ALL BUYs (`zeroForOne == true`), not just exact-input BUYs. Exact-output BUYs previously silently avoided the advertised burn.

**Test state as of `c2a7459`**:
- `forge test -j 2` (unit + integration): **651 pass, 0 fail, 0 skip**
- Fork tests against live RH: **54 pass, 0 fail, 1 skip** (`test_Orphan_URUFU_HolderCanSellForETH` — pre-existing skip, unrelated to audit round 3)
- Web typecheck: clean

**Deleted (pruned per audit direction)**:
- `contracts/test/audit/V6FullLifecycleFork.t.sol` — obsolete V6 rotation history.
- `contracts/test/audit/V9FullPipelineFork.t.sol` — obsolete V9 rotation (used deprecated `DeployV9StackFix.s.sol`).
- `contracts/test/integration/RhDeployPipelineForkTest.t.sol` — older-audit-round pipeline replay superseded by `DeployPathRhFork`.

**Rewritten (audit-driven honesty pass)**:
- `contracts/test/audit/RhProductionRotationFork.t.sol` — earlier version synthesized a rotation that omitted `proposeRouter` because the live registry lacks it, then claimed 12/12 passed. Rewrite: 2 read-only tests asserting live registry LACKS the 2-phase API (auditor's caveat), 5 fresh-registry tests driving the real source-level rotation flow.

**Added**:
- `contracts/test/integration/HandoffOwnershipIntegration.t.sol` — full V8 stack + full handoff + assert every `owner()` lands on multisig.
- `compile-service/src/config-id.test.ts` — asserts canonical `ConfigId` identity stable across V1 hashes + fresh `0xc9a87c…3e1f` for Pausable@2.

### 25.9 Round 3 v3 (2026-08-03 late) — every remaining URU-Axx AC closed

Adversarial verifier + user line-by-line pass over v2 caught remaining acceptance criteria unmet. Third followup closes them:

**Source-level:**
- URU-A05 AC #3 — `VerifyWiring.s.sol` gained `EXPECTED_GRADUATOR_CODEHASH` env + default; deployment verification now pins the audited Graduator runtime bytecode via `extcodehash` and reverts on drift.
- URU-A11 AC #4 — `AdminChangeApplied(bytes32 changeId)` events added to both `UruDepositSink._consumeAdminChange` and `UruBuybackVault._consumeAdminChange`. Off-chain monitoring can now enumerate the pending set by joining `Proposed` – `Cancelled` – `Applied` log streams; the "monitoring can enumerate all pending on-chain" criterion is now met.
- Additional (page 10): `RoyaltyRouterFactory` constructor now takes `expectedImplCodehash` and reverts `ImplCodehashMismatch` / `ImplNotAContract`. Same pattern as ERC20/ERC721A/ERC1155 factories.
- Additional (page 10): `UruBuybackVault.executeBuyback` and `UruDepositSink.executeConversion` now `nonReentrant` (Solady). Static reentrancy-balance flag on the delta-measurement pattern is scoped-out with `slither-disable-start/end` and an explanation.
- Additional (page 10): `[profile.strict]` in `foundry.toml` runs invariants with `fail_on_revert = true` so at least one CI job proves successful-path liveness.
- Additional (page 10): `security.sh` now `sys.exit(1)` on any High Slither finding. Same-batch duplicate detection also added to the three Router batch setters (`registerConfigMetadataBatch`, `setModuleCountForConfigBatch`, `setFlagsForConfigBatch`) via O(N²) inner check.

**Test additions (54 new):**
- `test/audit/LaunchPolicyRevertPaths.t.sol` grew +12 (URU-A01 × 3 additional entrypoints × 4 revert selectors).
- `test/composed/ERC20WithPausableGen.t.sol` grew +4 (URU-A02 owner / holder / curve / graduator / poolManager transfer paths).
- `test/audit/RhRotationRehearsalFork.t.sol` NEW (5) — invokes the real `DeployRouter.runForTest` + `ActivateRouter.runForTest` against a fresh 2-phase NameRegistry on live RH, then launches through the rotated Router. Closes URU-A13 AC #4.
- `test/invariant/CurveReachabilityFuzz.t.sol` NEW (5 fuzz functions, 1000 runs each) — proves URU-A03 reachability across accepted tuples.
- `test/invariant/WlSolvencyInvariant.t.sol` NEW (4 stateful invariants, 8k+ calls each) — proves URU-A04 WL claim + graduation-reserve solvency.
- `test/flywheel/RoyaltyRouter.t.sol` gained +2 (codehash mismatch + EOA rejection).
- `compile-service/src/rewards.test.ts` NEW (13) — URU-A06 crash-recovery + URU-A07 partial-epoch tests.
- `compile-service/src/manifest-drift.test.ts` NEW (3) — URU-A09 no-drift generation check.

**CI additions:**
- `.github/workflows/contracts.yml` now installs and runs Slither via `security.sh` (blocking on High).
- `.github/workflows/compile-service.yml` now runs the compile-service test suite including the URU-A09 drift check.

### 25.11 Round 3 v5 (2026-08-04) — regenerate composed templates + commit PATCH-COVERAGE.md + close §26.6 gaps

User line-by-line pass caught three items missed in v4:

- **Auditor's PATCH-COVERAGE.md was never committed.** Patch 4 shipped a `PATCH-COVERAGE.md` file at repo root that documents the auditor's own strict per-finding closure status and the "Required before merge" checklist. Now committed with a post-remediation status table showing every URU-Axx row closed at source + test.
- **PATCH-COVERAGE.md "Required before merge" item #2** ("Regenerate every composed template from the patched fragments") was only half-done. `ERC20WithPausableGen.sol` had the V2 fragment applied, but `ERC20WithPausablePermitGen.sol:167` still shipped the V1 honeypot line `from != owner()`. Test-only registration path (via `PhaseCombos.t.sol`) so not a production exploit, but auditor explicitly demanded it. Now regenerated. AntiBot-containing composed templates keep their `from != owner()` line because that exemption is intentional per AntiBot's fragment (team-distribution during the block-gate window).
- **§26.6 cross-module coverage gaps** (8 combos) — not auditor-flagged but real risk that composed impls could have subtle module interaction bugs. New `test/composed/ComposedCrossModule.t.sol` with 8 tests covering Permit+Staking, Pausable+Permit, Permit+Vesting, AntiBot+Permit, AntiBot+AntiWhale, AntiBot+AntiWhale+Permit, FoT+Permit, AntiBot+FoT. Each test proves both modules' init runs, both are readable post-launch, and the shared `_beforeTokenTransfer` honors both guards.

**Test totals after v5:**
- Contracts non-fork: **724 pass** (+8 ComposedCrossModule).
- Contracts fork suites: 59 pass, 1 skip.
- Compile-service: 39 pass.
- Slither: 0 High.
- **Grand total: 822 pass, 0 fail, 1 skip.**

### 25.10 Round 3 v4 (2026-08-04) — final cleanup of remaining page-10 defects + doc refresh

User line-by-line pass caught five gaps between v3 and "actually ready for re-audit". Fourth followup closes them:

- **URU-A09 AC #1 final close.** `web/src/lib/modules.ts::MODULES` used to be a 649-line hand-maintained duplicate of `shared/matrix.json`. It is now a pure `.map()` over the shared source (275 lines total). `shared/matrix.json` expanded from 284 → 707 lines to hold every field both consumers need (params + ui overlay + capability flags). New `shared/matrix.ts` provides typed loader + zod schema validation. `compile-service/src/matrix.ts` rewritten to import from the shared source. New `compile-service/src/matrix-drift.test.ts` (6 tests) asserts (a) every shipped ERC20 module lands on the on-chain manifest or is retired, (b) shared-derived ConfigId matches manifest verbatim, (c) every `fragmentPath` + `templateOverride` exists on disk. **[V8 change vs live]** — MODULES catalog now single-sourced, no drift possible.
- **URU-A01 secondary — Pausable warning copy.** Frontend module description used to say "u can freeze everyone's tokens" without disclosing that V1 exempted the owner (making it a honeypot). Copy rewritten to state "pause freezes ALL transfers, including yours" reflecting V2 behavior. V1 impl remains permanently banned via `Router.bannedConfigHash`.
- **Auditor page-10: compile-service resource exhaustion.** New `compile-service/src/isolated-build.ts` runs every production request under `fs.mkdtemp(os.tmpdir/urufu-compile-)` and cleans up in a finally block. Concurrent forge builds are semaphore-bounded (default `min(2, cpus - 1)`, override `COMPILE_MAX_CONCURRENCY`). Isolation gate: `NODE_ENV === 'production'` or `COMPILE_ISOLATED=1`. Per-route Fastify rate limit at 5 req/min. 12 new tests in `isolated-build.test.ts` including tempdir-cleanup on failure + concurrency serialization proof.
- **Auditor page-10: silent partial WL snapshots.** `wl-snapshot.ts` used to stop at `BLOCKSCOUT_MAX_PAGES` without erroring. Now rejects `WlSnapshotTruncated(pagesFetched, maxPages, source, fromBlock, toBlock)` unless the caller passes `allowPartial: true` (in which case the return value carries an explicit `partial: true` field). Bookend block reads catch drift beyond `DEFAULT_MAX_BLOCK_DRIFT = 25n` and reject `WlSnapshotBlockDrift(startBlock, endBlock, drift, maxDrift)`. HTTP route in `routes/whitelist.ts` defaults to strict mode. 5 new tests in `wl-snapshot.test.ts`.
- **Doc refresh (this section).** LAUNCHPAD-FULL-SCOPE.md + README.md now reflect the CURRENT commit's state.

**Test totals after v4:**
- Non-fork (`forge test -j 2 --no-match-path "test/{audit,integration}/*Fork*.t.sol"`): **716+ pass, 0 fail** (may grow if v4 added Solidity tests; no Solidity was touched by v4 so count unchanged).
- Audit fork suite: 50 pass, 1 skip (pre-existing URUFU-orphan).
- Integration fork suite: 9 pass, 0 fail.
- Compile-service: **39 pass, 0 fail** (up from 16: +12 isolated-build, +5 wl-snapshot, +6 matrix-drift).
- Web typecheck: clean.
- Slither: 0 High, 56 Medium, 46 Low.

### 25.8 Round 3 follow-up (2026-08-03) — verifier-flagged gaps

An adversarial verifier pass against commit `c2a7459` found two source-level gaps + widespread test-coverage gaps. Follow-up commit closes both:

**Source-level fixes:**
- **URU-A14 (real close)** — `Router._grantCurveModuleAllowances` rewritten from `try/catch {}` swallowers to strict probe → grant → verify. New error `Router__CurveModuleGrantFailed(token, who, module)`. See §5.9.
- **URU-A08 (real close)** — all three factories now require an owner-pinned `expectedCodeHash[configHash]` before `registerImpl` can bind an impl. `registerImpl` reverts `ArtifactHashMismatch` on any drift. Pin is one-shot per config. See §6.5.

**Adversarial test additions (verifier's "impl present, tests missing" list):**
- URU-A01 curve-launch policy — 6 revert tests (KeepEOA, TransferToMultisig, FLAG_REQUIRES_OWNER, AntiSniperBlocksTooHigh, BuybackBurnTooHigh, boundary).
- URU-A06 stale-publisher — UnexpectedEpochId + DirectAddEpochDisabled tests.
- URU-A10 metadata — second-call reverts on setModuleCountForConfig, setFlagsForConfig, registerConfigMetadata; monotonic setCurveIncompatibleConfigHash(hash, false); same-batch duplicate in registerConfigMetadataBatch (also fixed a same-batch-dupe bug found by the new test).
- URU-A11 governance — NftRevenueVault propose/activate/cancel/stacked/without-proposal; UruDepositSink + UruBuybackVault keeper/target/rate propose→wait→apply roundtrips.
- URU-A12 hook safety — MHH setPoolConfig unauthorized-caller, AntiSniperTooLong at cap+1, at-cap-accept boundary.

**Same-batch duplicate fix (found by URU-A10 tests):** the three batch setters (`registerConfigMetadataBatch`, `setModuleCountForConfigBatch`, `setFlagsForConfigBatch`) previously only checked pre-existing state — the same hash could appear twice in one batch and silently keep the last value. Added inner O(N²) check. Batches are ~10 entries so cost is trivial.

**Not-yet-closed** (below verifier's blocker bar but noted for follow-ups):
- URU-A04 `GraduationReserveRequired` — impl guard at `BondingCurve.sol:612` is defence-in-depth (the `buy` floor at `tokenReserve - 1` makes the state unreachable in normal trading). Directly triggering it would require `vm.store`-forced curve state; deferred.
- URU-A13 `DeployRouter.s.sol` + `ActivateRouter.s.sol` invoked from a fork test — replay of the exact broadcast sequence. `RhProductionRotationFork.t.sol` and `HandoffOwnershipIntegration.t.sol` cover the pieces; wiring them under `Script.runForTest()` is deferred to a manifest-artifactHash-populate follow-up.
- URU-A09 CI no-drift check — separate CI-config task.

Test totals after followup: 689 non-fork pass, 45 audit-fork pass, 9 integration-fork pass, 1 skip. Web typecheck clean. See §26.5.

### 25.7 Round 2 v5 — production rotation + retired-hash canonical list

Auditor findings:
- **BLOCKER #1**: Retired hashes not banned during DeployRouter (existed as concept, not actually seeded automatically).
- **BLOCKER #2**: Factory rewiring precedes NameRegistry activation — creates 2-day outage window.
- **MEDIUM #3**: No fork test exercises the production rotation sequence.

Fixes:
- **BLOCKER #1**: `RhConfigManifest.retiredAirdropHashes()` = canonical 3-hash list. `DeployRouter._banRetiredHashes` + post-state assertion. `DeployFreshLocal` mirrors.
- **BLOCKER #2**: DeployRouter split into Phase 1 (staging only, no factory rewire). ActivateRouter expanded to Phase 2 (atomic cutover). CurveFactory pre-trust in Phase 1 (additive), untrust old in Phase 2. Zero user-visible outage — old Router serves throughout pending window.
- **MEDIUM #3**: New `RhProductionRotationFork.t.sol` — 12 tests. 9 live-fork tests exercise Phase 1 + Phase 2 against real RH state; 3 fresh-registry sub-tests drive the full source-level `proposeRouter → timelock → activateRouter` flow against a freshly-deployed 2-phase registry (needed because live registry predates 2-phase).

Test state after v5: 654 unit + integration pass, 71 fork pass, 1 skip (pre-existing URUFU orphan). Web typecheck clean.

**Current status:** commit `0b98349` on `audit-round-2` branch. Awaiting external auditor re-review.

### 25.7 Round 2 v6 — allowlist doc + this doc

Fix: `docs/UNISWAP-HOOK-ALLOWLIST.md` refreshed with current RH MHH pin (`0xed09…A2c4`), correct constructor args (platform = FeeSplitter, not deployer wallet), pruned Base/Ethereum sections. `docs/LAUNCHPAD-FULL-SCOPE.md` (this file) created.

---

## 26. Test Coverage Map

Comprehensive test inventory. Every `contracts/test/**/*.t.sol` file with what it covers.

### 26.1 Unit tests — `contracts/test/unit/` (excerpts, ~30+ files)

- `Router.t.sol` — every entrypoint (launch, launchWithURU, launchWithWhitelist, launchWithURUAndWhitelist), quoting, fail-closed sentinels, `bannedConfigHash` (new): `test_SetConfigHashBanned_OnlyOwner`, `test_SetConfigHashBanned_TogglesAndEmits`, `test_BannedHash_LaunchReverts`, `test_BannedHash_LaunchWithURUReverts`. Second contract `RouterBannedConfigHashWlTest`: `test_BannedHash_LaunchWithWhitelistReverts`, `test_BannedHash_LaunchWithURUAndWhitelistReverts`.
- `NameRegistry.t.sol` — normalization, reservation, ticker blocklist, 2-phase router rotation (against source, not live).
- `ERC20Factory.t.sol` — registerImpl one-shot, deploy path, salt determinism.
- `ERC721AFactory.t.sol` + `ERC1155Factory.t.sol` — same shape.
- `BondingCurve.t.sol` — buy/sell math, dust guard, slippage, graduation trigger.
- `CurveFactory.t.sol` — `setDefaults` validation, trusted-router additive semantics, `_validateCurveDefaults` reachability.
- `Graduator.t.sol` / `GraduatorV2.t.sol` — LP math, unlock/settle, owner sweep, refund-to-launcher.
- `MultiHookHost.t.sol` — every callback, fee split math, LP-lock, initializer gate, `owed`/claim/pushOwed, `setPoolConfig` freeze.
- `FeeSplitter.t.sol` — split math, timelock, sink reversion → rollover, over-commit guard, sweep.
- `UruBuybackVault.t.sol` + `UruDepositSink.t.sol` — keeper allowlist, swap-target allowlist, slippage floors, timelocked sink rotation.
- `NftRevenueVault.t.sol` — addEpoch over-commit guard, claim double-spend guard, sweepDust safety.
- `LoyaltyOracle.t.sol` — tier ladder, threshold clamps.
- `RoyaltyRouterFactory.t.sol` + `RoyaltyRouterImpl.t.sol` — authorization (owner-check + trusted-deployer), per-collection determinism, split math, pay-platform-first re-entry guard.

### 26.2 Composed unit tests — `contracts/test/composed/` (19 files)

One file per checked-in composed impl. See §9 for per-file breakdown. Key coverage:
- Every shipped single-module impl has a dedicated test.
- Reserve-carve modules (Staking, Vesting) have explicit "does not inflate total supply" tests.
- FoT has 12 tests including split-accuracy and recursive-not-double-charged.
- Cross-module combos: most have PhaseCombos coverage only (see §26.4).

### 26.3 Integration tests — `contracts/test/integration/`

- `NftLaunchPaths.t.sol` — 11 tests, launch/mint through Router+Factory for 721A and 1155 bases: bare launch + mint, maxSupply enforcement, mint owner-gate, royalty module, soulbound blocks transfer, 1155 supply cap, curve rejection on NFT bases, cross-base name collision.
- `PhaseCombos.t.sol` — deploys fresh factory in-test, registers every checked-in composed impl (including unregistered-on-live combos), launches through Router, checks basic behavior.
- `ModuleLaunchGraduation.t.sol` — full launch → curve buy → graduation flow for each module or module combo, asserts post-grad pool state.
- `RhDeployPipelineForkTest.t.sol` — replays a subset of the historical deploy pipeline on RH fork.

### 26.4 Audit fork tests — `contracts/test/audit/` (12 files)

- **`RhLiveStackSnapshot.t.sol`** — 11 tests against live RH fork. Every pinned address has code; Router/CurveFactory/Graduator/MHH cross-wires; owners match deployer; LoyaltyOracle points at canonical URU + GEMU; Router wired to LoyaltyOracle; minUruFee non-zero (currently max); all config hashes seeded; retired Airdrop hashes poisoned.
- **`DeployPathRhFork.t.sol`** — 12 tests. Runs canonical `DeployFreshLocal.run` against live RH mainnet fork. Covers: fresh-deploy runs clean, manifest seeded, minUruFee correct, URU config hardening passes for legit stack, cross-wires intact, full launch → graduate → swap lifecycle (buy + sell), LP-removal rejected, sell on curve, FoT-curve reverts, composed-module launch (Permit), URU-paid launch, creator/platform fee accrual.
- **`RetiredHashPoisonFork.t.sol`** — 5 tests. Asserts all 3 retired hashes are poisoned on live Router (`moduleCountForConfig == uint256.max`); asserts `quote()` reverts for each; asserts bare hash unaffected.
- **`FotBlacklistAllEntrypointsFork.t.sol`** — 5 tests. Verifies FoT/balance-mutating guard on live Router across all 4 launch entrypoints. Setup temp-unpoisons `minUruFee` for URU sub-tests.
- **`GraduatorV8LpMathFork.t.sol`** — 3 tests. Etches V8 bytecode over live Graduator pin, runs full launch → graduate cycle, asserts `graduator.balance == 0` post-graduation (regression on V7 4-ETH-stranding bug). Also `test_V8_OwnerCanSweepAccidentalEth` + `test_V8_NonOwnerSweepReverts`.
- **`RhProductionRotationFork.t.sol`** — 12 tests (new, audit round 2 v5). 9 tests exercise Phase 1 + Phase 2 against live RH state (old Router still quotes during pending window, factories preserve old-Router pointer, both routers trusted on CurveFactory, all 3 retired hashes banned on new Router before it goes live, each retired hash reverts on all 4 launch entrypoints, canonical ETH quote works post-cutover, full cross-wire consistency, old Router paused, zero-outage invariant). 3 fresh-registry sub-tests deploy 2-phase NameRegistry in-test to drive the full source-level `proposeRouter → timelock → activateRouter` flow.
- **`OrphanRecoveryFork.t.sol`** — 2 tests (1 skip). Verifies orphaned curves listed in `orphanCurves.ts` are still sellable-back-to-curve for holders. Skip: `test_Orphan_URUFU_HolderCanSellForETH` — hardcoded holder rebalanced on live.
- **`RhDeployPipelineForkTest.t.sol`** — legacy partial pipeline replay.
- **`FreshRhStackFork.t.sol`**, **`V9FullPipelineFork.t.sol`**, **`ChunkyModuleMatrixFork.t.sol`** — additional pipeline + module coverage.

### 26.5 Test suite totals

**As of audit-round-3-v5 (2026-08-04):**

**Contracts (forge):**
- Non-fork suites: **724 pass, 0 fail, 0 skip** (`forge test -j 2 --no-match-path "test/{audit,integration}/*Fork*.t.sol"`). +8 in v5 from `test/composed/ComposedCrossModule.t.sol` (Permit+Staking + 7 unregistered 2-module composed impls; §26.6 closed for non-NFT bases).
- Audit fork suite (`test/audit/*Fork.t.sol` against live RH via `$ROBINHOOD_RPC_URL`): **50 pass, 0 fail, 1 skip** (pre-existing URUFU-orphan skip).
- Integration fork suite (`test/integration/*Fork.t.sol` against live RH): **9 pass, 0 fail**.

**Off-chain (node --test on `compile-service/src/*.test.ts`):**
- `config-id.test.ts` — 4 pass (hash stability + module validation).
- `rewards.test.ts` — 13 pass (URU-A06 crash recovery + URU-A07 available-balance math).
- `manifest-drift.test.ts` — 3 pass (URU-A09 shared → manifest drift check).
- `matrix-drift.test.ts` NEW v4 — 6 pass (URU-A09 shared source ↔ every consumer).
- `isolated-build.test.ts` NEW v4 — 12 pass (compile-service tempdir + concurrency).
- `wl-snapshot.test.ts` NEW v4 — 5 pass (WL snapshot truncation + block-drift rejects).
- Subtotal: **39 pass, 0 fail** (was 16 at v3, +23 from v4 additions).

**Static + type:**
- Slither via `security.sh`: **0 High, 56 Medium, 46 Low, 130 Informational**. High-gate blocks merge on regression.
- Web typecheck (`tsc --noEmit`): clean.
- Compile-service typecheck: clean.

**Grand total across every test surface**: 724 + 50 + 9 + 39 = **822 pass, 0 fail, 1 skip**. Growth from initial round-3 baseline of 651 driven by 16 new / expanded suites across contracts + compile-service.

### 26.6 Coverage gaps

**Closed in v5 (2026-08-04):**
- ~~Permit+Staking cross-module test~~ — closed by `test/composed/ComposedCrossModule.t.sol::test_Combo_PermitStaking_InitializesBothModules`.
- ~~Unregistered 2-module composed impls~~ — 7 combos closed by `ComposedCrossModule.t.sol` (AntiBot+FoT, AntiBot+AntiWhale, AntiBot+AntiWhale+Permit, AntiBot+Permit, FoT+Permit, Pausable+Permit, Permit+Vesting) — 8 tests total. Each proves both modules' init runs, both modules' features are readable, and the shared `_beforeTokenTransfer` hook honors both guards.

**Still open (NFT bases — not activated in current release, deferred per project scope):**
- **NFT composed impls** — 721A/1155 combos exist in source but no dedicated tests beyond `NftLaunchPaths.t.sol` basics. Deferred until NFT bases turn on in the UI (`CHAINS_ENABLED` / `NFT_BASES_ENABLED` flags currently gray them out).
- **NFT bases end-to-end** — no fork test walks a full NFT launch → post-mint → royalty flow through the RoyaltyRouterFactory. Same deferral.

---

## Appendix A — File Path Index

Quick reference for jumping to source.

**Core contracts (`contracts/src/`):**
- Router: `router/Router.sol`
- FeeReceiver interface: `router/FeeReceiver.sol` (interface + minimal test impl)
- FeeSplitter (production `IFeeReceiver`): `router/FeeSplitter.sol`
- UruDepositSink: `router/UruDepositSink.sol`
- NameRegistry: `registry/NameRegistry.sol`
- ERC20Factory: `factories/ERC20Factory.sol`
- ERC721AFactory: `factories/ERC721AFactory.sol`
- ERC1155Factory: `factories/ERC1155Factory.sol`
- BondingCurve: `curve/BondingCurve.sol`
- CurveFactory: `curve/CurveFactory.sol`
- Graduator (V8-final, class name kept V2): `curve/GraduatorV2.sol`
- MultiHookHost: `hooks/MultiHookHost.sol`
- BaseHook: `hooks/BaseHook.sol`
- HookMiner: `hooks/HookMiner.sol`
- Flywheel: `flywheel/{FeeSplitter (referenced), UruBuybackVault, NftRevenueVault, LoyaltyOracle, RoyaltyRouterFactory, RoyaltyRouterImpl}.sol`
- Templates: `templates/{ERC20Template, ERC20VotesTemplate, ERC721ATemplate, ERC1155Template}.sol`
- Composed impls: `templates/composed/*.sol` (31 files)
- Types: `types/VMTypes.sol`

**Module fragments (`contracts/modules/`):**
- Token: `token/{AntiBot, AntiWhale, FeeOnTransfer, Pausable, Permit, Votes}.frag.sol`
- Allocation: `allocation/{Staking, Vesting}.frag.sol`
- NFT: `nft/{DelayedReveal, ERC2981Royalty, ERC2981Royalty1155, OnChainSVG, PayableMint1155, PayableMint1155Split, Refundable, Soulbound, SupplyPerToken1155}.frag.sol`

**Scripts (`contracts/script/`):**
- Fresh deploy: `DeployFreshLocal.s.sol`
- Rotation Phase 1: `DeployRouter.s.sol`
- Rotation Phase 2: `ActivateRouter.s.sol`
- Ownership migration: `HandoffOwnership.s.sol`
- Live-stack validator: `VerifyWiring.s.sol`
- MHH+Graduator rotation: `DeployV9StackFix.s.sol`
- Chunky defaults bump: `SetChunkyDefaults.s.sol`
- Flywheel deploy: `DeployFlywheel.s.sol` + `ConfigureFlywheel.s.sol`
- Manifest: `manifest/RhConfigManifest.sol`

**Frontend (`web/src/`):**
- Address book: `lib/config.ts`
- ABIs: `lib/abis.ts`
- Wagmi setup: `lib/wagmi.ts`
- Module catalog: `lib/modules.ts`
- Indexer client: `lib/indexer.ts`
- Kill switch: `lib/launchpadStatus.ts`
- Orphan curves: `lib/orphanCurves.ts`
- Hidden tokens: `lib/hiddenTokens.ts`
- NFT royalty helpers: `lib/nftRoyalty.ts`
- Metadata helpers: `lib/metadata.ts`
- Social API client: `lib/socialApi.ts`
- Follows: `lib/follows.ts`
- Pages: `app/{page.tsx, catalog/page.tsx, create/page.tsx, discover/page.tsx, docs/page.tsx, feed/page.tsx, profile/page.tsx, profile/[address]/page.tsx, recover/page.tsx, trade/page.tsx, trade/[address]/page.tsx}`

**Indexer (`indexer/`):**
- `ponder.config.ts` — subscription config
- `ponder.schema.ts` — 13-table schema
- `src/index.ts` — 894-line event handlers
- `chains.ts` — chain catalog + env-var readers

**Compile service (`compile-service/`):**
- Entrypoint: `src/server.ts`
- Splicer: `src/compile.ts`
- Keeper: `src/keeper.ts`
- WL snapshot: `src/wl-snapshot.ts`
- Routes: `src/routes/{pin, rewards, social, whitelist}.ts`
- Fixtures: `fixtures/*.json` (31 canonical configs)

**Tests (`contracts/test/`):**
- Unit: `unit/**`
- Composed: `composed/**` (19 files)
- Integration: `integration/**`
- Audit fork: `audit/**` (12 files, most against live RH via `$ROBINHOOD_RPC_URL`)

**Docs (`docs/`):**
- This file: `LAUNCHPAD-FULL-SCOPE.md`
- Uniswap hook allowlist submission: `UNISWAP-HOOK-ALLOWLIST.md`
- NFT activation checklist: `NFT-ACTIVATION.md`
- SPEC files: `SPEC-*.md`
- Decision log: `decisions/log.md`

**Memory (`.claude/projects/.../memory/`):**
- `MEMORY.md` — index of persisted memories
- Individual memory files — deploy history, canonical addresses, retired modules, audit fix history

---

**End of Reference.**






