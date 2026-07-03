# SPEC — Router

> User-facing entry to VM. Accepts the launch fee, atomically reserves the name in `NameRegistry`, dispatches to the correct base-type factory, and emits the launch event the frontend and indexer both watch.

**Status:** ✅ IMPLEMENTED. See `contracts/src/router/Router.sol` for the shipping code; this document remains as design-intent reference.
**Since shipped:** `LaunchParams` gained `bool installBondingCurve`; Router has `curveFactory` mutable state (owner-set via `setCurveFactory`); on `installBondingCurve == true && base == ERC20`, Router `approve`s CurveFactory and calls `createCurve(token)` between the factory deploy and ownership dispatch, emitting `CurveInstalled(token, curve)`. Full details in `docs/SPEC-curve.md`.
**File:** `contracts/src/router/Router.sol` (+ `contracts/src/router/FeeReceiver.sol`)
**Tests:** `test/unit/Router.t.sol`, `test/integration/LaunchE2E*.t.sol`, `test/integration/LaunchWithCurve.t.sol`, `test/integration/PhaseCombos.t.sol`.

---

## Purpose

Every VM launch flows through `Router.launch(...)`. Router is the only contract users interact with when deploying. Three actions performed atomically:

1. Collect the launch fee in ETH → forward to `FeeReceiver`.
2. Invoke the base-type factory (`ERC20Factory` / `ERC721AFactory` / `ERC1155Factory`) with the user's config → returns the deployed token address.
3. Reserve `(name, ticker)` in `NameRegistry` — reverts if unavailable.

If any step reverts, the entire transaction reverts — no fees taken, no reservations made, no orphaned tokens. Router is the only contract in the system with authority to call `NameRegistry.reserve`.

---

## State

| Variable | Type | Purpose |
|---|---|---|
| `registry` | `NameRegistry` (immutable) | Set at construction, never changed. If registry migrates, Router redeploys. |
| `feeReceiver` | `IFeeReceiver` (immutable) | Receives the launch fee. |
| `factories` | `mapping(BaseType => address)` | `ERC20 → ERC20Factory addr`, etc. Owner-managed via `setFactory`. |
| `fees` | `mapping(BaseType => uint256)` | Base launch fee per base type, wei. Owner-managed. |
| `moduleAddOnFee` | `uint256` | Extra fee per selected module beyond the first. Owner-managed. |
| `hookAddOnFee` | `uint256` | Extra fee for installing the v4 hook. |
| `governanceAddOnFee` | `uint256` | Extra fee for adding governance bundle. |
| `paused` | `bool` | Emergency circuit breaker. **Flagged** per Security SKILL — owner + Pausable is a censorship vector. Owner must be a multisig; see §Attack surface. |
| `_owner` | Solady Ownable | Admin. Timelocked multisig recommended. |

Router is **not upgradeable**. A v2 Router redeploys, and the frontend routes new launches there. `NameRegistry.setRouter` exists precisely so a v2 Router can take over without redeploying the registry.

---

## Types

```solidity
enum BaseType { ERC20, ERC721A, ERC1155 }
enum OwnershipMode { Renounce, TransferToMultisig, KeepEOA }

struct LaunchParams {
    BaseType base;
    string name;
    string ticker;
    bytes config;                    // ABI-encoded, factory-specific. See SPEC-factories.
    uint256 moduleCount;             // used for pricing only; factory validates modules against the matrix
    bool installHook;                // triggers hook add-on price
    bool installGovernance;          // triggers governance add-on price
    OwnershipMode ownership;
    address ownerTargetIfMultisig;   // used only when ownership == TransferToMultisig
}
```

---

## Functions

### `launch(LaunchParams params) external payable returns (address token)`
- **Caller:** anyone with ETH. `nonReentrant`.
- **Not callable when `paused`**.
- **Sequence — Checks-Effects-Interactions strictly:**
  1. **Checks:**
     - `!paused` else revert `Router__Paused`.
     - `msg.value >= quote(params)` else revert `Router__InsufficientFee(quote, msg.value)`.
     - `factories[params.base] != address(0)` else revert `Router__FactoryUnset`.
     - `bytes(params.name).length > 0` and `bytes(params.ticker).length > 0` else revert `Router__EmptyName` / `Router__EmptyTicker`.
     - If `params.ownership == TransferToMultisig`: `params.ownerTargetIfMultisig != address(0)` else revert `Router__ZeroAddress`.
  2. **Effects:** none in Router's own state per launch. Router holds no per-launch state.
  3. **Interactions:**
     - `feeReceiver.receiveFee{value: fee}(msg.sender, params.base)` where `fee = quote(params)`.
     - `token = factory.deploy(params, msg.sender)`. Factory returns the deployed token address. Factory is trusted (owner-set). Factory MUST include `msg.sender` (or a per-launch nonce) in its CREATE2 salt so external griefers can't front-mine the deterministic address (see SPEC-factories §CREATE2 salt policy).
     - `registry.reserve(params.name, params.ticker, token, msg.sender)`. Registry reverts if taken — the whole tx unwinds, including the fee transfer and the factory deploy.
     - Ownership dispatch:
       - `Renounce` → `token.renounceOwnership()`.
       - `TransferToMultisig` → `token.transferOwnership(params.ownerTargetIfMultisig)`.
       - `KeepEOA` → `token.transferOwnership(msg.sender)`.
       - Factory MAY already set the owner to Router; Router transfers to the requested target.
     - Refund excess ETH: if `msg.value > fee`, `SafeTransferLib.safeTransferETH(msg.sender, msg.value - fee)`. Done after all state changes; `nonReentrant` guards.
  4. Emit `Launched(...)`.
