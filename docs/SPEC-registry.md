# SPEC — NameRegistry

> Onchain source of truth for reserved token names and tickers. Every VM launch consults it before deploy. Immutable reservations, Router-gated writes, admin-owned reserved-list.

**Status:** ✅ IMPLEMENTED. This document is the design-intent reference; the shipping contract is `contracts/src/registry/NameRegistry.sol` and covers everything below.
**File:** `contracts/src/registry/NameRegistry.sol`
**Tests:** `test/unit/NameRegistry.t.sol` — 54 tests including name/ticker normalization, reservation atomicity, admin-only reserved-list, whitespace collision handling.

---

## Purpose

Every launchpad token has a human-readable name (`"Vending Machine Token"`) and a market ticker (`"VMT"`). VM commits to global uniqueness within its ecosystem so that a token launched today cannot have its identity impersonated later. The registry:

- Rejects duplicates before the Router calls a factory (atomic with the launch tx).
- Rejects a curated reserved-ticker list (e.g. `ETH`, `USDC`, `WBTC`, `WETH`, `DAI`, common protocol tickers).
- Normalizes names before hashing so homoglyph and case variants collide with the original.
- Emits public events consumed by the indexer and the frontend's live availability check.

Reservations are permanent. There is no unreserve, no rename, no expiry. The registry is a monotonically growing record.

---

## State

| Variable | Type | Purpose |
|---|---|---|
| `router` | `address` | Only address permitted to call `reserve`. Set by owner. |
| `treasury` | `address` | Beneficiary of any protocol-side sweeps (unused v1 but wired for future). |
| `_reservations` | `mapping(bytes32 nameHash => Reservation)` | Canonical name registry. `nameHash = keccak256(bytes(_normalize(name)))`. |
| `_tickerOwner` | `mapping(bytes32 tickerHash => address token)` | Ticker → token address. `tickerHash = keccak256(bytes(_normalizeTicker(ticker)))`. |
| `_reservedTickers` | `mapping(bytes32 tickerHash => bool)` | Curated blocklist. Owner-managed. |
| `_owner` | `address` | Solady Ownable owner. Only used for admin ops. |

`Reservation` layout:

```solidity
struct Reservation {
    address token;         // the token contract this reservation points to
    address launchedBy;    // msg.sender at Router.launch() time
    uint64  timestamp;     // block.timestamp of reservation
    uint32  chainId;       // block.chainid — cements the chain of record for future cross-chain mirror
    string  name;          // canonical stored form (post-normalize; original casing preserved for display)
    string  ticker;        // canonical stored form (uppercase)
}
```

Storage layout is fixed. This contract is **not upgradeable** — a future version ships as a new contract with a migration path if ever needed.

---

## Normalization

Ambiguity in strings is a security problem for a global registry (`ETH` vs `ΕΤΗ` with Greek caps, or `Coca-Cola` vs `Coca–Cola` with an en-dash). The registry rejects ambiguity at the input boundary rather than resolving it post-hoc.

**`_normalize(name)`:**
- Accept ASCII only: `[A-Za-z0-9 \-_]`. Reject anything else → revert `NameRegistry__InvalidCharacter`.
- Collapse any run of internal whitespace to a single space.
- Strip leading/trailing whitespace.
- Lowercase for hashing purposes. **Original casing is preserved in `Reservation.name` for display**, but the hash is over the lowercase form.
- Length bounded: `1 ≤ length ≤ 32` chars post-trim. Revert `NameRegistry__NameLength`.

**`_normalizeTicker(ticker)`:**
- Accept `[A-Z0-9]` only. Reject anything else → revert `NameRegistry__InvalidTicker`.
- Length bounded: `2 ≤ length ≤ 10`. Revert `NameRegistry__TickerLength`.
- No lowercase — uppercase is the ticker convention.

Rejecting non-ASCII eliminates homoglyph classes at the character-set level. Trade-off: non-English tokens can't register a native-script name in v1. Deliberate; a v2 registry may accept UTF-8 with a canonicalization pass.

---

## Functions

### `reserve(name, ticker, token, launchedBy) → (nameHash, tickerHash)`
- **Caller:** `router` only. Reverts `NameRegistry__NotRouter` otherwise.
- **Effect:** Normalizes inputs; asserts availability; stores `Reservation`; emits `Reserved`.
- **Reverts:** invalid character/length, name already taken (`NameRegistry__NameTaken`), ticker taken (`NameRegistry__TickerTaken`), ticker in reserved-list (`NameRegistry__TickerReserved`), zero `token` (`NameRegistry__ZeroAddress`).
- **Atomicity:** the Router calls this within its own `launch` tx AFTER the factory deploys and BEFORE returning to caller. If any part of the launch reverts, the reservation reverts with it. There is no partial state.

