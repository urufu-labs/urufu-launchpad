# Audit prep — formal invariants + threat model per contract

> Handoff document for external auditors. One page per critical contract with the exact
> properties it must maintain, the threat model I've considered, and what my own tests
> already cover. Read this alongside `docs/SECURITY.md` (triage of Slither findings) and
> `docs/SPEC-*.md` (design-intent per contract).

**Repo commit:** point auditors at whatever HEAD is at engagement start; embargo any
in-flight changes for the review period.

**Test surface at handoff:**
- 485 in-memory + fuzz + invariant tests, all passing
- 2 fork tests against real Sepolia Uniswap v4
- Slither pass with `bash contracts/security.sh` — 2 High confirmed false positives (see
  `docs/SECURITY.md`)

---

## Router.sol

**Purpose:** user-facing launch entry. Collects fee, deploys token via factory, reserves
name, dispatches ownership, optionally installs a bonding curve.

**Invariants (must hold across every reachable state):**

1. **`launch()` is atomic.** Either the token is deployed AND the name is reserved AND
   ownership is dispatched AND excess is refunded, or the whole tx reverts and no state
   changes persist.
2. **Fee conservation.** `FeeReceiver.balance == Σ(fees paid for successful launches)`.
   Fuzzed by `RouterInvariant.invariant_FeeReceiverBalanceMatchesLaunches`.
3. **No stuck ETH.** Router itself holds zero ETH between transactions. Fuzzed by
   `invariant_RouterHoldsNoEth`. If it ever holds ETH, `sweepStuckETH(address)` is the
   documented recovery path.
4. **Uniqueness.** Every successful launch produces a distinct token address (via CREATE2
   salt uniqueness) AND a distinct `(nameHash, tickerHash)` reservation in the registry.
   Fuzzed by `invariant_UniqueLaunchedTokens`.
5. **Pause honoring.** When `paused == true`, every `launch()` reverts with
   `Router__Paused`. Existing tokens + curves are unaffected.
6. **CurveFactory gating.** When `installBondingCurve == true`, `base` MUST be `ERC20`
   AND `curveFactory != address(0)`. Else revert with `Router__CurveOnlyForERC20` or
   `Router__CurveFactoryUnset`.

**Threat model:**
- Malicious factory returning a token address the launcher doesn't own → mitigated: Router
  is the initial owner; ownership dispatch is Router-controlled.
- Front-running the CREATE2 salt to deploy at a launcher's predicted address before them
  → mitigated: salt is `keccak256(launcher, name, ticker, chainid)` — the launcher's
  address is baked in. An attacker with a different address gets a different salt.
- Fee bypass via re-entrant `launch()` → mitigated: `nonReentrant` modifier.
- Owner rug via `setFactory(malicious)` → mitigated by ownership handoff to multisig
  post-broadcast (`HandoffOwnership.s.sol`).
- Griefing via name-squatting → the launcher pays gas to reserve; no gas subsidy exists.
  Registry's `reserved` list handles high-value tickers admin-side.

**Known limitations:**
- No fee-on-transfer token check for `installBondingCurve` launches (SPEC-curve §Attack surface).

---

## NameRegistry.sol

**Purpose:** on-chain source of truth for `(name, ticker) → token` reservations. Router
is the only allowed writer post-`setRouter`.

**Invariants:**
1. **Router-gated writes.** `reserve()` reverts unless `msg.sender == router`. Router
   address is admin-set once at construction (or migrated via `setRouter`).
2. **Immutable reservations.** Once a `(nameHash, tickerHash)` pair is reserved, it can
   never be re-reserved or overwritten. `Reservation` struct fields are set-once.
3. **Reserved-ticker enforcement.** Any ticker in the initial `reserved` list AND any
   admin-added ticker reverts on `reserve()` with `NameRegistry__TickerReserved`.
4. **Name normalization stability.** `validateName(x)` returns the same result for
   equivalent inputs after whitespace collapse + lowercasing. `Reservation.name` stores
   the DISPLAY form; the hash is over the NORMALIZED form.
5. **View determinism.** `isNameAvailable`, `isTickerAvailable`, `validateName`,
   `validateTicker` are pure view — must not mutate.

**Threat model:**
- Squatting a valuable name for future ransom → mitigated: launcher pays a launch fee
  every reservation, so squatting has real cost.
- Whitespace collision attacks (`urufu labs` vs `urufulabs`) → mitigated: normalization
  collapses runs of whitespace before hashing.
- Zero-and-o / lookalike character confusion → currently accepted (`urufu0` and `urufuO`
  are distinct). Test coverage: `test_Reserve_ZeroAndOhAreDistinct`.
- Router compromise → mitigated: registry's `router` is admin-mutable; the multisig can
  swap in a v2 Router without redeploying registry.

**Known limitations:**
- Reservations are permanent. There's no "release name back" flow. If a launched token is
  abandoned, its name stays taken.

---

## BondingCurve.sol

**Purpose:** x·y=k bonding curve with virtual reserves. One clone per launched token.

