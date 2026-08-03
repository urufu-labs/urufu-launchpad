# Uniswap v4 Hook Allowlist Submission — urufu labs `MultiHookHost`

Everything Uniswap's hook-review team asks for, in one place.

**Primary submission**: <https://developers.uniswap.org/hook-allowlist> — a
web form. Fields listed in the "Form quick-reference" section below. Uniswap's
routing allowlist controls whether `app.uniswap.org` and aggregators that trust
Uniswap's list (1inch, CoW, Odos) will pick up our pools. Without allowlisting
the pools still exist and can be swapped through our own V4SwapRouter — users
just can't buy the tokens from Uniswap's frontend.

**Scope**: urufu labs is Robinhood-only right now (chain 4663). Base +
Ethereum lines in earlier versions of this doc are removed until we actually
deploy there. When we do, add a per-chain row + submit a separate form.

**Fallback / follow-up channels**:

1. **Discord**: `#hook-support` on the Uniswap Discord (`discord.gg/uniswap`) —
   for questions or if the form is unavailable.
2. **GitHub**: some registry updates land as PRs against `Uniswap/v4-periphery`
   under a `hooks/` catalog. `#hook-support` will point at the right repo if
   the form doesn't cover our chain.
3. Reviewer may DM asking for a specific test case or a simulated pool — keep
   the "For the reviewer" section at the bottom handy.

---

## Form quick-reference — developers.uniswap.org/hook-allowlist

### Why we must submit (not auto-allowlisted)

Uniswap auto-allowlists hooks that DON'T meet any of:
- uses a delta flag
- deploy address starts with `0x91`
- targets major token pairs (ETH ↔ USDC, etc.)

**Our hook uses the delta flag** (`afterSwapReturnDelta = true` — see the
`getHookPermissions()` snippet below). So we're in the "must submit" bucket
and can't rely on auto-allowlisting.

### Fields the form asks for

