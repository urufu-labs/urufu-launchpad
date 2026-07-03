# SPEC — Compile Service

> The backend that turns a user's shop config into deployable bytecode. Reads `shared/matrix.json`, validates the composition, splices template + module fragments, invokes pinned Foundry, runs the merged test suite, caches by config hash, and registers new impls with the correct factory.

**Status:** ⚠️ PARTIAL. Splicer + matrix + CLI shipped and used ahead-of-time to generate the 33 curated composed impls (via `pnpm splice`). **Dynamic runtime splice-then-register from user config is deferred to Phase 6** (`URU-601`) — needs backend infra + a security review of the on-demand registration path.
**Files shipped:** `compile-service/src/{cli.ts, compile.ts, matrix.ts, types.ts}` — CLI-driven ahead-of-time splicing works today.
**Files stubbed:** `server.ts`, `test-runner.ts` — placeholders for the Phase 6 backend service.
**Fixtures:** `compile-service/fixtures/*.json` — one per curated impl. 33 total.
**Prior art:** Etherscan's Sourcify verification pipeline; Zora's on-chain templating.
**Notes:** Users can't compose arbitrary combos today — only combos matching one of the 33 pre-registered configHashes launch. Ephemeral splicer state is fine because the splicer only runs at build time (locally, when adding a new fixture).

---

## Purpose

Every VM launch depends on a compile call. The service:

1. Accepts a **config** describing base + mechanic + modules + params.
2. Validates the config against `shared/matrix.json` (compatibility, required modules, params-JSON-Schema).
3. Computes a **canonical config hash**. If the impl for that hash is already registered on-chain, returns cached artifacts and the impl address.
4. If not registered: splices template + fragments deterministically → invokes pinned Foundry to build → runs the merged test suite → if all green, deploys the impl on-chain and calls `factory.registerImpl(configHash, impl)`.
5. Returns bytecode, ABI, gas estimate, warnings, and the impl address.

The frontend uses the response to show:
- Live compile-status badge (green/yellow/red).
- Full test output on "Run Tests" click.
- Ownership audit (list of `onlyOwner` functions in the composition).
- Estimated deploy cost.

The service is stateless per-request; state lives in Postgres (cache) and on-chain (registry).

---

## Endpoints

### `POST /compile`
- **Auth:** SIWE-signed token in header (`X-VM-Auth`) OR API key for staff-only callers.
- **Rate limit:** 30 req/min per authenticated caller.
- **Body:**
  ```jsonc
  {
    "chain": "sepolia" | "mainnet" | "base" | "base-sepolia",
    "base": "ERC20" | "ERC721A" | "ERC1155",
    "mechanic": "bonding-curve" | "fixed-sale" | ...,
    "modules": ["FeeOnTransfer", "AntiBot", "Votes"],
    "params": { "FeeOnTransfer": { "feeBps": 500, ... }, "AntiBot": { ... } },
    "name": "Vending Machine Token",
    "ticker": "VMT"
  }
  ```
- **Response 200:**
  ```jsonc
  {
    "configHash": "0x...",
    "impl": "0x... | null",     // null = not yet registered on-chain
    "bytecode": "0x60...",       // creation bytecode of the impl
    "abi": [...],
    "gasEstimate": { "impl": 3200000, "clone": 55000 },
    "warnings": ["Pausable adds a censorship vector — displayed to user"],
    "ownershipAudit": [
        { "fn": "setFeeOnTransferExcluded(address,bool)", "reason": "excludes from fees" },
        { "fn": "pause()", "reason": "pauses all transfers" }
    ]
  }
  ```
- **Response 400:** matrix validation failure — includes JSON Schema errors keyed by module.
- **Response 422:** compile succeeded, tests failed. Response includes failing test names + stdout.
- **Response 500:** internal error (forge crash, cache DB down). Includes an incident ID for logging.
- **Response 501:** current skeleton stub.

### `POST /test`
- **Body:** same as `/compile`.
- **Response:** streams `text/event-stream` with per-line `forge test` output. Final event `{"type":"done","passed":true,"failed":0}`.

### `POST /register`
- **Auth:** service-only. Called internally after a successful `/compile` that triggers an impl deploy.
- **Effect:** signs and broadcasts `factory.registerImpl(configHash, impl)`. Not user-callable.

