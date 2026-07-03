# SPEC — Base Templates

> Three cloneable base contracts (ERC-20, ERC-721A, ERC-1155) with injection markers where the compile service splices audited module fragments. Each launched token is a normal, single-file contract — verifiable on Etherscan as itself.

**Status:** ✅ IMPLEMENTED. Three base templates (ERC-20, ERC-721A, ERC-1155) + `ERC20VotesTemplate` for governance-enabled launches (uses Solady `ERC20Votes` base).
**Files:** `contracts/src/templates/ERC20Template.sol`, `ERC721ATemplate.sol`, `ERC1155Template.sol`, `ERC20VotesTemplate.sol`
**Composed impls:** `contracts/src/templates/composed/*Gen.sol` — 33 spliced-and-committed contracts.
**Tests:** per-impl at `test/composed/*Gen.t.sol` — 100+ tests covering module init, state, and interaction paths.
**Notes since spec:** `VM_INJECT_*` marker convention shipped as designed. Base storage is FROZEN: `_vmName`, `_vmSymbol`, `_initialized` slots never move — clones survive template evolution as long as new modules only APPEND storage after `_initialized`.

---

## Purpose

Each template is a **pre-audited base contract** that the compile service transforms into a concrete deployable contract by splicing user-selected module fragments into fixed injection markers. Three properties matter:

1. **Base storage layout is frozen.** Modules can only append storage slots at the end. This makes composition safe by construction (Solidity storage layout follows declaration order; new slots never overlap existing ones).
2. **Every hook point a module might need already exists.** No module needs to re-implement `_transfer`; it hooks the `VM_INJECT_BEFORE_TRANSFER` marker instead.
3. **The compiled output is a single .sol file.** No delegatecall, no diamond, no runtime dispatch. Just Solidity. Etherscan verifies it normally.

The three templates share the same injection-marker convention. Differences between them stem from the underlying standard (ERC-20 is fungible with one hook path; ERC-721A batches mints; ERC-1155 has multi-id semantics).

---

## Injection markers (shared convention)

Each template contains exactly these markers, in this order, each on its own line, each surrounded by dividing comments. The compile service performs literal text substitution.

```solidity
// ============================================================
// VM_INJECT_ERRORS
// ============================================================
// Modules add custom errors here.

// ============================================================
// VM_INJECT_EVENTS
// ============================================================
// Modules add events here.

// ============================================================
// VM_INJECT_STATE
// ============================================================
// Modules add storage variables here. **APPEND ONLY** — never
// reorder, never insert into the base layout above this line.

// ============================================================
// VM_INJECT_CONSTANTS
// ============================================================
// Modules add `constant`/`immutable` variables here. Immutables are
// initialized in the constructor if any (clones don't run constructors,
// so immutables in a cloned template mean the impl was configured up
// front — see SPEC-factories §Impl registry).

// ============================================================
// VM_INJECT_INIT
// ============================================================
// Modules add per-launch initialization logic here. Called from
// `initialize(bytes)` after the base's own init.

// ============================================================
// VM_INJECT_MODIFIERS
// ============================================================
// Modules add custom modifiers here.

// ============================================================
// VM_INJECT_BEFORE_TRANSFER
// ============================================================
// Called at the top of every transfer path. See per-template notes for
// exact signature.

// ============================================================
// VM_INJECT_AFTER_TRANSFER
// ============================================================
// Called at the bottom of every transfer path. Same signature.

// ============================================================
// VM_INJECT_BEFORE_MINT
// ============================================================
// Called at the top of mint (ERC-20: `_mint`, ERC-721A: `_mint` batch,
// ERC-1155: `_mint` / `_mintBatch`).

// ============================================================
// VM_INJECT_AFTER_MINT
// ============================================================
// Called at the bottom of mint.

// ============================================================
// VM_INJECT_BEFORE_BURN
// ============================================================
// Called at the top of burn.

// ============================================================
// VM_INJECT_AFTER_BURN
// ============================================================
// Called at the bottom of burn.

// ============================================================
// VM_INJECT_EXTERNAL
// ============================================================
// Modules add new external/public functions here.

// ============================================================
// VM_INJECT_INTERNAL
// ============================================================
// Modules add new internal helpers here.
```

**Ordering rule:** the compile service splices fragments **alphabetically by module ID** within each marker. This makes composition deterministic — the same config hash always produces the same bytecode.

**Idempotency rule:** a module fragment can be included at most once per composition. The compile service rejects duplicate module IDs.

