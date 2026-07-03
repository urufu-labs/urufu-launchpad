# SPEC — Modules

> Module fragment interface, storage safety rules, matrix schema, plus first two module specs (`FeeOnTransfer`, `AntiBot`). Fragments are audited Solidity snippets the compile service splices into a base template's injection markers.

**Status:** ✅ IMPLEMENTED. 20 modules shipped across 4 categories, 5 v4 hooks, 3 more planned (B20 compliance lineup).
**Fragment files:** `contracts/modules/{token,nft,allocation}/*.frag.sol`
**Hook files:** `contracts/src/hooks/*.sol` (v4 hooks live in `src/`, not `modules/`, because they're not spliced — they're standalone contracts)
**Tests:** per-module at `test/composed/*Gen.t.sol` + `test/hooks/*.t.sol`
**Catalog:** `shared/matrix.json` (single source of truth read by FE + BE) and `web/src/lib/modules.ts` (UI shape).
**Notes since spec:** `FeeOnTransfer` + `AntiBot` shipped as designed; 18 additional modules added across `token/`, `nft/`, `allocation/`. See `docs/SPEC-hooks.md` for the 5 v4 hooks and their permission bit patterns.

---

## Fragment file format

A module fragment lives at `contracts/src/modules/<category>/<ModuleName>.frag.sol`. It is **not** a compilable contract on its own — it's a template snippet that only compiles when spliced into a base template. The file uses this exact section layout:

```solidity
// SPDX-License-Identifier: MIT
// VM_MODULE_ID: FeeOnTransfer
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH: Rebasing
// VM_MODULE_FLAGGED:

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error FeeOnTransferModule__ZeroFee();
error FeeOnTransferModule__InvalidSplits(uint256 sum);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event FeeOnTransferAccrued(address indexed target, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint16 private _feeOnTransferBps;         // e.g. 500 = 5%
uint16 private _fotBurnBps;                // splits sum to 10_000
uint16 private _fotTreasuryBps;
uint16 private _fotLPBps;
uint16 private _fotHoldersBps;
uint16 private _fotCreatorBps;
address private _fotTreasury;
address private _fotLPAddress;
address private _fotHoldersReceiver;
address private _fotCreatorReceiver;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (
        uint16 fotBps,
        uint16 burn, uint16 treasury, uint16 lp, uint16 holders, uint16 creator,
        address treasuryAddr, address lpAddr, address holdersAddr, address creatorAddr
    ) = abi.decode(_fotInitData, (uint16, uint16, uint16, uint16, uint16, uint16, address, address, address, address));

    if (fotBps == 0) revert FeeOnTransferModule__ZeroFee();
    if (uint256(burn) + treasury + lp + holders + creator != 10_000) {
        revert FeeOnTransferModule__InvalidSplits(uint256(burn) + treasury + lp + holders + creator);
    }
    _feeOnTransferBps = fotBps;
    _fotBurnBps = burn; _fotTreasuryBps = treasury; _fotLPBps = lp;
    _fotHoldersBps = holders; _fotCreatorBps = creator;
    _fotTreasury = treasuryAddr; _fotLPAddress = lpAddr;
    _fotHoldersReceiver = holdersAddr; _fotCreatorReceiver = creatorAddr;
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
{
    // See §FeeOnTransfer for the accrual logic.
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function withdrawFeeOnTransferAccrued(address to) external onlyOwner nonReentrant {
    uint256 amount = _fotAccrued[to];
    if (amount == 0) return;
    _fotAccrued[to] = 0;
    // ...
}
```

**Header rules:**
- `VM_MODULE_ID` — unique, PascalCase, no spaces. Alphabetical order determines splice order.
- `VM_MODULE_VERSION` — bump on any change to fragment content. Config hash includes this.
- `VM_MODULE_BASES` — comma-separated list of `BaseType`s the module supports.
- `VM_MODULE_REQUIRES` — comma-separated module IDs required for this module to be usable.
- `VM_MODULE_INCOMPATIBLE_WITH` — comma-separated module IDs that can't coexist with this one.
- `VM_MODULE_FLAGGED` — a short human-readable reason if this module is flagged in the UI (e.g. `"reduces decentralization"` for `Pausable`).

