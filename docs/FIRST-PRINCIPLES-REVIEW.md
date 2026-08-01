# First-Principles Product and Architecture Review

This review asks a blunt question:

> If we were designing urufu-launchpad today, knowing the current code and live
> Robinhood deployment scars, would we still choose this architecture?

Short answer: no, not as-is.

There is a good product here, but it is trapped inside several accumulated
product versions. The right move is not to keep patching every evolved surface.
The right move is to choose a smaller v1, protect the pieces that make it
special, and delete or quarantine the rest until it has earned its way back.

## Direct Verdict

Do not ship the current product as-is.

Do not treat this as "minor fixes and launch" either. The codebase has too many
pre-launch public surfaces, old deployment scars, future-product stubs, and
duplicated safety boundaries. A few bugs can be fixed quickly, but the deeper
issue is product boundary confusion.

The product that does make sense:

> Robinhood-chain ERC-20 launchpad with one-click bonding-curve launch, locked
> Uniswap v4 graduation, and useful v4 hook options that help deployers protect
> and monetize launches.

That product is coherent and differentiated. It gives deployers a simple
anti-rug launch path, gives them post-graduation hook capabilities most
launchpads do not expose, and can later route platform economics into the urufu
ecosystem.

The product that does not yet make sense:

> Multi-chain, multi-base, arbitrary composable token factory with ERC-20,
> ERC-721A, ERC-1155, many mechanics, runtime compile/register, ETH or URU
> payment, whitelists, social profiles, chat, rewards, recovery, and several
> hook generations.

That larger product might exist later. It should not define v1 architecture.

## First Principles

### What job is the product doing?

For deployers:

- "Let me launch a token quickly without accidentally building a rug."
- "Give me defaults I can explain to my community."
- "Let me choose one or two meaningful launch knobs, not twenty protocol
  options."

For traders:

- "Show me new launches worth paying attention to."
- "Let me understand the curve, fees, liquidity lock, and graduation state."
- "Do not make me guess whether I am trading a test token, orphan, or broken
  migration artifact."

For the platform:

- "Own a differentiated v4 hook launch primitive, not just another token
  deployer."
- "Keep the protocol surface small enough to audit and operate."
- "Make every event and UI claim factual."
- "Optionally route fees into URU / gemu once the core launch product is solid."

If a feature does not serve one of those jobs, it is probably not v1.

### What should v1 be?

V1 should be:

- Robinhood only.
- ERC-20 only.
- Bonding curve only.
- One public launch path.
- One current curve factory / graduator / hook stack.
- A small, understandable set of v4 hook protections, especially anti-sniping.
- ETH launch fees first.
- URU pay only if contract-enforced pricing is fixed.
- Whitelist only if it stays mechanically simple and durable.
- URU / gemu flywheel as optional platform economics, not the main user draw.
- No runtime arbitrary compile/register.
- No NFT / 1155 UI.
- No direct/no-sale/fixed-sale/LBP mechanics.
- No governance flags unless governance actually exists.

Everything else should be moved out of the public path.

## Feature Triage