- **Returns:** `token` address.

**Ordering note:** The factory must deploy the token BEFORE the registry reserves — the registry needs the token address. The revert-atomicity property holds because if `registry.reserve` reverts, the whole tx (including the factory deploy) unwinds.

### `quote(LaunchParams params) public view returns (uint256)`
- Pure fee computation. Same formula the FE uses to preview cost:
  ```
  fees[base]
    + moduleAddOnFee * max(0, moduleCount - 1)
    + (installHook ? hookAddOnFee : 0)
    + (installGovernance ? governanceAddOnFee : 0)
  ```
- Returns wei. Guaranteed to never revert.

### `setFactory(BaseType base, address factory)` — `onlyOwner`
- Sets/replaces the factory for a base type. Cannot be zero. Emits `FactorySet`.

### `setFee(BaseType base, uint256 wei_)` — `onlyOwner`
- Emits `FeeSet`.

### `setAddOnFees(uint256 module_, uint256 hook_, uint256 governance_)` — `onlyOwner`
- Emits `AddOnFeesSet`.

### `setPaused(bool)` — `onlyOwner`
- Emits `PausedSet`. See §Attack surface for censorship-vector flag.

### `sweepStuckETH(address to)` — `onlyOwner`
- Recover ETH stranded in Router (e.g. from an unusual revert path that didn't refund). Should be effectively never called. Emits `Swept`.

### `transferOwnership(address)` — Solady Ownable inherited (two-step).

---

## Events

```solidity
event Launched(
    address indexed token,
    address indexed launchedBy,
    BaseType indexed base,
    bytes32 nameHash,
    bytes32 tickerHash,
    uint256 feePaid,
    bool installedHook,
    bool installedGovernance
);
event FactorySet(BaseType indexed base, address indexed factory);
event FeeSet(BaseType indexed base, uint256 wei_);
event AddOnFeesSet(uint256 module_, uint256 hook_, uint256 governance_);
event PausedSet(bool paused);
event Swept(address indexed to, uint256 amount);
```

`Launched` is the primary launch signal for the indexer. `NameRegistry.Reserved` is the correlate. Both fire in the same tx.

---

## Access control

| Function | Access |
|---|---|
| `launch`, `quote` | public |
| `setFactory`, `setFee`, `setAddOnFees`, `setPaused`, `sweepStuckETH`, `transferOwnership` | `onlyOwner` |

**Ownership post-deploy:** transferred to a 2-of-3 multisig within 24 hours of mainnet deploy. `Pausable` present but flagged — see below.

---

## Reentrancy

`launch` is `nonReentrant` because:
- It calls `FeeReceiver.receiveFee` (which could re-enter Router).
- It calls the factory (which deploys a new contract and could re-enter).
- It calls the registry (view + storage only, but the outer guard is cheap).
- It refunds excess ETH to `msg.sender` at the end.

CEI ordering: state writes (none in Router itself; the factory + registry do write state) happen before the ETH refund. The `nonReentrant` guard is defense-in-depth, not a substitute for CEI.

---

## Invariants (target invariant tests)

1. **Fee integrity:** for every successful `launch`, `msg.value >= quote(params)`, and the paid fee (up to `quote`) was transferred to `feeReceiver` exactly once. Refunds sum with fee = `msg.value`.
2. **Deploy + reserve atomicity:** if `Launched` was emitted, then in the same tx `NameRegistry.Reserved` was emitted with matching `token` and `nameHash`/`tickerHash`.
3. **No orphan reservations:** it is impossible to observe a state where `NameRegistry` has a reservation pointing to a `token` that was never deployed.
4. **No orphan tokens:** it is impossible to observe a state where a factory deployed a token but `NameRegistry` has no reservation for its `(name, ticker)`.
5. **Pause blocks writes only:** when `paused = true`, `launch` reverts. `quote` still returns.
6. **Router never holds ETH beyond a tx:** after every top-level call to Router, `address(this).balance == 0` (handler asserts after every operation).
7. **Ownership mode fidelity:** for every `Launched`, `token.owner()` matches the requested `OwnershipMode` at the end of the tx.

---

## Attack surface

Per ETHSKILLS Security §Reentrancy, §Access control, §Input validation, §MEV.

| Vector | Mitigation |
|---|---|
| Reentrancy through refund | `nonReentrant` + CEI. |
| Factory replacement rug | `setFactory` is `onlyOwner` — timelocked multisig. Add a delay guard in v2 if we want stronger. |
| Fee undercharge via calldata manipulation | `msg.value >= quote(params)`, checked at top. |
| Fee overcharge (user pays too much) | Refund excess. |
| DoS by front-run reservation | Not fully mitigable — see SPEC-registry. Users can pick a slightly different name. |
| CREATE2 salt griefing | Factory must include `msg.sender` (or a per-launch nonce) in the salt. Enforced in SPEC-factories. |
| Ownership mode manipulation (user chose Renounce but attacker somehow bypasses) | `params.ownership` is user-provided; Router dispatches unconditionally. Invariant 7 tests fidelity. |
| Pausable censorship | Owner-controlled pause is a censorship vector per Security SKILL. **Flagged.** Mitigations: (a) owner is a 2-of-3 multisig, (b) UI discloses "protocol can pause new launches — existing tokens continue trading" prominently, (c) v2 candidate: auto-unpause after 30 days if not renewed. Never applied to existing token contracts — Router pause is scoped to new launches only. |
| Fee bracket misalignment | `quote` and `launch` share the same formula (single source of truth), so the FE preview matches the on-chain charge exactly. Tested in Router invariant tests. |
| Factory returns wrong `token` address | Factory is trusted (owner-set). If compromised, everything downstream is untrusted. Owner is a multisig for this reason. |
| Fee-on-transfer / rebasing / pausable ETH-equivalent | N/A — Router accepts native ETH only. FeeReceiver may swap to WETH but that's downstream. |
| Griefing via failed factory reverts | Every revert path is user's own tx; attacker can't stick another user with the cost. |

---

## Deploy

**Constructor:**
```solidity
constructor(
    address initialOwner,
    NameRegistry _registry,
    IFeeReceiver _feeReceiver,
    uint256 erc20Fee_,
    uint256 nftFee_,
    uint256 erc1155Fee_,
    uint256 moduleAddOn_,
    uint256 hookAddOn_,
    uint256 governanceAddOn_
)
```

`registry` and `feeReceiver` are immutable. All factories start unset; the deploy script calls `setFactory` for each base type after each factory deploys.

**Post-deploy checklist:**
1. Deploy each factory (`ERC20Factory`, `ERC721AFactory`, `ERC1155Factory`).
2. `router.setFactory(base, factoryAddr)` for each.
3. `registry.setRouter(routerAddr)`.
4. Verify each contract on Etherscan.
5. Transfer ownership on all four contracts to the 2-of-3 multisig.
6. Add addresses to `web/lib/config.ts` and to `indexer/ponder.config.ts`.

**Fee schedule per PLAN.md §Economic model:**
| BaseType | Mainnet | Base |
|---|---|---|
| ERC20 | 0.05 ETH | 0.005 ETH |
| ERC721A | 0.05 ETH | 0.005 ETH |
| ERC1155 | 0.05 ETH | 0.005 ETH |
| Module add-on (per extra) | 0.01 ETH | 0.001 ETH |
| Hook add-on | 0.10 ETH | 0.01 ETH |
| Governance add-on | 0.10 ETH | 0.01 ETH |

Base chain fee schedule deployed later (Phase 5).

---

## Testing checklist

- Unit: `launch` happy path (single-module ERC-20); each revert branch (insufficient fee, unset factory, empty name, empty ticker, paused).
- Unit: refund correctness — `msg.value = quote + wei` refunds exactly `wei`.
- Unit: each ownership mode dispatch — Renounce fires `renounceOwnership`; TransferToMultisig fires `transferOwnership(target)`; KeepEOA fires `transferOwnership(msg.sender)`.
- Unit: quote determinism — `quote(params)` == fee actually charged.
- Integration: full happy path through NameRegistry + factory + template — 1 module, 3 modules, 8 modules configurations.
- Integration: factory revert bubbles up and unwinds registry reservation.
- Integration: `NameRegistry.Reserved` never appears without a matching `Router.Launched` in the same tx.
- Fuzz: `quote` never overflows for any valid config; fee formula is monotonic in module count.
- Invariant: 1–7 above.

**Coverage target:** >95% lines + branches for Router; >95% for FeeReceiver.

---

## FeeReceiver (companion contract, `contracts/src/router/FeeReceiver.sol`)

Minimal contract:

```solidity
interface IFeeReceiver {
    function receiveFee(address launcher, BaseType base) external payable;
    function sweep(address to) external;   // onlyOwner
}
```

- Accepts ETH sent by Router. Emits `FeeReceived(launcher, base, amount)`.
- Owner sweeps to treasury.
- No conversion / no swap. WETH conversion, if wanted, is a downstream feature.
- Owner = 2-of-3 multisig.

This keeps Router stateless and lets a v2 FeeReceiver (e.g. one that auto-swaps to USDC and forwards) drop in without touching Router.