**Section rules:**
- Every section marker exists in the file. Empty sections are allowed — they compile to nothing.
- Section bodies inside `INIT`, `BEFORE_TRANSFER`, `AFTER_TRANSFER`, `BEFORE_MINT`, `AFTER_MINT`, `BEFORE_BURN`, `AFTER_BURN` are wrapped in `{ ... }` blocks — the splicer literally inlines them into the target template's hook function. Solidity's block scoping isolates module-declared local variables.
- Sections outside those hooks (`ERRORS`, `EVENTS`, `STATE`, `CONSTANTS`, `MODIFIERS`, `EXTERNAL`, `INTERNAL`) are top-level declarations. The splicer inserts them at the corresponding marker with a blank line separator per module.

---

## Storage safety

**Rule 1 — Base storage is frozen.** Modules only add storage at `VM_INJECT_STATE`, which is placed after all base declarations in the template. Solidity assigns slots by declaration order, so base slots are stable across compositions.

**Rule 2 — Name uniqueness.** Module state variables MUST be prefixed with a module-derived tag (e.g. `_fot*` for FeeOnTransfer, `_ab*` for AntiBot). The compile service rejects any composition where two modules declare identifiers with matching names in the same scope.

**Rule 3 — No storage layout dependency between modules.** A module fragment cannot rely on another module's storage slot being at a specific position. Cross-module references go through named getters/setters (if a module exposes helpers via `VM_INJECT_INTERNAL`) or via the base template's public interface. Enforced by review.

**Rule 4 — Namespaced mappings (optional but recommended for shared state).** Modules that hold per-address accounting SHOULD derive their base pointer from `keccak256("vm.mod.<ModuleId>.<field>")` when the field is a mapping. For MVP this is optional; enforced from Phase 3 forward.

---

## Compatibility matrix — `shared/matrix.json`

Single source of truth for the frontend (grey-out incompatible options) and the compile service (validate on submit).

```jsonc
{
  "modules": {
    "FeeOnTransfer": {
      "base": ["ERC20"],
      "requires": [],
      "incompatibleWith": ["Rebasing"],
      "flagged": null,
      "params": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["feeBps", "burnBps", "treasuryBps", "lpBps", "holdersBps", "creatorBps"],
        "properties": {
          "feeBps":       { "type": "integer", "minimum": 1, "maximum": 3000 },
          "burnBps":      { "type": "integer", "minimum": 0, "maximum": 10000 },
          "treasuryBps":  { "type": "integer", "minimum": 0, "maximum": 10000 },
          "lpBps":        { "type": "integer", "minimum": 0, "maximum": 10000 },
          "holdersBps":   { "type": "integer", "minimum": 0, "maximum": 10000 },
          "creatorBps":   { "type": "integer", "minimum": 0, "maximum": 10000 },
          "treasury":     { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
          "lpAddress":    { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
          "holders":      { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
          "creator":      { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" }
        }
      }
    },
    "AntiBot": {
      "base": ["ERC20"],
      "requires": [],
      "incompatibleWith": [],
      "flagged": null,
      "params": {
        "type": "object",
        "required": ["blockGate"],
        "properties": {
          "blockGate":     { "type": "integer", "minimum": 0, "maximum": 100 },
          "allowlistRoot": { "type": "string", "pattern": "^0x[a-fA-F0-9]{64}$" },
          "commitReveal":  { "type": "boolean" }
        }
      }
    }
  }
}
```

**Frontend contract:** the shop UI reads `matrix.json` (via `shared/`), applies incompatibility rules live, and renders `params` as form fields. Validation happens both client-side (Zod schema derived from the JSON Schema) and server-side (compile service enforces the same schema).

**Server-side contract:** the compile service rejects any config where:
- A module ID isn't in `matrix.json`.
- A module ID doesn't declare the requested base in its `base` list.
- A required module is absent.
- An incompatible module is present.
- Params fail JSON Schema validation.

---

## Test fragments