| Feature                      | Keep for v1?      | Honest question                                                       | Recommendation                                                               |
| ---------------------------- | ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Robinhood-only chain         | Yes               | Is the product tied to URU / gemu?                                    | Keep. This gives focus.                                                      |
| ERC-20 base                  | Yes               | Is this the only base the curve/trader loop needs?                    | Keep. Make it the only visible v1 base.                                      |
| Bonding curve launch         | Yes               | Is this the core deployer/trader mechanic?                            | Keep. Simplify around it.                                                    |
| Uniswap v4 graduation        | Yes, core         | Is v4 integration the actual market differentiator?                   | Keep. Make it the center of v1, with mandatory wiring checks.                |
| MultiHookHost                | Yes, core         | Can one hook host carry lock, fees, anti-sniping, and burn sanely?    | Keep as the single v1 hook surface. Remove legacy hook choices.              |
| Anti-sniping hook options    | Yes, scoped       | Can deployers choose protection without unsafe complexity?            | Keep a small preset set: off, standard, strict. Avoid arbitrary knobs first. |
| URU / gemu fee flywheel      | Later / optional  | Is this the draw for deployers, or platform economics?                | Phase in after v4 launch mechanics are clean. Do not lead positioning.       |
| URU launch payment           | Not until fixed   | Can the contract enforce price without trusting the frontend?         | Hide or disable until on-chain minimum/quote enforcement is real.            |
| Loyalty discounts            | Not until wired   | Is the live Router configured with an oracle?                         | Hide until `loyaltyOracle` is nonzero and tested live.                       |
| Whitelist launch             | Maybe             | Does this drive community launches, or just add launch failure modes? | Keep only after persistence/proof UX is durable. Otherwise defer.            |
| ERC-721A                     | No                | Does it participate in curve/graduation/flywheel v1?                  | Defer. Keep contracts, remove public promise.                                |
| ERC-1155                     | No                | Is multi-item commerce part of the launchpad v1?                      | Defer.                                                                       |
| Direct/no-sale launch        | No                | Does it help the anti-rug curve product?                              | Remove from v1 docs/UI.                                                      |
| Fixed sale / LBP             | No                | Are these implemented and core?                                       | Remove from v1 matrix story.                                                 |
| Runtime compile/register     | No                | Is this safe enough to be public infrastructure?                      | Quarantine as offline tooling.                                               |
| Many ERC-20 modules          | Not all           | Do launchers need all of them on day one?                             | Cut to a small preset set.                                                   |
| Owner-controlled modules     | Mostly no         | If curve launches renounce ownership, do owner functions matter?      | Remove from v1 curve path or make direct launches a separate later product.  |
| Social profiles/follows/chat | Maybe later       | Does this make launches better, or distract from launch/trade trust?  | Quarantine behind a product flag.                                            |
| Recovery/orphans             | Yes, support-only | Do existing users need protection?                                    | Keep, but treat as support tooling, not product architecture.                |
| Hidden token source list     | No as code        | Should production code contain migration hide-lists?                  | Move to indexer/admin data.                                                  |

## Architecture Smells

### 1. Two routers before public launch

Files:

- `contracts/src/router/Router.sol`
- `contracts/src/router/RouterV2.sol`
- `contracts/script/DeployRouterV2.s.sol`
- `contracts/script/RedeployRouterV6.s.sol`
- `tools/sync-addresses.mjs`

`Router` and `RouterV2` exist because the product evolved. `Router` is the
original ETH launch orchestrator. `RouterV2` adds URU payment and whitelist
launches by inheriting the original Router and duplicating large parts of the
launch sequence.

That is understandable history, but bad pre-launch architecture. Every launch
safety rule now has to be remembered in multiple public functions:

- `launch`
- `launchWithURU`
- `launchWithWhitelist`
- `launchWithURUAndWhitelist`

The code already shows this scar: comments in `RouterV2` explain that curve
incompatibility checks had to be mirrored because they were missing from the
URU paths.

Question:

> If no public user depends on `Router`, why are we preserving an old launch
> surface instead of designing one clean public launchpad contract?

Recommendation:

Replace the v1 public surface with one launch router. Internally split payment
validation from launch execution:

```text
launch(request, payment)
  validate request
  validate payment
  deploy token
  reserve name
  create curve
  configure whitelist if present
  dispatch ownership
  emit factual events
```

ETH and URU should be payment modes, not separate duplicated launch functions.

### 2. Live product config is an archeology layer

Files:

- `tools/sync-addresses.mjs`
- `web/src/lib/config.ts`
- `contracts/script/*V*.s.sol`

`sync-addresses.mjs` layers deployment books for phase 1, hooks, graduator,
flywheel, RouterV2, CurveFactoryV2, V3 stack, V4 stack, and Router V6. The
frontend config comments preserve V7/V8/V9 incident history in live app code.

Some of this history matters, but all of it being first-class current config is
a smell. It makes it hard to answer: "what is the current production stack?"

Question:

> Which stack is canonical, and why does product code need to know the ancestry?

Recommendation:

Create one canonical deployment manifest per chain:

```json
{
  "chain": "robinhood",
  "productVersion": "v1",
  "router": "...",
  "curveFactory": "...",
  "graduator": "...",
  "multiHookHost": "...",
  "feeSplitter": "...",
  "status": "current"
}
```