**Invariants:**
1. **Token balance = tracked reserve.** `token.balanceOf(curve) == curve.tokenReserve()`
   at ALL times. Fuzzed by `BondingCurveInvariant.invariant_TokenBalanceMatchesReserve`.
2. **ETH balance = tracked reserve.** `curve.balance == curve.ethReserve()` when no
   graduator is wired. Fuzzed.
3. **Total supply conservation.** The curve itself never mints or burns; `totalSupply` of
   the underlying token is fixed at `curveSupply` throughout curve life. Fuzzed by
   `invariant_TotalSupplyUnchanged`.
4. **Graduated is one-way.** Once `graduated == true`, both `buy` and `sell` revert with
   `BondingCurve__Graduated`. Fuzzed.
5. **Fee direction.** `feeReceiver.balance` is monotonic non-decreasing. Fuzzed.
6. **Token accounting.** `Σ(actor balances) + curve balance == curveSupply` for all
   configurations. Fuzzed by `invariant_TokensAccountedFor`.
7. **Slippage protection honored.** `buy(minTokensOut)` and `sell(_, minEthOut)` revert
   with `Slippage(got, min)` if the realized output is under the caller's floor.

**Threat model:**
- Sandwich attacks on `buy` → mitigated by `minTokensOut` slippage floor.
- Reentrancy during `sell` (native ETH send) → mitigated by `nonReentrant`.
- USDT-family tokens that don't return true on transfer → mitigated by
  `SafeTransferLib.safeTransferFrom/safeTransfer`.
- Precision loss on integer division → auditor please review: the `newEffToken = k / newEffEth`
  path rounds down, which means tokensOut is slightly higher than exact math would give.
  Not a security issue (curve's loss, buyer's gain), but worth confirming there's no
  compounding drift.
- Graduation griefing (whale drains curve to zero to abort graduation) → mitigated:
  `_graduate()` is called atomically inside the triggering `buy`; either the whole tx
  succeeds or reverts.

**Known limitations:**
- Fee-on-transfer tokens as the launched asset break the reserve tracking (curve receives
  less than approved). Not currently enforced in `initialize`.

---

## Graduator.sol

**Purpose:** takes a graduated curve's ETH + tokens, mints a full-range v4 LP position,
LP is locked forever by `LPLockedHook`.

**Invariants:**
1. **`unlockCallback` is PoolManager-only.** Any other caller reverts with
   `Graduator__NotPoolManager`.
2. **Exact-value settlement.** The delta returned by `poolManager.modifyLiquidity` is
   what gets settled — never the pre-computed intended amounts. This protects against
   rounding drift between our `LiquidityAmounts.getLiquidityForAmounts` and v4's internal
   amount-for-liquidity math.
3. **ETH-mismatch guard.** `execute()` reverts with `Graduator__EthMismatch` if
   `msg.value != ethAmount`.
4. **LP position ownership immutable.** Graduator is the `owner` of the LP position (via
   `modifyLiquidity` msg.sender). Combined with `LPLockedHook`, no path exists to remove
   liquidity — verified end-to-end in `test/curve/GraduationForkTest.t.sol`.

**Threat model:**
- Impersonating PoolManager to call `unlockCallback` with malicious data → mitigated:
  `msg.sender == poolManager` check.
- USDT-family tokens → mitigated by `SafeTransferLib`.
- LP theft after graduation → impossible: `LPLockedHook.beforeRemoveLiquidity` reverts
  every call, verified by fork test against real Sepolia PoolManager.
- Sandwich the graduation tx → the pool doesn't exist yet at that moment; no swap surface
  to sandwich until `poolManager.initialize` fires inside `execute`.

**Known limitations:**
- Fee tier + tick spacing are immutable at Graduator deploy time. Changing them requires
  a new Graduator + `CurveFactory.setGraduator`.
- Full-range LP is capital-inefficient vs a concentrated position, but it's the simplest
  provably-lock-safe shape.

---

## LPLockedHook.sol + MultiHookHost.sol + FeeRedirectHook.sol + AntiSniperHook.sol + BuybackBurnHook.sol

**Purpose:** v4 hooks that shape pool behavior post-graduation. Each has a specific
permission bit mask encoded in its deployed address.

**Common invariants:**
1. **Callback authorization.** Every hook callback has `onlyPoolManager` — reverts with
   `BaseHook__NotPoolManager` otherwise.
2. **Non-implemented callbacks revert.** `BaseHook` default is `BaseHook__NotImplemented`
   for every callback subclasses don't override. Protects against v4 calling a hook whose
   address bits advertise a permission the code doesn't actually handle.
3. **Address bits match permissions.** Deploy-time invariant: mining via `HookMiner`
   produces addresses where `uint160(hook) & 0x3FFF == permissionBits`.

**Per-hook properties:**

**LPLockedHook** — `beforeRemoveLiquidity` unconditionally reverts. LP locked at protocol
level. Verified against real Sepolia v4 in `LPLockedHookForkTest`.

