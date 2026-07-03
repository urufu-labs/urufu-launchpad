# SPEC — Bonding curve stack

> pump.fun-style x·y=k bonding curve with virtual reserves. One curve per token, deployed via
> factory-clone. Auto-graduates to a Uniswap v4 pool via `Graduator` when it hits its ETH
> target. LP locked forever by `LPLockedHook`.

**Status:** IMPLEMENTED.
**Files:** `contracts/src/curve/BondingCurve.sol`, `CurveFactory.sol`, `Graduator.sol`
**Tests:** `test/curve/BondingCurve.t.sol` (15), `test/curve/CurveFactory.t.sol` (7), `test/curve/GraduationForkTest.t.sol` (1 fork test against Sepolia v4).

---

## Purpose

Every bonding-curve launch flows: `Router.launch{installBondingCurve: true}` → factory deploys the token → Router forwards initial supply to the CurveFactory → CurveFactory clones a BondingCurve and pulls the supply → trading begins. When the curve's ETH reserve hits `graduationTargetEth`, `_graduate()` fires: reserves are pushed into a fresh v4 pool via `Graduator`, LP is minted full-range, `LPLockedHook` locks it forever.

## Contract 1 — `BondingCurve.sol`

### Math

Uses virtual reserves so the initial price is well-defined and non-zero:

```
k = (V + S) · v
```

Where:
- `V = virtualTokenReserve` (constant, from init)
- `S = curveSupply` (starting token balance held by the curve)
- `v = virtualEthReserve` (constant, from init)

Spot price at any moment: `(ethReserve + v) / (tokenReserve + V)`.

**Buy math:**
```
newEffEth = (ethReserve + v) + ethIn
newEffToken = k / newEffEth
tokensOut = (tokenReserve + V) - newEffToken
```

**Sell math:** symmetric — token in, ETH out.

**Fees:** `tradeFeeBps` bps skimmed from every trade, both sides. Forwarded to `feeReceiver` (platform treasury, same address the launch Router uses).

**Constraint for the curve to reach graduation without exhausting:**
```
graduationTargetEth < curveSupply · virtualEthReserve / virtualTokenReserve
```

With Sepolia defaults (`S=800M, V=800M, v=5 ETH`), the exhaustion point is at 5 ETH reserve. Graduation triggers at 4 ETH, leaving ~11% of supply on the curve for LP.

### State

| Var | Type | Purpose |
|---|---|---|
| `token` | `address` | The ERC-20 being traded |
| `feeReceiver` | `address` | Platform treasury |
| `curveSupply` | `uint256` | Initial token balance |
| `virtualTokenReserve` | `uint256` | `V` |
| `virtualEthReserve` | `uint256` | `v` |
| `graduationTargetEth` | `uint256` | `G` |
| `tradeFeeBps` | `uint16` | Fee both sides |
| `graduator` | `address` | Optional; if set, `_graduate` transfers reserves in |
| `ethReserve` | `uint256` | Rolling |
| `tokenReserve` | `uint256` | Rolling |
| `graduated` | `bool` | One-way flag; blocks buys + sells |
| `_initialized` | `uint8` | Init guard (clone-friendly) |

### Interface

```solidity
function initialize(
    address token, address feeReceiver,
    uint256 curveSupply, uint256 virtualTokenReserve, uint256 virtualEthReserve,
    uint256 graduationTargetEth, uint16 tradeFeeBps, address graduator
) external;

function buy(uint256 minTokensOut) external payable returns (uint256 tokensOut);
function sell(uint256 tokensIn, uint256 minEthOut) external returns (uint256 ethOut);
function quoteBuy(uint256 ethIn) external view returns (uint256 tokensOut, uint256 fee);
function quoteSell(uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee);
function priceWeiPerToken() external view returns (uint256);
```

### Events (indexed by Ponder)

```
CurveInitialized(token, feeReceiver, curveSupply, virtualTokenReserve, virtualEthReserve, graduationTargetEth, tradeFeeBps)
Trade(trader, isBuy, ethAmount, tokenAmount, ethReserve, tokenReserve, timestamp)
Graduated(ethReserve, tokenReserve, timestamp)
```

### Graduation flow

`_graduate()` fires when `ethReserve >= graduationTargetEth` OR `tokenReserve == 0` at end of a `buy`. Actions:

1. `graduated = true` (blocks further trades — `Buy/Sell` revert with `BondingCurve__Graduated`)
2. Emit `Graduated(ethOut, tokenOut, timestamp)`
3. If a graduator is wired: zero the reserves, `safeApprove` graduator for `tokenOut`, call `IGraduator.execute{value: ethOut}(token, ethOut, tokenOut)`

Without a graduator wired, funds stay on the curve. Test suites rely on this stub for in-memory tests.

## Contract 2 — `CurveFactory.sol`

Deploys `BondingCurve` clones per token via EIP-1167 (Solady `LibClone.cloneDeterministic`).

- Salt: `keccak256(token, chainid)` — deterministic, front-mine-safe
- Pre-checks the caller's token balance ≥ `defaultCurveSupply` before cloning
- Pulls tokens into the clone via `safeTransferFrom`
- Calls `BondingCurve.initialize(...)` with the factory's current defaults