Move old stack books and migration scripts into `contracts/archive/` or
`docs/operations/history/`. Keep active scripts boring and current.

### 3. Product matrix describes a bigger product than the app ships

Files:

- `shared/matrix.json`
- `web/src/lib/modules.ts`
- `web/src/app/create/page.tsx`
- `docs/SPEC-compile-service.md`

The matrix lists 3 bases and many mechanics:

- ERC-20: bonding curve, fixed sale, LBP, direct-to-LP, no-sale
- ERC-721A: fixed mint, allowlist mint, dutch auction, free mint, curve mint
- ERC-1155: fixed mint, allowlist mint, free mint

The actual create page gates NFT / 1155 bases off and uses bonding curves for
ERC-20 launches. The compile service only has an ERC-20 default template.

Question:

> Is the matrix a v1 product contract, or a wishlist?

Recommendation:

Create a v1 matrix that contains only launchable public options. Move future
mechanics into a roadmap file. The frontend should not import future product
shape as if it were active configuration.

### 4. Runtime compile/register is not the current trust model

Files:

- `compile-service/src/server.ts`
- `compile-service/src/compile.ts`
- `docs/SPEC-compile-service.md`

The service can splice Solidity and run `forge build`, but the current product
mostly relies on curated pre-registered config hashes. The docs still describe
dynamic compile-test-register as if it is the intended launch choreography.

Public runtime Solidity composition is a major security boundary. It should not
be casually adjacent to profile updates, chat, Pinata proxying, rewards, and
keepers in one service.

Question:

> Do we actually need arbitrary composition for v1, or do we need a small set of
> audited presets?

Recommendation:

For v1, delete runtime compile from the public product path. Keep composition as
an offline developer tool. If runtime compile returns later, give it its own
service, queue, cache, allowlist, deployment key policy, and audit.

### 5. Backend process mixes unrelated trust boundaries

Files:

- `compile-service/src/server.ts`
- `compile-service/src/routes/social.ts`
- `compile-service/src/routes/whitelist.ts`
- `compile-service/src/routes/pin.ts`
- `compile-service/src/keeper.ts`

One Fastify app currently covers:

- compile and test endpoints;
- token metadata;
- user profiles;
- token chat;
- follows;
- Pinata upload proxy;
- whitelist holder snapshots;
- rewards routes;
- keeper loops that send transactions.

This is convenient, but it is not a clean trust model. A public UGC/chat service
and a private keeper service should not feel like the same unit of architecture.

Question:

> Which endpoints are product API, which are operator jobs, and which are
> developer tooling?

Recommendation:

Split into three conceptual services even if they still deploy together at
first:

- `public-api`: metadata, profile, chat, follows, rewards reads.
- `operator-worker`: keeper loops, reward publishing, fee sweeps.
- `compile-worker`: offline or authenticated composition/build pipeline.

### 6. Frontend pages are orchestration monoliths

Files:

- `web/src/app/create/page.tsx`
- `web/src/app/trade/[address]/page.tsx`
- `web/src/app/profile/[address]/page.tsx`

The biggest pages are very large:

- create page: over 2,000 lines;
- trade detail page: over 2,000 lines;
- profile page: over 1,000 lines.

These files mix UI copy, wallet state, quote reads, launch params, transaction
execution, backend persistence, contract warnings, and success parsing.

Question:

> Could a future engineer change pricing, ownership, or whitelist behavior
> without reading a whole page component?

Recommendation:

Split by responsibility:

- `useLaunchDraft`
- `useLaunchQuote`
- `useLaunchWrite`
- `useWhitelistDraft`
- `LaunchFeeSummary`
- `LaunchRiskDisclosure`
- `CurveMechanicPicker`
- `TokenIdentityForm`

Do not add new user-facing features until these surfaces are small enough to
reason about.

### 7. Recovery and hidden-token logic proves previous design leaked into UX

Files:

- `web/src/lib/orphanCurves.ts`
- `web/src/lib/hiddenTokens.ts`
- `web/src/app/recover/page.tsx`

The recovery path is humane and should stay until affected users are safe. But
hardcoded orphan curves and hidden test tokens in source code are a smell for a
live product.

Question:

> Are we building product, or shipping a local incident ledger inside the app?

Recommendation:

Keep `/recover`, but move orphan and hidden-token state to indexer/admin data.
The app should fetch current recovery records, not embed a dated snapshot.

### 8. Events can encode claims instead of facts

Files:

- `contracts/src/router/Router.sol`
- `contracts/src/types/VMTypes.sol`
- `indexer/src/index.ts`

`installHook` and `installGovernance` are user-supplied launch params that flow
into the `Launched` event. They are not proof that hook or governance contracts
were installed by the Router. The official UI currently sends them false, but
the contract surface still allows misleading event data.

Question:

> Should an indexed launch row represent what happened, or what a caller asked
> to happen?

Recommendation:

Remove the flags from v1, or emit separate factual events only when concrete
installation happens.

### 9. Docs are confident but often stale

Files:

- `README.md`
- `.github/SECURITY.md`
- `docs/HANDOFF.md`
- `docs/TODO.md`
- `docs/SPEC-*.md`

The docs preserve many eras of the product: "nothing has been coded," phase 1
Sepolia plans, old test counts, dynamic compile/register claims, and
broadcast-ready claims. This is classic AI-assisted repo drift: lots of polished
language, weak current truth.

Question:

> Which docs should a new contributor trust?

Recommendation:

Mark docs as one of:

- `current`
- `historical`
- `proposal`
- `archived`

Then make README only describe the current v1 product and link to archived
history explicitly.

### 10. Generated composed templates create huge maintenance drag

Files:

- `contracts/src/templates/composed/*`
- `contracts/modules/*`
- `compile-service/src/compile.ts`

Checking in generated composed contracts can be defensible for auditability. But
the current repo has many generated combinations across token, NFT, allocation,
and 1155 surfaces while v1 only needs a small subset.

Question:

> Are generated combinations audited release artifacts, or are they build
> byproducts?

Recommendation:

For v1, keep only the release preset artifacts that can actually be launched.
Move other generated combinations out of the active contract surface or mark
them as fixtures/test artifacts.

## Vibecode / AI-Slop Smell Inventory

These are not moral judgments. They are signals that the system was assembled
through momentum instead of deliberate simplification.

1. **Version-number archaeology in names.**
   `RouterV2`, `GraduatorV2`, `DeployV6AuditFixStack`,
   `DeployV9StackFix`, V8 comments, V7 warnings. This is history leaking into
   architecture.

2. **Future features in active config.**
   The matrix includes mechanics and bases the product does not expose.
   `modules.ts` includes planned compliance modules and NFT/1155 modules while
   v1 is an ERC-20 curve app.

3. **Huge page components.**
   Large React files become places where every new idea can land. That is how
   product ambiguity turns into code ambiguity.

4. **Polished docs with low freshness.**
   Many docs sound authoritative while contradicting live code.

5. **Comments that explain scars instead of boundaries.**
   Some comments are valuable, but many explain why a workaround exists after a
   previous broken deployment. That belongs in an incident log, not primary
   product code.

6. **Multiple truth sources.**
   README, specs, matrix, frontend constants, deployment books, live chain
   state, and hidden-token lists each tell a slightly different story.

7. **Feature flags as product crutches.**
   `LAUNCHPAD_LIVE`, disabled NFT bases, mock feeds, hidden tokens, orphan
   recovery, and coming-soon chains are all individually reasonable. Together
   they show the app has more surface than it can currently stand behind.

8. **Security-sensitive logic pushed to frontend convention.**
   URU payment pricing is the clearest example. If the contract needs a price,
   the contract should enforce a price.

9. **Public functions that exist because they were easy to keep.**
   Direct curve creation, old router paths, and legacy event fields may be
   useful internally, but public protocol surface should be aggressively small.

10. **One service doing five jobs.**
    Compile, social, uploads, rewards, whitelist, and keeper loops all in the
    compile service is a classic "ship the idea quickly" shape. Good for a
    prototype. Risky as architecture.

## Recommended Target Architecture

### Contracts

Use one public v1 launch contract:

```solidity
contract Launchpad {
  function launchERC20Curve(
    LaunchRequest calldata request,
    Payment calldata payment
  ) external payable returns (address token, address curve);
}
```

Internals:

```text
PaymentValidator
ConfigRegistry
TokenDeployer
CurveInstaller
WhitelistInstaller
HookPolicy
AntiSniperPolicy
OwnershipPolicy
EventEmitter
```

Design rules:

- no duplicated launch sequence;
- no user-supplied event claims;
- no public curve creation unless explicitly productized;
- no config-hash mutation without versioning;
- no URU payment without contract-side price enforcement;
- v4 hook behavior described as product capability, not hidden deployment
  trivia;
- no hidden v2/v6/v9 concepts in public names.

### Web

Make the app reflect one v1 product:

```text
/create
  ERC-20 curve launch only
  ETH pay only until URU is safe
  small anti-sniping preset picker
  optional whitelist only if durable
  plain v4 hook explanation
  simple fee and risk copy

/discover
  live launches only on live chains
  no mock fallback on Robinhood production

/trade/[address]
  curve state
  buy/sell
  graduation state
  post-graduation v4 swap and hook fee/protection state

/recover
  support-only recovery records from API/indexer
```

Design rules:

- one launch mode first;
- v4 hook capability visible and legible;
- critical copy in plain language;
- read fee/hook parameters from chain where possible;
- no planned modules in active UI config;
- large pages split before adding features.

### Backend

Separate the trust boundaries:

```text
public-api
  metadata
  profiles
  chat/follows if kept
  rewards reads

operator-worker
  keeper loops
  reward epochs
  fee sweeps

compile-worker
  offline/admin-only composition
  no public arbitrary register path in v1
```

### Indexer

Make indexed data factual and operationally clean:

- derive installed features from actual events;
- move hidden tokens and recovery records into indexed/admin data;
- separate test deployments from public discovery;
- make launch rows answer "what happened?" not "which flag was requested?"

## Questions Before Supporting Each Feature

Ask these before any feature stays in v1:

1. Does this feature help the first public user launch or trade better?
2. Can we explain it in one sentence without protocol jargon?
3. Does the contract enforce its critical invariants, or does the frontend
   merely suggest them?
4. Can it fail without stranding user funds?
5. Can the indexer represent it as factual state?
6. Can support debug it from one canonical manifest?
7. Is there a focused test that proves the full lifecycle?
8. Would deleting it make the product clearer?

If the answer to 8 is yes, delete or defer it.

## First Simplification Plan

### Phase 0: Stop adding surface

- Freeze new feature work.
- Declare v1 as Robinhood ERC-20 curve launch.
- Mark all non-v1 docs as historical/proposal.
- Hide or remove non-v1 UI options.

### Phase 1: Fix launch-critical risk

- Fix or disable URU pay.
- Decide whether there is one Router or a redesigned v1 Launchpad.
- Remove duplicated launch paths.
- Make production web builds independent of Google font downloads.
- Add live wiring checks as a release gate.

### Phase 2: Collapse product truth

- Replace layered deployment-book precedence with one canonical manifest.
- Move old scripts to operations history.
- Move hidden tokens and orphan records out of source constants.
- Update README to describe only the current product.

### Phase 3: Shrink the app

- Split create/trade/profile pages by responsibility.
- Remove planned modules from active config.
- Reduce ERC-20 modules to a small launch preset menu, but keep a
  deliberately-scoped anti-sniping lane.
- Rewrite financial copy in plain language.

### Phase 4: Decide future lanes

Only after v1 is clean, decide separately whether to bring back:

- URU pay;
- the URU / gemu fee flywheel as a user-facing value prop;
- whitelists beyond the simplest durable community-protection version;
- NFT / 1155 bases;
- runtime compile/register;
- social profiles/chat/follows;
- compliance modules;
- multiple chains.

Each return should require a short design note, lifecycle test, and a clear
answer to "why does v1 need this now?"

## Bottom Line

The current repo is not hopeless. It is overgrown.

The core worth preserving is the ERC-20 curve launch -> v4 locked graduation ->
deployer-selectable hook protections loop. That is the spine.

The URU/gemu flywheel can still be valuable, but it is platform economics. The
market-facing draw is the v4 integration: locked liquidity, creator/platform fee
routing, and anti-sniping protection that other launchpads do not make simple.

Everything else should be treated as suspect until it proves it belongs on that
spine. Simplicity is not aesthetic here; it is the security model.