### `isNameAvailable(name) → bool`
- **Caller:** anyone. `view`. Never reverts on invalid input — returns `false` for invalid names too, so the FE can display "not available" for garbled input without a try/catch. Distinguishing between "taken" and "invalid" is `validateName`'s job.

### `isTickerAvailable(ticker) → bool`
- **Caller:** anyone. `view`. Same behavior as `isNameAvailable`.

### `validateName(name) → (bool valid, uint8 reason)`
- **Caller:** anyone. `view`. Returns a bool + a `NameRegistryValidation` enum (`Ok`, `InvalidCharacter`, `TooShort`, `TooLong`, `AlreadyTaken`). Lets the FE render precise inline errors.

### `validateTicker(ticker) → (bool valid, uint8 reason)`
- As above, with reasons `Ok`, `InvalidCharacter`, `TooShort`, `TooLong`, `AlreadyTaken`, `Reserved`.

### `reservationOf(nameHash) → Reservation`
- **Caller:** anyone. `view`. Returns the full record (zero-struct if not present).

### `tickerOwner(tickerHash) → address`
- **Caller:** anyone. `view`. Returns the token address associated with the ticker (address(0) if unset).

### `setRouter(newRouter)` — `onlyOwner`
- One-time or careful lifecycle. Emits `RouterSet`. Recommend timelock in v2.

### `addReservedTicker(ticker)` / `removeReservedTicker(ticker)` — `onlyOwner`
- Curated blocklist management. Emits `ReservedTickerAdded` / `ReservedTickerRemoved`. Removal only permitted if `_tickerOwner[tickerHash] == address(0)` (i.e. nobody has reserved it since it was added — otherwise removal is meaningless).

### `setTreasury(newTreasury)` — `onlyOwner`
- Reserved for future sweep flows. Emits `TreasurySet`.

### `transferOwnership(newOwner)` — Solady Ownable inherited (two-step recommended)

---

## Events

```solidity
event Reserved(
    bytes32 indexed nameHash,
    bytes32 indexed tickerHash,
    address indexed token,
    address launchedBy,
    string  name,
    string  ticker,
    uint256 timestamp,
    uint256 chainId
);
event RouterSet(address indexed oldRouter, address indexed newRouter);
event ReservedTickerAdded(bytes32 indexed tickerHash, string ticker);
event ReservedTickerRemoved(bytes32 indexed tickerHash, string ticker);
event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
```

All state-changing paths emit exactly one event. The indexer treats `Reserved` as the primary launch signal (`Router.Launched` is the secondary correlate — see SPEC-router).

---

## Access control

| Function | Access | Reason |
|---|---|---|
| `reserve` | `onlyRouter` | Registry is not the user-facing entry point; only Router pays fees + reserves atomically. |
| `setRouter`, `addReservedTicker`, `removeReservedTicker`, `setTreasury`, `transferOwnership` | `onlyOwner` | Admin controls. Owner should transfer to a multisig or timelock post-deploy. |
| `isNameAvailable`, `validateName`, `isTickerAvailable`, `validateTicker`, `reservationOf`, `tickerOwner`, `owner`, `router`, `treasury` | public `view` | Read paths are free. |

**Post-deploy:** `transferOwnership` to a 2-of-3 multisig within the first admin action after deploy.

---

## Reentrancy

`reserve` performs no external calls after state writes. It reads calldata, computes hashes, checks mappings, writes mappings, emits an event. No ETH or token movement in this contract. No reentrancy guard needed for `reserve` per se — the enclosing tx in `Router.launch` is `nonReentrant`, which is sufficient.

Admin functions perform no external calls.

---

## Invariants (target invariant tests)

1. **Monotonic reservations:** for any `nameHash`, `_reservations[nameHash].token` is either `address(0)` (never reserved) or a stable non-zero address. It never reverts to zero, never changes to another address.
2. **Name/ticker parity:** for every reserved `nameHash` with `token != 0`, there is a corresponding `_tickerOwner[tickerHash] == token` populated in the same tx.
3. **Reserved list cannot be bypassed:** if `_reservedTickers[tickerHash] == true`, then `_tickerOwner[tickerHash] == address(0)` (nobody was ever able to reserve it) AND any subsequent `reserve` with that ticker reverts.
4. **Router exclusivity:** every non-zero state transition on `_reservations` and `_tickerOwner` was preceded by `msg.sender == router` in that tx.
5. **Owner exclusivity:** every non-zero state transition on `_reservedTickers`, `router`, `treasury`, or the Ownable owner slot was preceded by `msg.sender == owner()` in that tx.
6. **Normalization determinism:** for any two inputs `a, b` that produce the same normalized form, `keccak256(_normalize(a)) == keccak256(_normalize(b))`.