### `GET /health`
- **Response 200:** `{"status":"ok","forge":"0.2.0","solc":"0.8.26"}`.

---

## Canonical config hash

```
canonicalConfig = {
    chainId,
    base,
    mechanic,
    modules: sortedByModuleId(modules),
    params: modules.map(m => ({ id, version: matrix[m].version, params: canonicalize(params[m]) })),
}
configHash = keccak256(rlpEncode(canonicalConfig))
```

- **Sort modules alphabetically by ID** so `["A","B"]` and `["B","A"]` yield the same hash.
- **Canonicalize params:** sort object keys alphabetically, normalize address checksums, strip trailing zeros on integers.
- **Include module version** so a bump to a module fragment produces a distinct hash (and requires re-registration).
- **Include chainId** so different chains get different impls (rare — most impls are chain-agnostic, but some modules read `block.chainid`; safer to segregate).

Deterministic across languages: TypeScript computes the hash for the FE; the service recomputes and enforces equality. Any mismatch → 400.

---

## Matrix validation (`matrix.ts`)

Loads `shared/matrix.json` at boot and on SIGHUP (for hot-reload during dev). For each request:

```typescript
function validate(config: Config): Result {
  if (!matrix.bases.includes(config.base)) return err('UNKNOWN_BASE');
  if (!matrix.mechanics[config.base].includes(config.mechanic)) return err('UNKNOWN_MECHANIC');

  const missing = config.modules.filter(m => !matrix.modules[m]);
  if (missing.length) return err('UNKNOWN_MODULE', { missing });

  for (const m of config.modules) {
    const mod = matrix.modules[m];
    if (!mod.base.includes(config.base)) return err('MODULE_WRONG_BASE', { module: m });

    const missingReqs = mod.requires.filter(r => !config.modules.includes(r));
    if (missingReqs.length) return err('MODULE_MISSING_REQUIRES', { module: m, missing: missingReqs });

    const incompat = mod.incompatibleWith.filter(i => config.modules.includes(i));
    if (incompat.length) return err('MODULE_INCOMPATIBLE', { module: m, with: incompat });

    const paramResult = ajvValidate(mod.params, config.params[m]);
    if (!paramResult.valid) return err('MODULE_PARAMS_INVALID', { module: m, errors: paramResult.errors });
  }

  return ok();
}
```

Frontend runs the same validator client-side via a shared `shared/matrix-validator.ts` (compile-service exports the function). Server enforces authoritatively.

---

## Splicing algorithm (`compile.ts`)