**Owner-mutable defaults:**
- `defaultCurveSupply` (800M on Sepolia)
- `defaultVirtualTokenReserve` (800M)
- `defaultVirtualEthReserve` (5 ETH)
- `defaultGraduationTargetEth` (4 ETH)
- `defaultTradeFeeBps` (100 = 1%)
- `feeReceiver` (platform treasury)
- `graduator` (address(0) disables v4 graduation)

Mutating via `setDefaults` / `setFeeReceiver` / `setGraduator` — owner-only, emits events.

**View accessors:**
- `curveFor(address token) → address` — lookup
- `predictCurveAddress(address token) → address` — deterministic clone address

## Contract 3 — `Graduator.sol`

Takes a graduated curve's ETH + tokens and mints them as a full-range LP in a Uniswap v4 pool.

### Constructor

Immutable — one Graduator per (poolManager, hook, fee, tickSpacing). Redeploy to change any.

```solidity
constructor(IPoolManager poolManager, IHooks defaultHook, uint24 fee, int24 tickSpacing);
```

Tick bounds computed at construction:
- `tickLower = (MIN_TICK / tickSpacing + 1) · tickSpacing`
- `tickUpper = (MAX_TICK / tickSpacing) · tickSpacing`

For `tickSpacing=60`: `tickLower=-887220`, `tickUpper=887220`.

### `execute(address token, uint256 ethAmount, uint256 tokenAmount) external payable`

Called by `BondingCurve._graduate()`. Curve has already `approve`d the token amount + is sending ETH along.

1. Pull tokens via `safeTransferFrom` (Solady)
2. Compose the `PoolKey` — `currency0 = ETH (address(0))`, `currency1 = token`, `fee`, `tickSpacing`, `hooks = defaultHook`
3. Compute `sqrtPriceX96` from the reserve ratio: `sqrt(ethAmount) << 96 / sqrt(tokenAmount)` (Solady `FixedPointMathLib.sqrt`)
4. `poolManager.initialize(key, sqrtPriceX96)`
5. Compute `liquidity` via `LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, ethAmount, tokenAmount)`
6. `poolManager.unlock(abi.encode(key, liquidity, ethAmount, tokenAmount, token))`

### `unlockCallback(bytes data) external returns (bytes)`

Only callable by `poolManager`. Reverts otherwise (`Graduator__NotPoolManager`).

1. `modifyLiquidity(key, {tickLower, tickUpper, liquidityDelta: int256(liquidity), salt: 0})` — returns caller's `BalanceDelta`
2. Extract `delta0` (ETH) + `delta1` (token) — both negative (owed) after add-liquidity
3. Settle ETH: `poolManager.settle{value: uint128(-delta0)}()`
4. Settle token: `sync(currency)` → `safeTransfer(token, poolManager, uint128(-delta1))` → `settle()`
5. If either delta is positive (over-funded), `take()` the excess back

Using the exact delta from `modifyLiquidity` — not the intended amounts — protects against rounding drift between `LiquidityAmounts.getLiquidityForAmounts` and v4's internal amount-for-liquidity math.

**LP position ownership:** Graduator owns the position (msg.sender to `modifyLiquidity`). But `LPLockedHook.beforeRemoveLiquidity` reverts every attempt, so even Graduator can't unlock. Verified end-to-end in `GraduationForkTest`.

## Wiring in `Router`

`LaunchParams.installBondingCurve` (bool). When true + `base == ERC20`:
1. Router.launch happens with `initialRecipient = address(Router)` (UI enforced)
2. Token deploys, Router holds `defaultCurveSupply` tokens
3. Router `approve`s CurveFactory
4. Router calls `CurveFactory.createCurve(token)` → curve clone deployed + funded
5. Emits `Router.CurveInstalled(token, curve)`
6. Ownership dispatch continues normally (usually `Renounce` for curve launches)

Reverts:
- `Router__CurveFactoryUnset` if curve factory not set
- `Router__CurveOnlyForERC20` if `base != ERC20`

## Attack surface

- **Reentrancy** — `BondingCurve.buy/sell` use `nonReentrant` (Solady). `Graduator` unlocks are guarded by `msg.sender == poolManager`.
- **Sandwich attacks pre-graduation** — Buyer can be front-run. Mitigation: `minTokensOut` slippage param on every `buy`. UI defaults to 2% tolerance.
- **Graduation griefing** — Can a whale drain curve to exactly zero token then abort? No — `_graduate()` runs inside the `buy` that triggered it, atomic. Either both succeed or both revert.
- **LP theft after graduation** — Impossible. Position ownership is Graduator's, and `LPLockedHook.beforeRemoveLiquidity` reverts every attempt including from Graduator itself.
- **USDT-family tokens on the curve** — `SafeTransferLib` used everywhere. USDT's non-standard `transfer` return value handled.
- **Fee-on-transfer tokens as the launched asset** — `BondingCurve` assumes exact-amount transfers. `FeeOnTransfer` module is declared incompatible with `Staking`; also incompatible with the curve flow because the curve receives fewer tokens than approved. Not currently enforced in `LaunchParams` validation — TODO.
