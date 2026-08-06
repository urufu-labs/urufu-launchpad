# SPEC — Uniswap v4 hooks

> **Status:** current
> _last updated: 2026-08-05_

> One shipped hook (`MultiHookHost`) that hosts every launchpad-side behavior on graduated pools, plus a `BaseHook` shim (v4-periphery doesn't ship one at our pinned version) and a `HookMiner` library for CREATE2 salt search. The hook advertises its permissions via `getHookPermissions()`; the deployed address's low 14 bits must encode those permissions or v4 rejects the pool.

**Status:** IMPLEMENTED.
**Files:** `contracts/src/hooks/`
**Tests:** `test/hooks/MultiHookHost.t.sol` (unit) + `test/curve/GraduationForkTest.t.sol` + `test/audit/DeployPathRhFork.t.sol` (fork).

---

## The shipped hook

| Hook | Permission flags | Purpose |
|---|---|---|
| `MultiHookHost` | `BEFORE_INITIALIZE + BEFORE_SWAP + AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` | Single hosted hook. Combines authorized-initializer gate, per-pool anti-sniper window, fee redirect to platform + creator, and optional per-pool buyback-burn. Only one hook can attach per pool in v4, so every launchpad-side behavior lives here. |

> **Legacy note:** earlier revisions of this doc listed separate `LPLockedHook`, `FeeRedirectHook`, `AntiSniperHook`, and `BuybackBurnHook` contracts. Those never shipped as separate deployments; every behavior is in `MultiHookHost`. Findings F5 (audit round 2) additionally removed the `beforeRemoveLiquidity` gate — the graduation LP is now locked structurally by the Graduator (see §MultiHookHost below and `docs/SPEC-curve.md`). Third-party LPs added post-graduation can add AND remove their positions freely via the Uniswap UI.

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

`DeployHooks.s.sol` reads `V4_POOL_MANAGER` from env, mines the `MultiHookHost` salt, deploys via `new MultiHookHost{salt}(args)`, and asserts `deployed == predicted`.

## `MultiHookHost`

All launchpad-side hook behavior consolidated in one contract. `PoolKey.hooks` is a single address per pool, so any behavior we want on a launched-token pool has to live here.

### Behaviors hosted

- **Initializer gate** (`beforeInitialize`) — reverts unless `sender == initializer` (the wired Graduator). Blocks the "front-run `PoolManager.initialize` on a graduating pool's predictable pool key" DoS. Stamps `poolConfig[poolId].launchBlock` on the authorized path.
- **Fee redirect** (`afterSwap`) — takes `platformBps + creatorBps` of the unspecified swap currency and credits it to `owed[currency][platform]` + `owed[currency][creator]`. Per-pool `creators[poolId]` set by the Graduator; unset pools fall back to the constructor-provided `creator`.
- **Anti-sniper gate** (`beforeSwap`) — if `poolConfig[id].antiSniperBlocks > 0`, swaps revert `AntiSniperGate(launchBlock, gateBlocks)` until `block.number >= launchBlock + antiSniperBlocks`. Zero disables.
- **Buyback burn** (`afterSwap`) — if `poolConfig[id].buybackBurnBps > 0`, an additional slice of exact-input BUY output tokens is transferred to `0x…dEaD`. Exact-output BUYs revert `ExactOutputBuyUnsupportedWithBurn` when burn is enabled (URU-P1-M04).

### LP is locked structurally, not via hook revert

Post-F5, the hook does NOT gate `beforeRemoveLiquidity`. The graduation LP position is locked because the Graduator itself owns it (via `poolManager.modifyLiquidity` with the Graduator as position owner) and `GraduatorV2` has no code path that ever calls `modifyLiquidity` with a negative `liquidityDelta`, no burn function, no transfer path. The LP can never be removed by anyone.

Third-party LPs that add liquidity to a graduated pool via the Uniswap UI can add AND remove their own positions freely — only the Graduator-owned position is locked.

### Claim path

Recipients sweep via `claim(currency)`:
1. Zero `owed[currency][msg.sender]`.
2. `currency.transfer(msg.sender, amount)`.

`pushOwed(currency, account)` is permissionless — lets a keeper push the FeeSplitter (which cannot self-call `claim`) its accrued fees. Same `FeeClaimed` event.

### Caps

- `MAX_TOTAL_BPS = 3000` — platform + creator combined ≤ 30 %.
- `MAX_BUYBACK_BPS = 2000` — per-pool buyback slice ≤ 20 %.
- `MAX_ANTI_SNIPER_BLOCKS = 7200` — mirrors Router-side cap.

All enforced in constructor + `setPoolConfig`. No path to raise post-deploy.

### `setPoolConfig` + `setCreator` — onlyInitializer

Both restricted to the authorized Graduator (URU-A12). Once `beforeInitialize` fires for a pool, further calls for that pool revert `ConfigFrozen`.

### `setInitializer`

One-shot, deployer-only. Locks `initializer` forever. Between deploy and this call the hook is intentionally unusable (`beforeInitialize` reverts `InitializerNotSet` for everyone).

## Fork testing

`test/curve/GraduationForkTest.t.sol`:
- Mines salt for `MultiHookHost` (post-F5 mask = `0x20C4`; see `docs/UNISWAP-HOOK-ALLOWLIST.md` for the mask decomposition)
- Deploys via CREATE2 at the canonical deployer address
- Asserts `predicted == deployed`, low 14 bits match `getHookPermissions()`
- Deploys `Graduator` with the hook
- Runs a full `BondingCurve` to graduation
- Verifies the resulting v4 pool has non-zero liquidity + the hook is wired

`test/audit/DeployPathRhFork.t.sol::test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched`:
- Runs a full fresh-deploy stack against the live RH fork
- Launches + graduates a token
- Third-party LP adds a narrow-range position, then removes it, and both operations succeed
- Asserts the Graduator-owned graduation LP position is untouched across the cycle

Fork tests skip gracefully when the corresponding RPC env is not set.

## Attack surface

- **Hook address forgery** — Not possible. v4 checks the low 14 bits against `getHookPermissions()` at pool initialize.
- **Hook impersonation** — Every callback has `onlyPoolManager`. Anyone else calling the hook directly reverts with `BaseHook__NotPoolManager`.
- **Initializer front-run** — `beforeInitialize` requires `sender == initializer`. Without the wired Graduator (set one-shot at deploy via `setInitializer`) no pool can initialize through this hook, so a griefer cannot plant a rogue configuration by front-running `PoolManager.initialize` on a graduating pool's predictable key.
- **Fee-claim race** — `claim` zeroes `owed[currency][msg.sender]` before `currency.transfer`. If a swap accrues to the same account between the zero and the transfer, the new balance is credited for the next `claim`; no funds lost.
- **Buyback-burn under fee-on-transfer target token** — Not a concern in practice because the launched token is deployed by the launchpad without transfer fees. The hook does not validate this, but the UI's module-compat gate and the exact-output revert (URU-P1-M04) close the exploitable variants.
- **Anti-sniper gate bypass** — Only path is to add liquidity + then swap. Adding liquidity is unblocked, but a swap during the gate window reverts. LP providers cannot "swap through" their own liquidity as an escape hatch.
- **Graduation LP removal** — The LP is owned by the Graduator and `GraduatorV2` has no code path that ever calls `modifyLiquidity` with a negative `liquidityDelta`, no burn function, no transfer function. LP cannot be removed. Third-party LPs on the same pool can add + remove their OWN positions freely (post-F5).