| Field | Value |
|---|---|
| First name | Brandon |
| Last name | McCall |
| Email | brandonsmccall@gmail.com |
| Telegram | *(fill in — required)* |
| Hook name | `MultiHookHost` |
| Hook description | *"Post-graduation hook for the urufu launchpad. Enforces LP-locked (revert on beforeRemoveLiquidity), gated initializer (only the launchpad's Graduator can initialize a pool through this hook — prevents pool-init griefing DoS), per-pool anti-sniper block gate, per-pool buyback-burn on buys, and fee-redirect that accrues platform + creator shares from the unspecified swap currency."* |
| Hook address | Robinhood: `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` |
| Pool ID/address | *fill in from a graduated pool on RH — see chicken-and-egg note* |
| Chain(s) | Robinhood (chain id 4663) |
| Source code | `https://github.com/urufu-labs/urufu-launchpad` (path: `contracts/src/hooks/MultiHookHost.sol`) |
| Website | `urufulabs.xyz` |
| Audit links | (pending; PR #1 review by external reviewer, in progress) |
| Classification | **Uses delta flag** ✅ (rest: no) |
| Upgradable? | ❌ NO — immutable clones, no proxy |
| Custom data inputs? | ❌ NO — only standard v4 params |

The last two matter — Uniswap explicitly rejects upgradable hooks and hooks
requiring custom data inputs. Ours are safe on both counts.

### Chicken-and-egg: pool ID is a required field

The form requires "Pool ID/address of a deployed pool with minimal liquidity"
on the target chain. Which means we can't submit until at least one token has
graduated on Robinhood. Sequence:

1. Ship V8 rotation on Robinhood (Router + UruDepositSink + NameRegistry V2).
2. Launch and graduate one test token — organic or forced.
3. Grab the resulting v4 pool ID and submit the form.

Approval timeline: "varies based on complexity and application volume" — no
guaranteed SLA. Uniswap prioritizes audited hooks, differentiated features,
and demonstrated traction. Our audit is in flight (PR #1 external review) — link
the auditor's final report when we file the form if it's landed by then.

---

## Short pitch (paste to Discord / PR body)

> urufu labs runs a pump.fun-style token launchpad on Robinhood Chain
> (id 4663). Every launched token graduates into a Uniswap v4 pool with our
> `MultiHookHost` hook installed. The hook is intentionally minimal — it
> locks LP (curve LP can never be pulled), redirects a 1% + 1% platform/creator
> slice of the swap fee into a `owed[currency][recipient]` accumulator, and
> optionally applies a per-pool anti-sniper block gate + buyback-burn slice
> configured at graduation. All slices are hard-capped in bytecode.
>
> Users can already trade our tokens on our own frontend (urufulabs.xyz) via
> our V4SwapRouter. We're requesting whitelist so that `app.uniswap.org` will
> route through our pools without "no routes found," and so aggregators
> (1inch, CoW, Odos, etc.) that trust Uniswap's whitelist can pick them up.
>
> Contracts are verified on Blockscout. Source: MIT, Foundry. Full test suite
> (725 passing) + fork tests included. Repo:
> `github.com/urufu-labs/urufu-launchpad`
> Contact: `x.com/spoobsV1`

---

## Hook address (current live deployment on Robinhood)

Deployed 2026-07-29 as part of the MHH+Graduator V5 pair rotation. Byte-identical
to the source at `contracts/src/hooks/MultiHookHost.sol`, compiled with
`solc 0.8.26`, 10_000 optimizer runs.

| Chain | Chain ID | Hook Address | PoolManager (Uniswap-deployed) | Verified |
|---|---|---|---|---|
| Robinhood | 4663 | `0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Blockscout ✅ |

**Trailing `A2c4` encodes the flag mask** in the low 14 bits — same
`0x22C4` bit pattern documented in the "Hook flag verification" section
below. The CREATE2 salt was mined against the canonical deployer
`0x4e59b44847b379578588920cA78FbF26c0B4956C` to produce this specific address.

---

## Hook flag verification

`MultiHookHost.getHookPermissions()` returns:

```
{ beforeInitialize:            true,   // stamps launchBlock, freezes per-pool config
  afterInitialize:             false,
  beforeAddLiquidity:          false,
  afterAddLiquidity:           false,
  beforeRemoveLiquidity:       true,   // reverts — LP is permanently locked
  afterRemoveLiquidity:        false,
  beforeSwap:                  true,   // enforces per-pool anti-sniper block window
  afterSwap:                   true,   // accrues platform + creator fee slices
  beforeDonate:                false,
  afterDonate:                 false,
  beforeSwapReturnDelta:       false,
  afterSwapReturnDelta:        true,   // reports the fee take to PoolManager
  afterAddLiquidityReturnDelta:false,
  afterRemoveLiquidityReturnDelta:false }
```

Encoded as a 14-bit mask:

```
BEFORE_INITIALIZE_FLAG           = 1 << 13
BEFORE_REMOVE_LIQUIDITY_FLAG     = 1 << 9
BEFORE_SWAP_FLAG                 = 1 << 7
AFTER_SWAP_FLAG                  = 1 << 6
AFTER_SWAP_RETURNS_DELTA_FLAG    = 1 << 2

sum = 0x2000 | 0x0200 | 0x0080 | 0x0040 | 0x0004
    = 0x22C4
```

Live hook address ends in `A2c4` (the low 14 bits carry the flag mask;
the top two bits of the trailing hex are the mined portion). Matches
Uniswap's `Hooks.sol` validation.

---

## What the hook does (line-by-line)

### 1. `beforeInitialize` — freeze per-pool config + authorize gate

Enforces the `authorizedInitializer` gate: reverts unless `sender` (the
address that called `PoolManager.initialize`) equals the recorded `initializer`,
and reverts with `InitializerNotSet` when `initializer == address(0)`. This
closes a DoS class where an attacker front-runs `PoolManager.initialize` on a
graduating pool's predictable pool key.

On the authorized path, stamps `poolConfig[poolId].launchBlock = uint32(block.number)`.
This is the "freeze" signal — after this hook fires, `setPoolConfig` and
`setCreator` for this pool revert with `ConfigFrozen`.

### 2. `beforeRemoveLiquidity` — LP lock

**Always reverts** with `MultiHookHost__LiquidityLocked`. Emits an event first
for observability. There is no admin, no timelock, no whitelist path around
this — every launched token's LP is permanently locked in the pool.

### 3. `beforeSwap` — optional per-pool anti-sniper gate

If `poolConfig[poolId].antiSniperBlocks > 0`, swaps revert until
`block.number ≥ launchBlock + antiSniperBlocks`. Zero (the default) disables
the gate. Purely a "no swaps for the first N blocks" mechanism to defeat
sandwich bots at the launch tick.

### 4. `afterSwap` — fee accrual + optional buyback-burn

For every swap:

- Take `platformBps + creatorBps` bps of the swap output amount via
  `poolManager.take` into the hook contract's own balance.
- Credit the slice to `owed[currency][platform]` and `owed[currency][creators[poolId]]`.
  If `creators[poolId]` is unset (a pool not initialized through our
  Graduator), the slice falls back to the constructor-provided `creator`.
- If the pool is a BUY (unspecified currency is the token side, `currency1`)
  AND the pool's optional `buybackBurnBps > 0`, an additional slice of the buy
  output is transferred straight to `0x…dEaD`.

Reports the total take back to PoolManager via the `int128` return so the swap
math nets to zero.

### 5. `claim(Currency)` — plain balance transfer

Recipient (platform or per-pool creator) calls `hook.claim(currency)`.
`owed[currency][msg.sender]` is zeroed then transferred — no unlock/callback
dance, no admin.

### Chain-wide caps

- `MAX_TOTAL_BPS = 3000` (fee-redirect can't exceed 30% combined).
- `MAX_BUYBACK_BPS = 2000` (buyback slice can't exceed 20%).
- Both enforced in `constructor` and `setPoolConfig` — no path to raise them
  post-deploy.

---

## Security posture

- **Immutable state** for `platform`, `creator` (fallback), `platformBps`,
  `creatorBps`, `poolManager`, and `deployer` — no admin function can change them.
- **`initializer`** is settable exactly once via `setInitializer`, callable only
  by `deployer`. After the first (and only) call, no wallet — including the
  deployer — can change it. Locked forever.
- **No `owner()`, no `Ownable`, no upgrade proxy** — the hook has no privileged
  role that persists past bootstrap. `setInitializer` is a one-shot; every other
  state change (`setPoolConfig`, `setCreator`) freezes at the next
  `beforeInitialize`.
- **`onlyPoolManager` guard** on every hook callback. External calls to
  `beforeSwap` / `afterSwap` / etc. from anyone other than the PoolManager
  revert.
- **`setPoolConfig` and `setCreator`** are callable by anyone in principle, but
  freeze after `beforeInitialize` fires. In practice the Graduator calls both
  atomically in the same tx as `PoolManager.initialize`, so there's no window
  for a front-runner to plant an evil creator address on a real launch.
- **Reentrancy**: the fee-accrual loop uses `poolManager.take` +
  `Currency.transfer` (solady/SafeTransferLib for ERC-20, native `call` for
  ETH). State is updated before the transfer in `claim`; no reentrancy risk
  because the recipient can only receive their own zeroed balance.
- **Test suite**: 725 passing across unit + integration + fork suites
  (654 unit/integration + 71 fork, 1 skip). Coverage includes malformed pool
  config, wrong-caller callback attempts, LP removal attempts, fee-share math
  against fuzzed swap sizes, per-pool creator freeze after init, fallback-
  creator accrual for pools that skip setCreator, real post-graduation swaps
  (buy + sell + fee accrual) against the live Robinhood PoolManager fork.

---

## Constructor args (ABI-encoded, current RH deploy)

Constructor signature:
`(address _poolManager, address _platform, address _creator, uint16 _platformBps, uint16 _creatorBps, address _deployer)`

Values on RH:
```
_poolManager  = 0x8366a39CC670B4001A1121B8F6A443A643e40951  (Uniswap v4 PoolManager, RH)
_platform     = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA  (FeeSplitter — the flywheel entry point)
_creator      = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9  (deployer wallet as fallback creator)
_platformBps  = 100  (1%)
_creatorBps   = 100  (1%)
_deployer     = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9  (one-shot setInitializer, then defunct)
```

Full ABI-encoded ctor args:
```
0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e40951
00000000000000000000000020d244d3bc58939fbf2594d96afe9b11fac90ffa
0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
0000000000000000000000000000000000000000000000000000000000000064
0000000000000000000000000000000000000000000000000000000000000064
0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
```

**Note on `_platform`**: earlier versions of this doc showed
`_platform = deployer wallet`. That was the pre-flywheel setup. Current live
`_platform` is the `FeeSplitter` (`0x20d2…0FfA`), which distributes the 1%
platform share across URU buyback / NFT revenue / treasury per the flywheel's
40/35/25 configuration. See `project_flywheel_configure` memory for the
on-chain split verification.

---

## Source pointers

- Repository: `github.com/urufu-labs/urufu-launchpad`
- License: MIT
- Solc: `0.8.26`
- Optimizer: `enabled=true, runs=10000`
- EVM version: `cancun`
- Hook source: `contracts/src/hooks/MultiHookHost.sol`
- Deploy script: `contracts/script/DeployFreshLocal.s.sol` (mines + deploys as
  part of the full fresh stack; standalone MHH+Graduator rotations use
  `contracts/script/DeployV9StackFix.s.sol`)
- Test suite:
  - `contracts/test/hooks/MultiHookHost.t.sol` (unit)
  - `contracts/test/audit/DeployPathRhFork.t.sol` (fork against live RH
    PoolManager — full launch → graduate → buy + sell + fee-accrual lifecycle)
  - `contracts/test/audit/GraduatorV8LpMathFork.t.sol` (LP math regression)
  - `contracts/test/audit/RhLiveStackSnapshot.t.sol` (live-wire snapshot
    including `MHH.initializer == GRADUATOR` cross-wire)

---

## For the reviewer (test scenarios they might ask for)

- **Verify LP lock**: any `PoolManager.modifyLiquidity` call with negative
  `liquidityDelta` on a pool with our hook reverts with
  `MultiHookHost__LiquidityLocked`. Coverage:
  `test/audit/DeployPathRhFork.t.sol::test_FreshDeploy_LpRemovalPermanentlyRejected`.
- **Verify fee cap**: constructor reverts if `platformBps + creatorBps > 3000`.
  Coverage: `test/hooks/MultiHookHost.t.sol::test_Init_RevertsOnBpsOverCap`.
- **Verify no admin path**: no `owner()`, no `Ownable`. Grep the compiled
  bytecode — there are no callable state-changing functions besides
  `setPoolConfig`, `setCreator`, `claim`, and the hook callbacks.
- **Verify anti-front-run on setCreator**: after `beforeInitialize` fires,
  further `setCreator` calls for that poolId revert. Coverage:
  `test/hooks/MultiHookHost.t.sol::test_SetCreator_StoresPerPoolAndFreezesAfterInit`.
- **Verify post-grad swaps + fee accrual**: full round-trip buy + sell on the
  live RH PoolManager. Coverage:
  `test/audit/DeployPathRhFork.t.sol::test_FreshDeploy_FullLaunchGraduateSwapLifecycle`
  and `::test_FreshDeploy_CreatorPlatformFeeAccrues`.

---

## Follow-up contact

- **Owner**: urufu labs
- **Public contact**: `x.com/spoobsV1` (only channel)
- **Repo**: `github.com/urufu-labs/urufu-launchpad`
- **Website**: `urufulabs.xyz`

The reviewer can DM `x.com/spoobsV1` with any questions or ping in
`#hook-support` where the submission originated.