Each module ships a paired test fragment at `contracts/test/modules/<ModuleName>.frag.t.sol`. Same section-marker convention, applied to a `Test` contract skeleton `contracts/test/modules/_MODULE_TEST_BASE.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
// VM_MODULE_TEST_ID: FeeOnTransfer

// ============================================================
// SECTION: VM_TEST_INJECT_STATE
// ============================================================
uint256 constant FEE_BPS = 500;

// ============================================================
// SECTION: VM_TEST_INJECT_SETUP
// ============================================================
{
    _initFeeOnTransfer(FEE_BPS, /* splits */ 2000, 2000, 2000, 2000, 2000, ...);
}

// ============================================================
// SECTION: VM_TEST_INJECT_TESTS
// ============================================================
function test_FeeOnTransfer_Levies_On_Transfer() public { ... }
function testFuzz_FeeOnTransfer_SplitsSumToTradeAmount(uint256 amount) public { ... }
```

The compile service, when running tests for a composition, merges all present module test fragments into a single test contract file, invokes `forge test` on the composition, and reports pass/fail per-test.

**Invariant-test fragments** live in `contracts/test/modules/<ModuleName>.inv.frag.t.sol` and follow the same pattern. Module authors write handler functions in `VM_TEST_INJECT_HANDLER` sections; the merged handler is a superset the invariant runner uses.

---

## FeeOnTransfer module

**File:** `contracts/src/modules/token/FeeOnTransfer.frag.sol`
**Base:** ERC-20
**Purpose:** Take a configurable percentage of every transfer and split it across burn / treasury / LP / holders / creator sinks.

**Params:**
| Param | Type | Range | Note |
|---|---|---|---|
| `feeBps` | uint16 | 1..3000 | Max 30% — matches the highest legitimate memecoin FoT rates while capping griefing. |
| `burnBps`, `treasuryBps`, `lpBps`, `holdersBps`, `creatorBps` | uint16 each | 0..10000 | Splits, must sum to exactly `10_000`. |
| `treasury`, `lpAddress`, `holders`, `creator` | address | non-zero if corresponding split > 0 | Zero if split is zero. |