An invariant test harness fuzzes `reserve` calls (via a handler that impersonates the Router) and admin actions and asserts the above after every step.

---

## Attack surface

Per ETHSKILLS Security §Access control, §Input validation. See also §Access control above.

| Vector | Mitigation |
|---|---|
| Homoglyph collision (`ETH` vs `ΕΤΗ`) | ASCII-only character set at input. |
| Case variant collision (`ETH` vs `eth`) | Ticker forced uppercase; name lowercased for hash. |
| Whitespace/dash noise (`Coca Cola` vs `Coca  Cola` vs `Coca-Cola`) | Whitespace collapsed. Dash is a distinct character — `Coca Cola` and `Coca-Cola` remain distinct names by design (they display differently). |
| Front-run reservation griefing | Not fully mitigable on-chain — the attacker still has to pay a full launch fee to reserve a name. Accept + monitor. UX countermove: allow a small `nonce` in the FE so a user's second attempt with the same name gets a slightly different reservation identity. |
| Router compromise | If Router is compromised, attacker can reserve arbitrary names but cannot rewrite existing reservations (invariant 1). Owner can `setRouter` to a new address; existing reservations remain valid pointers to already-deployed tokens. Old poisoned reservations are stuck — this is why `setRouter` should be timelocked. |
| Owner compromise | Attacker can rotate router and add/remove reserved tickers. Cannot rewrite existing reservations (invariant 1) or steal fees (this contract holds none). Recommend Owner = timelocked multisig from day one. |
| Zero-address token | Rejected by `NameRegistry__ZeroAddress` in `reserve`. |
| Integer overflow on `timestamp`/`chainId` | uint64 timestamp lasts ~584B years; uint32 chainId covers all realistic chain ids. |
| Reserved-ticker bypass via race between `addReservedTicker` and `reserve` | Owner is admin; admin bakes the reserved list into the constructor. Post-deploy additions handle new listings — if an attacker beats an addition to `reserve`, they win once. Accept and monitor. |
| Reentrancy | No external calls in `reserve` or admin. Not applicable. |
| Storage collision if ever upgraded | Not upgradeable. If a v2 registry ships, it deploys at a new address; historical lookups still route to v1. |

---

## Deploy

**Constructor:**
```solidity
constructor(
    address initialOwner,
    address initialTreasury,
    string[] memory initialReservedTickers
)
```
- `initialOwner` — deployer or a pre-existing multisig. Transferred to timelocked multisig immediately post-deploy if EOA is used.
- `initialTreasury` — protocol treasury address, unused v1 but set now to avoid a `setTreasury` tx later.
- `initialReservedTickers` — seed list. See below.

**Initial reserved-ticker seed (candidate v1):**
`ETH`, `WETH`, `USDC`, `USDT`, `DAI`, `WBTC`, `MATIC`, `LINK`, `UNI`, `AAVE`, `COMP`, `MKR`, `SUSHI`, `CRV`, `LDO`, `PEPE`, `SHIB`, `DOGE`, `BASE`, `OP`, `ARB`, `SOL`, `BNB`, `AVAX`, `NEAR`, `ATOM`.

This is a launchpad-anti-scam decision, not a legal one. The list can be edited post-deploy by owner. Frontend must display the current list under the ticker input.

**Post-deploy checklist:**
1. `setRouter(routerAddress)` immediately after Router deploys.
2. Transfer ownership to a 2-of-3 multisig.
3. Verify on Etherscan (`forge verify-contract`).
4. Add the contract address to `web/lib/config.ts` and to the indexer's `ponder.config.ts`.

---

## Testing checklist (contracts/test/unit/NameRegistry.t.sol + invariant/)

- Unit: reserve happy path, reserve wrong-caller reverts, name-taken revert, ticker-taken revert, reserved-ticker revert, zero-address revert, invalid-char revert (multiple non-ASCII inputs), length-boundary reverts, admin-only reverts on ops.
- Unit: `validateName` / `validateTicker` all reason codes.
- Unit: normalization equivalence — `"Foo"` and `" foo "` and `"foo"` collide; `"F00"` (zeros) and `"FOO"` do not.
- Fuzz: `reserve` with random valid ASCII strings; assert lookup round-trips and no duplicate hashes ever cross.
- Invariant: 1–6 above, using a handler that mocks the Router.

**Coverage target:** >95% lines + branches.

---

## Open questions

- Should we support a 2-step "rename" for token creators who mistype their launch (admin-controlled `_relabelDisplay` that changes the stored human name without changing the hash)? Deferred — needs ADR.
- Should the ticker character set include hyphens (e.g. `WETH-2X`)? Currently no. Deferred.
- Cross-chain mirror mechanics — deferred to SPEC-registry-mirror (Phase 5 / VM-601).
