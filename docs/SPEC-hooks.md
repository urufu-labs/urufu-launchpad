# SPEC — Uniswap v4 hooks

> Five shipped hooks, plus a `BaseHook` shim (v4-periphery doesn't ship one at our pinned version) and a `HookMiner` library for CREATE2 salt search. Each hook advertises its permissions via `getHookPermissions()`; the deployed address's low 14 bits must encode those permissions or v4 rejects the pool.

**Status:** IMPLEMENTED.
**Files:** `contracts/src/hooks/`
**Tests:** `test/hooks/*.t.sol` (unit) + `test/hooks/LPLockedHookForkTest.t.sol` + `test/curve/GraduationForkTest.t.sol` (fork).

---

## The 5 hooks

| Hook | Permission flags | Purpose |
|---|---|---|
| `LPLockedHook` | `BEFORE_REMOVE_LIQUIDITY` | Reverts every remove — LP locked forever |
| `FeeRedirectHook` | `AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` | Takes bps of every swap output → platform + creator receivers |
| `MultiHookHost` | `BEFORE_REMOVE_LIQUIDITY + AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` | Combines LPLocked + FeeRedirect in a single deployable hook (only one hook per pool in v4) |
| `AntiSniperHook` | `BEFORE_INITIALIZE + BEFORE_SWAP` | Blocks swaps for N blocks after pool init (day-0 bot protection) |
| `BuybackBurnHook` | `AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` | Skims bps of every swap whose output is the launched token → burns to `0xdead` |

## `BaseHook.sol`

Common shim. `IHooks` interface implemented with every callback reverting `BaseHook__NotImplemented()` by default. Subclasses override only the callbacks they enable.

Shared machinery:
- `immutable IPoolManager poolManager` — set in constructor
- `onlyPoolManager` modifier — used on every callback in subclasses
- `Permissions` struct — 14-field bag returned by `getHookPermissions()`
- `BaseHook__NotPoolManager` + `BaseHook__NotImplemented` errors

## Deployment via `HookMiner`

v4 encodes hook permissions in the low 14 bits of the hook address. To deploy a hook you must CREATE2-mine a salt whose resulting address's low bits match `getHookPermissions()`.

```solidity
library HookMiner {
  uint160 constant FLAG_MASK = 0x3FFF; // low 14 bits

  function find(
    address deployer,
    uint160 requiredFlags,
    bytes memory creationCode,
    bytes memory constructorArgs,
    uint256 maxIterations
  ) internal pure returns (uint256 salt, address hookAddress);
}
```

Loop is bounded (`maxIterations`) to prevent runaway searches in tests. Production deploys via `DeployHooks.s.sol` — targets the canonical Foundry CREATE2 deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C` (present on every EVM chain we care about).

`DeployHooks.s.sol` reads `V4_POOL_MANAGER` from env, mines salts for all 5 hooks, deploys via `new Hook{salt}(args)`, and asserts `deployed == predicted`.

## `LPLockedHook`

**One callback:**
```solidity
function beforeRemoveLiquidity(...) external onlyPoolManager returns (bytes4) {
    emit LPLockedHookRemoveAttempt(sender, key);
    revert LPLockedHook__LiquidityLocked();
}
```

Verified end-to-end in `GraduationForkTest` — Graduator mints the LP, hook is set on the pool, no path exists to remove liquidity ever.

## `FeeRedirectHook`

`afterSwap` takes a bps slice of the swap's **unspecified** currency (the output side) and credits it to internal `owed[currency][recipient]` mappings. Both `platform` + `creator` receivers set at deploy.

Recipients sweep via `claim(currency)`:
1. Look up `owed[currency][msg.sender]`, zero it
2. `poolManager.unlock(abi.encode(currency, msg.sender, amount))`
3. In `unlockCallback` (only callable by pool manager): `poolManager.take(currency, to, amount)`

Bps cap: `MAX_TOTAL_BPS = 3000` (30%). Constructor reverts on `platformBps + creatorBps > 3000`.

## `MultiHookHost`

Combines LPLocked + FeeRedirect in one deployment. `PoolKey.hooks` is a single address — if you want both behaviors on one pool, they need to coexist in one contract.

Same immutables + storage as FeeRedirectHook, plus `beforeRemoveLiquidity` always reverts.

Declared `incompatibleWith: ['LPLocked', 'FeeRedirect']` in the module catalog so the UI compat gray-out prevents users from stacking them.

## `AntiSniperHook`

Constructor takes `gateBlocks`. `beforeInitialize` records `initBlock` per pool. `beforeSwap` reverts if `block.number < initBlock + gateBlocks`. Auto-expires after the window.

Non-owner-mutable — no way to extend or shorten the window post-init. This is a feature: the gate is provably temporary.

## `BuybackBurnHook`

Constructor takes `launchedToken` (Currency) + `burnBps`. `afterSwap` acts only when the swap's output side is the launched token — takes `burnBps` of the output and routes it to `0xdead` via `poolManager.unlock` → `poolManager.take(currency, DEAD, amount)`.

`MAX_BPS = 2000` (20%). Deflationary flywheel — every swap for the token permanently shrinks circulating supply.

## Fork testing

`test/hooks/LPLockedHookForkTest.t.sol`:
- Forks Sepolia
- Mines salt for `LPLockedHook`
- Deploys via CREATE2 at the canonical deployer address
- Asserts `predicted == deployed`, low 14 bits match `BEFORE_REMOVE_LIQUIDITY_FLAG`
- Composes a `PoolKey` with the hook, calls `poolManager.initialize` — passes v4's hook permission validation

`test/curve/GraduationForkTest.t.sol`:
- Same mining + deployment as above
- Deploys `Graduator` with the hook
- Runs a full `BondingCurve` to graduation
- Verifies the resulting v4 pool has non-zero liquidity + the hook is wired

Both tests skip gracefully when `SEPOLIA_RPC_URL` isn't set.

## Attack surface

- **Hook address forgery** — Not possible. v4 checks the low 14 bits against `getHookPermissions()` at pool initialize.
- **Hook impersonation** — Every callback has `onlyPoolManager`. Anyone else calling the hook directly reverts with `BaseHook__NotPoolManager`.
- **`FeeRedirectHook.claim` race** — Zero-then-unlock pattern. If a swap happens after the zero but before the unlock/take, the new swap adds to `owed` for the next claim, no funds lost.
- **`BuybackBurnHook` under fee-on-transfer target token** — Not a concern in practice because the "launched token" that BuybackBurn is configured for is one we deploy without transfer fees. The hook doesn't validate this though — a launcher could shoot themselves in the foot. UI compat check catches this.
- **`AntiSniperHook` gate bypass** — Only path is to add liquidity + then swap. Adding liquidity is unblocked, but a swap during the gate window reverts. LP providers can't "swap through" their own liquidity as an escape hatch.