**Behavior:**
- On every non-mint, non-burn transfer, `fee = amount * feeBps / 10_000`. Reduce the recipient's received amount by `fee`; distribute `fee` per splits.
- `burn` share is sent to `address(0)` — reduces `totalSupply` via `_burn(from, burnShare)`.
- `treasury`, `lp`, `holders`, `creator` shares are **accrued** in per-target mappings and pulled via `withdrawFeeOnTransferAccrued(target)`. Pull pattern avoids reentrancy and lets the recipient claim on their schedule.
- **Exclusion set:** Router-configurable list of addresses excluded from fees (typically: the deployer's LP, the FeeReceiver, the token itself). Default: token contract, `0x0`, current LP pool address if known at init.

**Invariants (fuzz-tested):**
- For any transfer of `amount` where `from` and `to` are not excluded: `balanceOf(to) increases by amount - fee`; `sum of accruals + burn increase == fee` (no wei lost).
- `_fotBurn + treasury + lp + holders + creator == fee` exactly.
- Excluded addresses see zero fee.

**Threat surface:**
- Rounding: `fee = amount * feeBps / 10_000`. Truncates. For `amount = 1 wei` and `feeBps = 500`, `fee = 0`. This is acceptable — the alternative (round up) creates inflation. Tested.
- Split rounding: each split slice is `fee * bpsShare / 10_000` — sum could be `fee - dust`. Dust (up to 4 wei) goes to the last split (creator) to keep the sum invariant. Tested.
- Exclusion griefing: if an attacker can inject an address into the exclusion set, they bypass fees. Access-controlled to `onlyOwner`; if user chose Renounce, exclusion list is frozen at initialize.

**External functions added:**
- `withdrawFeeOnTransferAccrued(address to) external nonReentrant` — anyone can trigger, funds go to the actual accrual owner. Owner-only for `treasury` (to reduce misdirection).
- `setFeeOnTransferExcluded(address who, bool excluded) external onlyOwner` — mutates exclusion set. Reverts if ownership is renounced.
- `feeOnTransferAccrued(address who) external view returns (uint256)` — read helper.

---

## AntiBot module

**File:** `contracts/src/modules/token/AntiBot.frag.sol`
**Base:** ERC-20
**Purpose:** Block predatory MEV bots from sniping the launch by combining block-gating, an allowlist, and optional commit-reveal.

**Params:**
| Param | Type | Note |
|---|---|---|
| `blockGate` | uint16 (0..100) | Number of blocks after launch during which non-allowlist buyers are blocked. `0` disables the gate. |
| `allowlistRoot` | bytes32 | Merkle root of pre-approved buyer addresses. `0x0` disables. |
| `commitReveal` | bool | If `true`, buyers must first commit `keccak256(address, secret)` in one tx, then reveal in a later tx to buy. Disables bot pre-computation. |

**Behavior:**
- **Block-gate phase (`block.number < launchBlock + blockGate`):** transfers from a "sale source" (typically Router or the curve contract) to a non-allowlist address revert with `AntiBot__Gated`. Existing holders can transfer freely. Once the gate expires, transfers unrestricted.
- **Allowlist:** merkle proof provided at first-transfer time. Once accepted, address is flagged as `passedAllowlist` and no proof required subsequently.
- **Commit-reveal:** buyer commits in tx N (`commitBot(hash)`), reveals in tx N+M (`M >= 1`) as part of the first buy tx. Reveal checks `hash == keccak256(msg.sender, secret)`.

**External functions added:**
- `provePassedAllowlist(bytes32[] calldata proof) external` — one-shot, stores flag.
- `commitBot(bytes32 hash) external` — records `hash → block.number`.
- `revealBot(bytes32 secret) external` — validates reveal, flags address.
- `antiBotExpiresAt() external view returns (uint256 blockNumber)`.

**Threat surface:**
- Sybil around allowlist: allowlist quality is the launcher's problem — the module trusts the provided root. UI should discourage naive lists (e.g. "verified Twitter followers only").
- Rewrite-history griefing: `blockGate` uses `block.number`, not `block.timestamp`. Immune to timestamp manipulation.
- Front-running the reveal: attacker sees a valid reveal in mempool and copies it. The reveal binds to `msg.sender` (`hash = keccak256(msg.sender, secret)`), so the attacker's `msg.sender` doesn't match. Safe.
- Trapped funds: if the launcher's allowlist has a bug that excludes real buyers, they can wait for the gate to expire (max 100 blocks). Not a permanent trap.

**Interaction with FeeOnTransfer:** independent. AntiBot decides who can transfer; FeeOnTransfer decides how much survives the transfer. Both hooks fire in `_beforeTransfer` — AntiBot's checks run first (alphabetical splice order).

**Invariants:**
- `antiBotPassed[addr] == true` implies at least one of: successful merkle proof, successful commit+reveal, or `block.number >= antiBotExpiresAt`.
- Post-expiry, all transfers succeed regardless of `antiBotPassed`.

---

## Splice determinism

- Modules are spliced **alphabetically by `VM_MODULE_ID`** into each marker. `AntiBot` fires before `FeeOnTransfer` because 'A' < 'F'.
- Config hash: `keccak256(abi.encode(base, sortedModuleIds, moduleParams, moduleVersions))`. Same config always yields same hash → same bytecode → same impl address (via CREATE2 in SPEC-factories).

---

## Testing checklist (per module)

- Unit tests via merged test fragment: happy path, each revert branch, boundary values.
- Fuzz over user-provided params where relevant.
- Invariant tests, using handler fragments — assert per-module invariants hold under random valid actions.
- Composition tests: the compile service runs the test suite for every enumerated composition in `contracts/test/modules/_matrix.compositions.json` (a set of interesting combos: 1 module, 3 modules, all modules).

**Coverage target:** >95% on any module that moves value; ≥90% on flavour-only modules (e.g. `Pausable`).

---

## Open questions

- Should we allow modules to be marked `deprecated` and rejected for new launches while remaining supported for existing tokens' governance? Currently no — new module versions bump `VM_MODULE_VERSION` and the frontend picks the latest. Deferred.
- Should the params JSON Schema allow default values that the frontend auto-fills? Yes — the frontend already does this via a `defaults` sidecar file. Not encoded in `matrix.json` yet.
- Cross-module storage aliasing (Rule 4 namespaced mappings) — enforce or recommend? Currently recommended for MVP, will become enforced when we hit the first realistic collision risk.