**FeeRedirectHook** — `afterSwap` takes bps of the unspecified (output) currency and
credits it to internal `owed` mapping. `claim(currency)` sweeps via `poolManager.unlock` →
`take` path. Invariant: bps capped at `MAX_TOTAL_BPS = 3000` (30%).

**MultiHookHost** — Combines LPLocked + FeeRedirect. Same claim path. `PoolKey.hooks` is
one address per pool; combining behaviors here means both take effect.

**AntiSniperHook** — `beforeInitialize` records pool init block; `beforeSwap` reverts
until `block.number ≥ initBlock + gateBlocks`. Auto-expires after window.

**BuybackBurnHook** — `afterSwap` takes bps of the launched-token output and routes it to
`0xdead`. Invariant: bps capped at `MAX_BPS = 2000` (20%).

**Threat model:**
- Hook impersonation → mitigated: `onlyPoolManager`.
- Sending unlocked funds to wrong recipient in claim → mitigated: `unlockCallback` only
  callable by PoolManager AND decodes the recipient from data.
- BuybackBurn against a fee-on-transfer target → the hook doesn't validate; UI compat
  check catches by declaring incompatibility.
- v4 hook re-entrancy → v4 already handles reentrancy via its `unlock` state machine.

---

## Factories (ERC20Factory, ERC721AFactory, ERC1155Factory, CurveFactory)

**Purpose:** deploy cloned tokens/curves via EIP-1167 at deterministic addresses.

**Common invariants:**
1. **Impl registry is immutable-once-registered.** `registerImpl(configHash, impl)`
   reverts if `configHash` already has an impl. No un-register, no re-register.
2. **Only Router deploys.** `deploy()` reverts unless `msg.sender == router` (base
   factories); `createCurve()` on CurveFactory is public but each token gets exactly one
   curve.
3. **Salt uniqueness.** Base factories use
   `keccak256(launcher, name, ticker, chainid)`. CurveFactory uses
   `keccak256(token, chainid)`. Both prevent front-mining collisions.
4. **Init pre-check.** CurveFactory checks caller has ≥ `defaultCurveSupply` tokens BEFORE
   cloning — avoids stuck empty clones.

**Threat model:**
- Malicious registrar registering a backdoor impl → mitigated: `registerImpl` is
  `onlyRegistrar`; registrar is expected to be a hot key rotated to compile-service or
  the multisig post-launch.
- CREATE2 address collision → mathematically impossible for well-formed salt formulas.
- Impl storage-layout mismatch across versions → mitigated: base templates freeze slot
  order; modules append AFTER `_initialized`.

**Known limitations:**
- Dynamic on-demand impl registration from the compile-service backend is deferred to
  Phase 6 (`URU-601`). Today only the ~40 curated configs `DeployPhase1` registers can
  launch.

---

## Templates (ERC20Template, ERC721ATemplate, ERC1155Template, ERC20VotesTemplate)

**Purpose:** bare base contracts with `VM_INJECT_*` markers where the splicer injects
audited module fragments.

**Common invariants:**
1. **`initialize` is one-shot.** `_initialized != 0` on entry reverts with
   `<Template>__AlreadyInitialized`. Prevents re-initialization of a clone.
2. **Ownership handoff.** Factory forces `initialOwner = Router` so Router controls
   post-init dispatch to launcher / multisig / renounce.
3. **Storage layout is frozen.** `_vmName`, `_vmSymbol`, `_initialized` slots never move.
   Any module storage MUST append after `_initialized` to preserve clone compatibility
   across template versions.
4. **Composed impls inherit the base template's ABI.** `initialize(bytes)` signature is
   consistent; module state is decoded from `moduleData[N]` per position.

**Threat model:**
- Storage collision from a mis-authored module → mitigated by convention (append-only)
  and by requiring every module ship with a test that inits + interacts with the impl.
- Selector collision between modules and base → the compile-service splicer refuses to
  compile if a marker section already contains conflicting definitions.
- Cross-clone state bleed → impossible; EIP-1167 clones have independent storage.

---

## Testing surface for auditors to expand

Areas where more property tests would be highest value:

1. **Cross-composition invariants** — modules that don't conflict on the compat matrix
   should compose without runtime bugs. Fuzz sequences of `launch → module_call → module_call`
   against every pair.
2. **Governor + Timelock + Votes end-to-end.** `GovernorBundle` deploys them at token
   init but there's no e2e "propose → queue → execute" test yet.
3. **Curve → v4 pool math edge cases.** Very small or very large graduation reserves;
   near-zero token amounts; single-wei rounding.
4. **Multi-curve concurrency.** No shared state exists between curves, but a stress test
   with dozens of parallel curves would catch any accidental factory-level coupling.

---

## Contact

Brandon (@brand) — sole approver. Rotate to a multisig before mainnet per
`HandoffOwnership.s.sol`. Bug bounty scope + payout tiers will be posted to Immunefi
post-audit-fix.
