# SPEC — Factories

> One factory per base type. Router → Factory → clone. Factories maintain a registry of per-config impls, deploy new impls when a config first appears, and produce cheap cloned launches thereafter. CREATE2 salt is msg.sender-mixed to prevent front-mining.

**Status:** ✅ IMPLEMENTED. Three factories shipping, one per base type. 33 curated impls registered by `DeployPhase1`.
**Files:** `contracts/src/factories/ERC20Factory.sol`, `ERC721AFactory.sol`, `ERC1155Factory.sol`
**Tests:** unit tests in `test/unit/*Factory.t.sol` + integration coverage via `PhaseCombos.t.sol` (every registered impl launched through Router).
**Notes since spec:** salt formula is `keccak256(launcher, name, ticker, chainid)`; impl registry is immutable-once-registered (no `unregisterImpl` — see SECURITY.md §what's out).

---

## Purpose

Each factory is the concrete deployer for one base type. Router calls `factory.deploy(params, launcher)` inside `Router.launch(...)`; the factory:

1. Validates the config against its supported base + the module compatibility matrix (defense-in-depth — Router already validated via compile service).
2. Looks up the impl for the config hash. If none registered, either reverts (compile-service pre-registration required) or deploys a fresh impl from calldata bytecode + registers it.
3. Clones the impl via `LibClone.cloneDeterministic` using a salt derived from `(launcher, name, ticker)`. Salt uniqueness prevents front-mining.
4. Calls `token.initialize(...)` on the clone with the user's launch params + module init data.
5. Returns the clone address to Router.

**Design decision — clones over bytecode:** Solady `LibClone` produces EIP-1167 minimal proxies (~50 bytes). Each launch is a cheap clone (~50k gas). The full compiled bytecode lives once per config as the impl. Verification on Etherscan uses "Similar Match" — the clone points to a verified impl.

**Alternative rejected:** deploying full bytecode per launch (Path A from HANDOFF §compile approach) costs ~2M gas per deploy and eliminates the pre-registration handshake. Chosen path is Path B (clones from pre-registered impls).

**Note:** each impl is still uniquely audited as-is; the clone's `code` is standardized proxy bytes, and the impl behind it is a verifiable single-file contract per SPEC-templates. Etherscan's "Contract Creation Code" view resolves the clone's target and marks the impl as the source of truth.

---

## Interface (per factory)

```solidity
interface IVMFactory {
    struct DeployParams {
        string name;
        string ticker;
        bytes32 configHash;      // compile-service-signed hash of the full config
        bytes initData;          // ABI-encoded per SPEC-templates initialize signatures
    }

    function deploy(DeployParams calldata p, address launcher)
        external
        returns (address token);

    function registerImpl(bytes32 configHash, address impl) external;   // onlyRegistrar
    function implFor(bytes32 configHash) external view returns (address);

    event Deployed(
        address indexed token,
        address indexed launcher,
        bytes32 indexed configHash,
        address impl,
        string name,
        string ticker
    );
    event ImplRegistered(bytes32 indexed configHash, address indexed impl, address indexed registrar);
}
```

Router is the only address permitted to call `deploy`. The compile service (via a `registrar` role) is the only address permitted to call `registerImpl`.

---

## State

| Variable | Type | Purpose |
|---|---|---|
| `router` | `address` (immutable) | Only address permitted to `deploy`. |
| `registrar` | `address` | Only address permitted to `registerImpl`. Owned by compile-service backend key. |
| `impls` | `mapping(bytes32 configHash => address impl)` | The registry. Populated by `registerImpl`. |
| `usageCount` | `mapping(bytes32 configHash => uint256)` | How many clones exist. Read-only stat for the frontend. |
| `_owner` | Solady Ownable | Admin — can rotate `registrar`, `router` (with a caveat below). |

`router` is immutable — a v2 factory redeploys if Router changes. `registrar` is mutable to allow key rotation.

---

## CREATE2 salt policy

**Salt:** `salt = keccak256(abi.encode(launcher, keccak256(bytes(name)), keccak256(bytes(ticker)), block.chainid))`.

**Why:** including `launcher` in the salt makes the deterministic CREATE2 address unique per (launcher, name, ticker, chain). An external griefer scanning mempool cannot pre-deploy at the same address because their `msg.sender` is different — their salt is different — their address is different. Front-mining is defeated at the salt-derivation level.

**Why chainid:** deploys reusing the same salt on a different chain need to land at a different address (otherwise cross-chain replay of a deploy could hijack an unrelated address). `block.chainid` is a cheap and correct guard.

**Note on the CREATE2 address collision attack (EIP-3298 / SWC-124):** the salt scheme doesn't fully mitigate SELF-collisions — if a launcher deploys the same (name, ticker) twice on the same chain, the second attempt lands at the same address and reverts on the second CREATE2. That's fine: the registry rejects the second reservation first, so we never reach the second CREATE2.

---

## `deploy` flow (unit specification)

```solidity
function deploy(DeployParams calldata p, address launcher)
    external
    returns (address token)
{
    if (msg.sender != router) revert Factory__NotRouter();
    address impl = impls[p.configHash];
    if (impl == address(0)) revert Factory__UnknownConfig(p.configHash);

    bytes32 salt = keccak256(
        abi.encode(launcher, keccak256(bytes(p.name)), keccak256(bytes(p.ticker)), block.chainid)
    );

    token = LibClone.cloneDeterministic(impl, salt);

    // Delegate initialize() to the base template. Template asserts single-init.
    // The initData is ABI-encoded per SPEC-templates initialize signature.
    (bool ok, ) = token.call(abi.encodeWithSignature("initialize(bytes)", p.initData));
    if (!ok) revert Factory__InitFailed();

    // Owner defaults to Router (set inside initialize); Router transfers to launcher/multisig/renounce.
    unchecked { usageCount[p.configHash] += 1; }
    emit Deployed(token, launcher, p.configHash, impl, p.name, p.ticker);
}
```

CEI order: read impl → derive salt → clone (no external call yet) → initialize (external call) → emit. Reentrancy through initialize is bounded by the template's `initializer` modifier — a second call to `initialize` would revert.

---

## `registerImpl`

```solidity
function registerImpl(bytes32 configHash, address impl) external {
    if (msg.sender != registrar) revert Factory__NotRegistrar();
    if (impls[configHash] != address(0)) revert Factory__AlreadyRegistered();
    if (impl == address(0)) revert Factory__ZeroAddress();
    if (impl.code.length == 0) revert Factory__NotAContract();

    impls[configHash] = impl;
    emit ImplRegistered(configHash, impl, msg.sender);
}
```

**Immutable-once-registered:** once a config hash points to an impl, it can never be changed. If an impl is buggy, a new config hash (with a bumped module version) supersedes it — never overwrites.

**Backwards-compatible fixes:** a security fix to a base template or module bumps the version → new config hash → new impl. Existing clones continue running the old (potentially buggy) impl. This is a **feature** — clones are immutable per user's ownership choice. If the user chose Renounce, no admin can push a fix, and that's the trust guarantee the user opted into. If the user kept ownership, the token contract has no upgrade path anyway; a fix requires migrating to a new token.

---

## Admin functions

| Function | Access | Effect |
|---|---|---|
| `setRegistrar(address)` | `onlyOwner` | Rotates the registrar key. Emits `RegistrarSet`. |
| `setRouter(address)` | `onlyOwner` | Rotates the Router. **Discouraged** — Router changes should redeploy the factory. Emits `RouterSet`. Timelock recommended. |
| `transferOwnership(address)` | `onlyOwner` | Solady Ownable two-step. |

Router immutability is nearly-immutable — the setter exists as an emergency lever (e.g. if Router has a bug and needs to redeploy while preserving the impl registry). In practice, factory + router redeploy together.

---

## Access control table

| Function | Access |
|---|---|
| `deploy` | `onlyRouter` |
| `registerImpl` | `onlyRegistrar` |
| `implFor`, `usageCount`, `router`, `registrar`, `owner` | public `view` |
| `setRegistrar`, `setRouter`, `transferOwnership` | `onlyOwner` |

---

## Invariants (target invariant tests)

1. **Config-immutability:** for any `configHash`, `impls[configHash]` is either `address(0)` or a stable non-zero address. Never mutates.
2. **Router exclusivity:** `Deployed` is only emitted in txs where `msg.sender == router`.
3. **Registrar exclusivity:** `ImplRegistered` is only emitted in txs where `msg.sender == registrar`.
4. **Clone address determinism:** for any pair `(launcher, name, ticker, chainId, configHash)`, `deploy` (if it succeeds) always yields the same clone address. Two calls with the same tuple on the same chain revert on the second (CREATE2 collision).
5. **Owner-invariance:** `owner()` never changes except via `transferOwnership` calls with `msg.sender == owner()`.
6. **UsageCount monotonic:** `usageCount[configHash]` is non-decreasing.

---

## Threat surface

Per ETHSKILLS Security §Access control, §Input validation, §Delegatecall (impl clones use minimal proxy delegatecall — see below).

| Vector | Mitigation |
|---|---|
| Delegatecall through clone | EIP-1167 minimal proxy delegatecalls the impl. Impl is trusted (only registrar can register; registrar is compile-service backend). Storage layouts of clone and impl match by construction (clone has no storage of its own beyond what the impl declares). |
| Registrar compromise | Attacker can register malicious impls. Would only affect NEW config hashes (invariant 1 protects existing impls). Owner can rotate `registrar`. Recommend registrar key be an HSM or multisig-controlled operational key. |
| Router compromise | Attacker can trigger `deploy` with arbitrary params, but every deploy has an atomic `NameRegistry.reserve` in the enclosing Router tx — a compromised Router would need to bypass registry too. Owner can rotate `router` (nearly-immutable). |
| Front-mining CREATE2 | Salt includes `launcher` and `chainid`. Attacker can't produce the same salt. |
| Unknown config hash | `deploy` reverts `Factory__UnknownConfig`. Router surfaces this to the frontend as "unknown config — trigger a rebuild." |
| Initialize failure | Reverts the whole `deploy` tx; nothing is left in a partial state. `usageCount` doesn't increment on revert. |
| Impl with backdoor state | Impl is audited before registration. Compile service runs `forge test` on the merged composition BEFORE registering — a failing test blocks registration. |
| Reentrancy via initialize | Template's `initializer` modifier prevents re-entry into initialize. `usageCount` increment is unchecked and after the external call — an intermediate revert reverts the whole tx. |

---

## Deploy sequence

Per base type, the factory deploys once. Post-deploy:
1. Owner sets `registrar` to the compile-service backend key.
2. Router (already deployed) sets this factory via `router.setFactory(base, factoryAddr)`.
3. Owner transfers factory ownership to the multisig.
4. Verify on Etherscan.
5. Compile service begins registering impls on first launch per config.

**No initial impls at deploy.** The impl registry populates lazily — first launch of a given config triggers the compile service to deploy the impl (owner-funded gas) then register it, then Router's `launch` proceeds. See SPEC-compile-service for the choreography.

---

## Testing checklist

- Unit: `deploy` happy path, unregistered-config revert, wrong-caller revert, init-failure revert.
- Unit: `registerImpl` happy path, duplicate-config revert, zero-address revert, wrong-registrar revert.
- Fuzz: CREATE2 address determinism — for random `(launcher, name, ticker)` tuples, the returned clone address matches the pre-computed address via `LibClone.predictDeterministicAddress`.
- Integration: full Router → Factory → clone → initialize → NameRegistry.reserve flow.
- Integration: launch two tokens with same `(name, ticker)` from same launcher on same chain — second reverts (registry rejects first; salt collision if registry disagrees).
- Invariant: 1–6 above via handler harness.

**Coverage target:** >95% lines + branches per factory.

---

## Open questions

- Should factories charge their own additional fee (a small percentage of Router fee)? Currently no — Router is the sole fee point. Deferred.
- Should `deploy` accept a per-launch `salt_nonce` param so a launcher can retry after a partial revert without changing (name, ticker)? Not needed — retries hit the same registry rejection, so the launcher just picks a new name.
- Should there be a `predictAddress(launcher, name, ticker, configHash)` view helper for the frontend? Yes — add it. Trivial view, unblocks a nice UX ("your token will deploy at 0x..." preview).