**Bailout rule:** if a module's fragment references another module's identifier (e.g. `FeeOnTransfer` reading `AntiBot`'s state), the composition is rejected unless `matrix.json` declares the dependency via `requires`.

---

## `ERC20Template.sol`

Base: OZ ERC-20 5.x with `_update` override consolidation. Uses Solady `Ownable`, `ReentrancyGuard`, `SafeTransferLib`. No permit by default (permit is a module).

**Base state (locked layout, slots 0..N-1):**
```solidity
// Slot 0-1: OpenZeppelin ERC20 balances + allowances (mappings — occupy one slot each)
// Slot 2: totalSupply (uint256)
// Slot 3: name (string, dynamic — one slot for length + pointer)
// Slot 4: symbol (string, dynamic)
// Slot 5: Solady Ownable owner (address, packed with anything Solady packs into that slot)
// Slot 6: initialized flag (uint8 packed if possible)
```

Exact layout is defined by OZ + Solady; VM does not reorder. Module state starts at the first free slot after base storage. Module storage uses `keccak256("vm.module.<moduleId>")` as a base pointer for `mapping`s to eliminate accidental collision risk — see SPEC-modules §Storage safety.

**Initialization:**
```solidity
function initialize(bytes calldata data) external initializer {
    (
        string memory name_,
        string memory symbol_,
        address owner_,
        bytes memory moduleData
    ) = abi.decode(data, (string, string, address, bytes));

    __ERC20_init(name_, symbol_);
    _initializeOwner(owner_);

    // ============================================================
    // VM_INJECT_INIT
    // ============================================================
    // Modules decode their portion of `moduleData` here and set state.
}
```

**Transfer hook signature (used by both `VM_INJECT_BEFORE_TRANSFER` and `_AFTER_TRANSFER`):**
```solidity
// address from, address to, uint256 amount
```

Called from a single overridden `_update(from, to, amount)` which is OZ 5.x's consolidation of transfer/mint/burn. Mint has `from = address(0)`; burn has `to = address(0)`. The mint/burn markers fire additionally for module authors who want mint- or burn-specific logic without discriminating on `from`/`to`.

**Ownership:**
- `_owner` set at `initialize` time to the factory (Router-controlled).
- Router calls `transferOwnership(target)` or `renounceOwnership()` immediately after `initialize` per user's `OwnershipMode`.

**Invariants (target invariant tests):**
1. `sum(balanceOf) == totalSupply()` at every observable state.
2. `_update(from, to, amount)` monotonicity: `balanceOf(from) - amount + balanceOf(to) + amount == pre-tx sum`. No wei created or destroyed except via `_mint`/`_burn` paths.
3. Mint changes total supply upward by exactly the minted amount. Burn changes it downward by exactly the burned amount.
4. Base storage slot 0..N-1 values are only mutated by base-defined functions and module hooks — never by module-declared external functions writing to arbitrary slots (invariant handler asserts by re-reading base state after every module-external call).
5. `owner()` matches the expected owner post-initialize + post-`transferOwnership`.

**Threat model additions beyond ETHSKILLS Security §1-9:**
- **Module fee-vs-supply reconciliation:** modules that take fees on transfer (e.g. FeeOnTransfer) must call `_update` with the reduced amount, not mutate `_balances[to]` directly. Enforced at review, tested by invariant 2.
- **Reentrancy through modules:** if a module's `_beforeTransfer` calls out (e.g. LayerZero OFT), the base's transfer state is already updated by then (OZ 5.x updates state pre-hook via `_update`). The compile-service test suite runs each module against a reentrancy fixture.

---

## `ERC721ATemplate.sol`

Base: Chiru Labs ERC721A 4.x (gas-optimized batch mints). Uses OZ `IERC721Receiver` for safe transfers.

**Base state:** ERC721A packs tokenId → address in a single storage slot per contiguous range. Detailed layout in ERC721A's `_packedOwnerships`. Modules must not touch these slots — they append storage at the free slot after ERC721A's declared state.

**Initialization:**
```solidity
function initialize(bytes calldata data) external initializer {
    (
        string memory name_,
        string memory symbol_,
        address owner_,
        string memory baseURI_,
        uint256 maxSupply_,
        bytes memory moduleData
    ) = abi.decode(data, (string, string, address, string, uint256, bytes));

    __ERC721A_init(name_, symbol_);
    _initializeOwner(owner_);
    _baseURIStored = baseURI_;
    _maxSupply = maxSupply_;

    // VM_INJECT_INIT
}
```

**Transfer hook signature:**
```solidity
// address from, address to, uint256 startTokenId, uint256 quantity
```

ERC721A batches — one hook call per mint batch, one per transfer of a token, one per burn.

**Base storage additions beyond ERC721A:**
- `_baseURIStored` (string) — overridable by the `OnChainSVG` module (which sets `_useOnChainSVG = true` and provides `_tokenURI(id)`).
- `_maxSupply` (uint256) — soft cap. Enforced in `_beforeMint` if the `MaxSupplyEnforced` module is present; base template only stores it.

**Invariants:**
1. `totalSupply() == mintedCount - burnedCount`.
2. `ownerOf(tokenId)` monotonic per tokenId once minted (until burned).
3. Base storage never mutated by modules' external functions.

---

## `ERC1155Template.sol`

Base: OZ ERC-1155 5.x.

**Initialization:**
```solidity
function initialize(bytes calldata data) external initializer {
    (
        string memory uri_,
        address owner_,
        bytes memory moduleData
    ) = abi.decode(data, (string, address, bytes));

    __ERC1155_init(uri_);
    _initializeOwner(owner_);

    // VM_INJECT_INIT
}
```

**Transfer hook signature:**
```solidity
// address operator, address from, address to, uint256[] memory ids, uint256[] memory values
```

Called from OZ's `_update` override (5.x consolidates single/batch paths through one hook).

**Invariants:**
1. Sum of balances per id equals total minted for that id minus total burned for that id.
2. Batch transfer atomicity: partial success is impossible — a batch either fully succeeds or fully reverts.

---

## Storage safety across all three templates

**Rule:** module storage variables declared inside `VM_INJECT_STATE` are placed after all base storage. Solidity's storage layout is deterministic based on declaration order, so as long as base variables appear before the injection marker (they do, by construction), module slots never collide with base slots.

**Rule:** module `mapping` variables should use a keccak-derived base pointer to further eliminate the risk of two modules choosing the same slot:

```solidity
// Instead of: mapping(address => uint256) public feeOnTransferAccrued;
// Use:
mapping(address => uint256) private feeOnTransferAccrued;
// And access via a wrapper that reads/writes at slot keccak256(bytes32(uint256(uint160(msg.sender))), bytes32("vm.mod.FeeOnTransfer.accrued"))
```

For MVP, plain module-scoped mappings are fine if each module namespaces its variable names (e.g. `_feeOnTransferAccrued` not `_accrued`). The compile service enforces name uniqueness at splice time by rejecting duplicate top-level identifiers.

---

## Ownership pattern (all templates)

- All templates inherit Solady `Ownable` at the same slot.
- Initial owner = the factory (deploys the clone or takes ownership post-initialize).
- Router calls `renounceOwnership` / `transferOwnership(target)` / `transferOwnership(launcher)` per user's `OwnershipMode`.
- Modules that need admin functions gate them with `onlyOwner`. If the user chose `Renounce`, those admin functions are permanently disabled — this is disclosed in the ownership-audit UI panel (VM-213).

---

## Reentrancy

- ERC-20 template's `_update` follows OZ 5.x's Checks-Effects pattern: state written before hook fires. Modules should still use `nonReentrant` when calling out externally.
- ERC-721A `_transfer`/`_mint`: state written before `_afterTokenTransfers`.
- ERC-1155 `_update`: same as ERC-20.
- Templates do not add reentrancy guards to the base transfer path — the module fragment adds `nonReentrant` on external functions it declares.

---

## Deploy / initialization flow

Templates are deployed once per (base, module-combo) as an **impl**. Factories clone the impl per launch via Solady `LibClone.clone` and call `initialize(data)` on the clone. See SPEC-factories for the impl registry.

**Constructor of the impl itself:** empty. All setup happens in `initialize` because clones don't run constructors. Solady's `_initializeOwner` and OpenIZ upgradeable-style `initializer` modifier are used to enforce single-shot initialization.

---

## Testing checklist (per template)

- Unit: initialize happy path, double-initialize reverts, invalid data reverts.
- Unit: base transfer / mint / burn cases without any modules injected — proves the base template compiles clean with empty markers.
- Fuzz: transfer amounts, batch sizes, edge cases (self-transfer, zero-amount, max supply boundary).
- Invariant: 1–5 (ERC-20) / 1–3 (ERC-721A) / 1–2 (ERC-1155) above.
- **Composition test:** for each supported module combination, the compile service produces a compiling contract and the merged test suite (base tests + each module's test fragment) passes.

**Coverage target:** >95% lines + branches on the base itself; ≥90% on the base + module compositions (composition combinatorics is bounded by the matrix — not every combo is enumerated).

---

## Open questions

- Should ERC-20's `permit` be baked into the base or ship as a module? Currently a module (`PermitModule`). Trade-off: baking simplifies the composition matrix but bloats every launched contract with permit code. Keeping as module wins on gas per launch.
- ERC-1155 URI setter: should the module `MetadataURI` gate this behind `onlyOwner`, or should the base always allow the initial URI to be updated once? Deferred — needs an ADR.
- ERC-721A max-supply enforcement: bake into base or ship as `MaxSupplyEnforcedModule`? Currently intended as a module, but every NFT collection wants this — probably belongs in the base. Deferred to VM-103 implementation.