1. **Load the base template** for `config.base` from `compile-service/templates/`. E.g. `ERC20Template.sol`.
2. **Load each module fragment** for the sorted module list from `compile-service/fragments/`.
3. **Parse each fragment** — extract header + section bodies keyed by `VM_INJECT_*` marker.
4. **For each marker in the template**, replace the marker (and its surrounding placeholder comments) with the concatenation of each module's section body, in alphabetical order, separated by a blank line.
5. **Header replacements:** substitute `{{NAME}}`, `{{SYMBOL}}` placeholders in the template with `keccak256`-derived unique identifiers so multiple impls compiled in the same forge invocation don't collide by contract name.
6. **Write the spliced file** to `compile-service/tmp/<configHash>/<Contract>.sol`.
7. **Copy `foundry.toml`, `remappings.txt`, `lib/`** into the tmp dir (or use `--out-dir` + `--config-path` flags to reuse the mono-repo's lib without copying).
8. **Invoke `forge build`** with `FOUNDRY_PROFILE=clone` (small optimizer runs for cloneable bytecode).
9. **Parse the ABI + bytecode** from `out/<Contract>.sol/<Contract>.json`.
10. **Run the merged test suite** — see below.
11. **On success:** deploy impl + register.

**Determinism:** the same input always produces the same spliced .sol file, same bytecode. Bytecode-hash is cross-verified against the on-chain impl's runtime code before returning to the FE.

**Sandbox:** forge invocations run in a container with no network egress and a bounded CPU/memory budget. Timeout: 60s for build, 90s for tests.

---

## Merged test suite (`test-runner.ts`)

For each module in the composition, its `.frag.t.sol` is loaded. Sections are merged into a single test contract using the same marker convention (`VM_TEST_INJECT_STATE`, `VM_TEST_INJECT_SETUP`, `VM_TEST_INJECT_TESTS`, `VM_TEST_INJECT_HANDLER`).

The merged file is written to `compile-service/tmp/<configHash>/test/Merged.t.sol`. `forge test` runs against it with the CI profile (10k fuzz runs) if the caller flagged `deepTest: true` in the request; otherwise the default local profile (1k fuzz runs).

Results are parsed from `forge test --json`. Any failure blocks impl registration and returns 422.

---

## Cache (`cache.ts`)

**Backing store:** Postgres table `impl_cache`.

```sql
create table impl_cache (
    config_hash bytea primary key,
    chain_id int not null,
    base text not null,
    modules text[] not null,
    params jsonb not null,
    bytecode text not null,        -- 0x-prefixed
    abi jsonb not null,
    impl_address bytea,             -- populated after on-chain registration
    gas_estimate_impl int,
    gas_estimate_clone int,
    warnings text[],
    ownership_audit jsonb,
    compiled_at timestamptz not null default now(),
    registered_at timestamptz
);
create index on impl_cache (chain_id, base);
```

**Semantics:**
- On `/compile`, look up by (chain_id, config_hash).
- If found and `impl_address` non-null: return cached response with `impl` populated.
- If found but `impl_address` null: prior request compiled but registration failed. Retry registration; return updated response.
- If not found: proceed to splice + build + test + register.

**Cache warming:** popular combos (single-module `FeeOnTransfer`, bare ERC-20, bare NFT with `OnChainSVG`) get pre-warmed by a cron in CI so first-user latency is bounded to registration only. In-memory LRU (100 entries) fronts the Postgres cache for hot reads.

---

## Impl deployment + registration (`registrar.ts`)

After a successful compile + test pass, the service:

1. Deploys the impl via `viem.walletClient.deployContract(bytecode)` from the registrar key.
2. Waits for confirmation (1 block on Sepolia, 3 blocks on mainnet).
3. Calls `factory.registerImpl(configHash, impl)` from the registrar key. Factory checks `msg.sender == registrar` and `impls[configHash] == address(0)` (per SPEC-factories).
4. Updates the cache row with `impl_address` and `registered_at`.
5. Emits a metric `impl.registered{base, moduleCount}` for dashboards.

**Registrar key management:** the private key lives in the service's secret store (e.g. Fly.io secrets, Doppler, or SOPS-encrypted `.env`). Never in plaintext env vars. Rotation via `factory.setRegistrar` (owner-only, multisig-controlled) when key material is compromised or rotated on schedule (recommended: annually).

**Failure modes:**
- Deploy fails (out of gas, nonce collision) → return 500 with retry-after header.
- Register fails (config already registered by a race) → cache the returned impl address from the existing registration. Response is still successful (impl found for hash).
- Register fails (unknown reason) → mark cache row `impl_address=null`, retry once. If still failing, return 500. Manual investigation.

---

## Auth model

- **User-facing calls (`/compile`, `/test`):** SIWE-signed token. Frontend produces a `signInWithEthereum` message + signature; service validates via `viem.verifyMessage`; extracts caller address; rate-limits per address.
- **Internal calls (`/register`):** never called externally. Uses in-process invocation.
- **Ops (`/health`):** public.

Session tokens expire after 1 hour. Refresh handled by re-SIWE.

---

## Error taxonomy

Every error response includes `{ code, message, details? }`:

| Code | HTTP | Meaning |
|---|---|---|
| `UNKNOWN_BASE` | 400 | `config.base` not in matrix |
| `UNKNOWN_MECHANIC` | 400 | mechanic not in matrix for base |
| `UNKNOWN_MODULE` | 400 | module ID not in matrix |
| `MODULE_WRONG_BASE` | 400 | module doesn't support this base |
| `MODULE_MISSING_REQUIRES` | 400 | required dep absent |
| `MODULE_INCOMPATIBLE` | 400 | incompatible modules selected |
| `MODULE_PARAMS_INVALID` | 400 | JSON Schema validation failed |
| `NAME_UNAVAILABLE` | 409 | live check against `NameRegistry.isNameAvailable` returned false |
| `COMPILE_FAILED` | 500 | forge build returned non-zero. Includes stdout tail. |
| `TESTS_FAILED` | 422 | tests ran but failed. Includes failing test names. |
| `TIMEOUT` | 504 | forge invocation exceeded budget |
| `REGISTRAR_UNAVAILABLE` | 503 | registrar key or RPC unavailable |
| `UNAUTHORIZED` | 401 | missing/invalid SIWE token |
| `RATE_LIMITED` | 429 | per-caller quota exceeded |
| `NOT_IMPLEMENTED` | 501 | current skeleton stub only |

Every error is logged with the config hash for correlation.

---

## Observability

- **Metrics** (pino → StatsD or Prometheus): `compile.duration`, `compile.cache_hit`, `test.duration`, `impl.registered`, per-error-code counters.
- **Traces:** each `/compile` call gets a `traceId` — logged on every downstream call including forge and viem.
- **Alerts:** register-fail > 5 in 10 min; test-fail > 20 in 10 min; deploy-fail rate > 5%.

---

## Threat surface

| Vector | Mitigation |
|---|---|
| Malicious fragment supplied via API | Fragments are **not user-supplied**. They ship in `compile-service/fragments/`. User config only selects module IDs — the actual Solidity text is version-controlled and audited. |
| Sandbox escape via forge | Container has no network egress, restricted filesystem, CPU/memory limits. Foundry runs from a pinned binary. |
| Registrar key theft | Rotate via `factory.setRegistrar`. Existing impls remain valid (immutable). Attacker with the key can only register malicious impls for NEW hashes. |
| Cache poisoning | Every read verifies bytecode-hash against on-chain impl code hash. Divergence → cache invalidation + re-register. |
| Race condition: two users compile same config simultaneously | Postgres `INSERT ... ON CONFLICT DO NOTHING` on cache write. On register race, second registration reverts on `Factory__AlreadyRegistered` — caught and treated as success (impl now exists). |
| Config hash collision | keccak256; not feasible in practice. |
| Long-running forge invocation used as DoS | 60s/90s timeouts; per-caller rate limits; concurrent-job cap per service instance. |
| SIWE token replay across services | Domain scoping on the SIWE message + nonce table. |

---

## Deploy / infra

- **Runtime:** Node 20 + Fastify + tsx.
- **Container:** built from `compile-service/Dockerfile` (bundles Foundry + Node).
- **Host:** Fly.io Machines or a single VPS for MVP. Postgres via Neon (or self-hosted RDS-alike). Redis for rate-limit / job queue in Phase 3.
- **Scaling:** stateless service; scale horizontally by adding containers. Each container runs its own forge; Postgres cache is shared.
- **Blue-green deploy:** two container groups, LB-flipped. Downtime target: zero.

---

## Testing checklist

- Unit: `matrix.validate` all error branches.
- Unit: canonical config hash — order-independent, param-canonical.
- Unit: splicer produces expected output for hand-written fixtures.
- Integration: end-to-end compile of a bare ERC-20 template.
- Integration: compile with 1 module (FeeOnTransfer).
- Integration: compile with 3 modules including one flagged.
- Integration: compile with an incompatible pair — 400.
- Integration: test-run for a composition — pass and fail cases.
- Integration: registration idempotence — call twice, second is graceful.
- Fork-test: on Sepolia, registrar key deploys real impl and registers with factory.
- Load: 10 concurrent compiles complete under 2 min each.

**Coverage target:** >90% on TS logic. Integration tests double as end-to-end coverage.

---

## Open questions

- Should the service accept a **dry-run mode** that compiles but skips test-run and registration? Useful for frontend live-previews before the user commits to a launch. Deferred to Phase 1 UX pass.
- Should the impl-deploy gas cost pass through to the user (only the first launcher of a new config pays)? Or is it eaten by the platform? Currently platform-eaten (cheaper UX, tiny cost). Reconsider if impl-deploy rate spikes.
- Should we support **cache export/import** so a fresh CI environment can seed common configs without re-compiling? Yes, likely — deferred to VM-175 when we containerize.
