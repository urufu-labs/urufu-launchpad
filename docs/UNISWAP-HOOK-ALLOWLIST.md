# Uniswap v4 Hook Allowlist Submission — urufu labs `MultiHookHost`

Everything Uniswap's hook-review team asks for, in one place. Submit via:

1. **Discord**: `#hook-support` on the Uniswap Discord (`discord.gg/uniswap`).
   Paste the "Short pitch" section into a message and link the PR + this file.
2. **GitHub**: open a PR against Uniswap's hook registry.
   Current known repo: `Uniswap/v4-periphery` under a `hooks/` catalog or the
   dedicated hook registry when they publish the URL. If the location has
   moved, `#hook-support` will point you at the right place.
3. Follow-up: sometimes the reviewer will DM asking for a specific test case or
   a simulated pool. Keep the "For the reviewer" section handy.

---

## Short pitch (paste to Discord / PR body)

> urufu labs runs a pump.fun-style token launchpad on Base, Ethereum, and
> Robinhood Chain. Every launched token graduates into a Uniswap v4 pool with
> our `MultiHookHost` hook installed. The hook is intentionally minimal — it
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
> Contracts are verified on Etherscan / BaseScan / Blockscout. Source: MIT,
> Foundry. Full test suite (549 passing) + fork tests included. Repo:
> `github.com/urufu-labs/urufu-launchpad`
> Contact: `x.com/spoobsV1`

---

## Hook addresses (all V2 — the current production deployment)

Same source contract compiled with `solc 0.8.26`, 10_000 optimizer runs.
Constructor: `(IPoolManager, address platform, address defaultCreator, uint16 platformBps=100, uint16 creatorBps=100)`.

| Chain      | Chain ID | Hook Address                                 | PoolManager (Uniswap-deployed)                | Verified |
|---         |---       |---                                           |---                                            |---       |
| Base       | 8453     | `0x6af35A106C9e3CD0c29Bd68385573a1B0D45A2C4` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | BaseScan ✅ |
| Ethereum   | 1        | `0x6B2da7926e496577F13fb4f1e08E1BAFe1C2e2C4` | `0x000000000004444c5dc75cB358380D2e3dE08A90` | Etherscan ✅ |
| Robinhood  | 4663     | `0xA122f2c9250c150aAa341D118803bEfFe8f722c4` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Blockscout ✅ |

All three hooks are byte-identical — same source, same compiler, same optimizer
settings. Only the constructor args differ (platform + defaultCreator = urufu
labs deploy wallet `0x6d606cc634F20f5534fba072757F2c2C7B835Bb9`).

**Trailing `22C4` in every hook address is the packed permission-mask suffix**
Uniswap v4 uses to encode hook flags into the address. See the "Hook flag
verification" section below.

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

Every deployed hook address ends in `22C4`, matching Uniswap's `Hooks.sol`
validation. The salt was mined with CREATE2 via Foundry's canonical deployer
`0x4e59b44847b379578588920cA78FbF26c0B4956C`.

---

## What the hook does (line-by-line)

### 1. `beforeInitialize` — freeze per-pool config

Stamps `poolConfig[poolId].launchBlock = uint32(block.number)`. This is the
"freeze" signal — after this hook fires, `setPoolConfig` and `setCreator` for
this pool revert with `ConfigFrozen`.

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
  `creatorBps`, and `poolManager` — no admin function can change them.
- **No `owner()`, no `Ownable`, no upgrade proxy** — the hook has no privileged
  role. There is no way to change fee slices, redirect fees to a different
  address, or unlock LP after deployment.
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
- **Test suite**: 549 unit + integration tests pass. Coverage includes
  malformed pool config, wrong-caller callback attempts, LP removal attempts,
  fee-share math against fuzzed swap sizes, per-pool creator freeze after init,
  fallback-creator accrual for pools that skip setCreator.

---

## Constructor args (ABI-encoded)

Same values on every chain except the `IPoolManager` address:

```
platform         = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
defaultCreator   = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9
platformBps      = 100   (1%)
creatorBps       = 100   (1%)
```

Full ABI-encoded ctor args per chain (constructor signature is
`(address _poolManager, address _platform, address _defaultCreator, uint16 _platformBps, uint16 _creatorBps)`):

- Base:
  ```
  000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000000000000000000000000000000000000000000064
  0000000000000000000000000000000000000000000000000000000000000064
  ```
- Ethereum:
  ```
  000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000000000000000000000000000000000000000000064
  0000000000000000000000000000000000000000000000000000000000000064
  ```
- Robinhood:
  ```
  0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e40951
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000006d606cc634f20f5534fba072757f2c2c7b835bb9
  0000000000000000000000000000000000000000000000000000000000000064
  0000000000000000000000000000000000000000000000000000000000000064
  ```

---

## Source pointers

- Repository: `github.com/urufu-labs/urufu-launchpad`
- License: MIT
- Solc: `0.8.26`
- Optimizer: `enabled=true, runs=10000`
- EVM version: `cancun`
- Hook source: `contracts/src/hooks/MultiHookHost.sol`
- Deploy script: `contracts/script/MigrateToV2Hook.s.sol`
- Test suite: `contracts/test/hooks/MultiHookHost.t.sol` (unit) +
  `contracts/test/curve/MultiHookGraduationForkTest.t.sol` (fork against Base) +
  `contracts/test/integration/DeployedStackForkTest.t.sol` (against on-chain V1)

---

## For the reviewer (test scenarios they might ask for)

- **Verify LP lock**: any `PoolManager.modifyLiquidity` call with negative
  `liquidityDelta` on a pool with our hook reverts with
  `MultiHookHost__LiquidityLocked`. Coverage:
  `test/curve/MultiHookGraduationForkTest.t.sol::test_Fork_LPLockedAfterGraduate`.
- **Verify fee cap**: constructor reverts if `platformBps + creatorBps > 3000`.
  Coverage: `test_Init_RevertsOnBpsOverCap`.
- **Verify no admin path**: no `owner()`, no `Ownable`. Grep the compiled
  bytecode — there are no callable state-changing functions besides
  `setPoolConfig`, `setCreator`, `claim`, and the hook callbacks.
- **Verify anti-front-run on setCreator**: after `beforeInitialize` fires,
  further `setCreator` calls for that poolId revert. Coverage:
  `test_SetCreator_StoresPerPoolAndFreezesAfterInit`.

---

## Follow-up contact

- **Owner**: urufu labs
- **Public contact**: `x.com/spoobsV1` (only channel)
- **Repo**: `github.com/urufu-labs/urufu-launchpad`
- **Website**: `urufulabs.xyz`

The reviewer can DM `x.com/spoobsV1` with any questions or ping in
`#hook-support` where the submission originated.
