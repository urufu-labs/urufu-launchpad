# SPEC — DN404 Transfer Hooks + Tax Destinations + Stock-Pair Launches

> **Status:** 🟡 DRAFT — scope + architecture only. No code yet.
> _last updated: 2026-09-03_ (rev 2: SPEC Q answers + pair-currency scope)
> **Depends on:** the base DN404 lane (`SPEC-dn404-launchpad.md`,
> already shipped through slice 9d on branch `dn404-lane`).
> **Blast radius:** additive — a new mixin on the base template and a
> new owner-managed allowlist. Existing DN404 launches without hooks
> are unchanged.

## Why

Two facts, taken together, open a design lane nobody has walked yet:

1. **DN404's paired structure**: every whole-unit ERC-20 balance
   transition mints/burns a mirror NFT. There's a natural feedback
   loop between the two sides that no plain ERC-20 and no plain NFT
   has access to.
2. **Robinhood Chain's live tokenized-stock registry**: real,
   regulator-compliant stock tokens are already on-chain (see
   `https://docs.robinhood.com/chain/contracts` — canonical registry
   with USDG as settlement, WETH, and a live table of per-underlying
   stock tokens). Some launches are already LP-pairing memecoins
   against these stock tokens as a pair currency.

The composition — DN404 launches that route a per-trade transfer
tax into (a) their own paired NFT floor, or (b) an allowlisted
external asset like a RH stock token, or (c) a launcher-picked
ecosystem token — is the new primitive. None of it requires us to
become a broker-dealer or to build any legal infrastructure; the
RH-issued stock tokens carry that on their side.

## Scope

**In scope:** a `Dn404TaxHook` mixin on the base template plus an
owner-managed allowlist of tax destinations.

**Out of scope (documented as considered, not shipping):**

- Cross-chain tax destinations (needs bridging infrastructure we
  don't have).
- Dynamic tax curves (fee that varies with sell velocity, mev,
  etc.) — adds too much surface for v1.
- On-chain NFT-floor buys from marketplaces (unsafe from a transfer
  hook — see "NFT floor support" below for the keeper pattern).
- "Stock-backed" DN404 where the mirror NFT is a legal claim on a
  reserve — that's the exact broker-dealer trap we're avoiding.
  If someone builds it on top of our tax primitive, that's their
  legal problem, not ours.

## The menu

At launch, the launcher picks one of the following as the tax
destination and a per-tx rate (0 – 500 bps, hard cap enforced by
the factory). Auto-exempt from tax: the curve, the fee splitter,
the launched-token factory, the launcher's own wallet, and — once
graduated — the v4 pool.

### 1. `BuybackURU` (baseline)

Route the tax as ERC-20 to the URU buyback vault. Same posture as
the flywheel — every DN404 trade also feeds the ecosystem
buyback. Cheap, boring, aligned with existing infrastructure.

### 2. `BuyAllowedToken(target)`

Accumulate tax in the launched token, then a keeper sweeps and
swaps to a specific allowlisted target ERC-20 (URU, USDG, any
canonical RH stock token, or any other governance-approved
asset). Deposits the swapped output into a per-launch treasury
address the launcher can withdraw from.

**Novelty**: this is the "buy $NVDA every time someone trades $TICK"
mechanic that lands cleanly because RH already hosts the real
stock tokens. Launchers can now credibly ship "hold this memecoin
and passively DCA into TSLA" as a feature — legally-clean on our
side because we're only routing to already-issued regulated
tokens.

Governance-managed allowlist prevents launchers from routing tax
to a rug they control. Allowlist starts with:

- URU
- USDG
- Every token in the RH canonical stock registry (indexer picks
  the list up from the on-chain registry contract)
- ETH via WETH

Adding/removing entries is a multisig call, same posture as
`CurveFactory.setTrustedRouter`.

### 3. `AddToLP`

Accumulate tax, pair with pool base (WETH or the launch's pair
currency), and add liquidity into the DN404's v4 pool. Reduces
sell pressure over time. Only meaningful post-graduation — while
still on the curve, this destination silently accumulates as a
pending balance.

### 4. `HolderReflections`

Distribute tax pro-rata to non-skip-listed ERC-20 holders. Classic
memecoin mechanic. DN404 wrinkle: the mint/burn NFT hook fires on
every balance change, so a naive reflection would fire an NFT
transition on every holder for every trade — potentially blowing
past the block gas limit for large collections. Solution: hold
reflected balances in a claimable escrow instead of pushing them
into wallets synchronously. Holders call `claimReflections()` when
they want, and only then does their NFT balance move.

### 5. `BurnDead`

Send tax to `0x0000...dEaD`. Reduces circulating supply, which
also burns mirror NFTs on the whole-unit transitions. Simplest
possible destination.

### 6. `MirrorFloorSupport` (the actually-novel one)

Accumulate tax in the launched token. Off-chain keeper watches
the accumulated balance and, when it crosses a threshold, does
the following in one bundled sequence:

1. Read a "floor price" for the mirror ERC-721 from a
   marketplace API (OpenSea / Blur / Magic Eden — whichever has
   depth on RH; probably a keeper-managed weighted average).
2. Compute how many NFTs the accumulated balance can afford.
3. Swap enough of the accumulated tax to the pool's pair
   currency to fund the buys.
4. Buy that many mirror NFTs from the floor via a keeper wallet.
5. Transfer the bought NFTs back to the DN404 base contract,
   which triggers the mirror-burn side of DN404's paired
   mechanics: the NFTs are burnt, the ERC-20 supply backing them
   is deducted from `totalSupply`, and the floor is tightened.

The feedback loop:

- Every ERC-20 trade tightens the mirror NFT float.
- A tighter mirror float raises the floor price.
- A higher floor price means each unit of accumulated tax buys
  fewer NFTs (softens the effect at equilibrium).
- Meanwhile the paired base ERC-20 supply is dropping in
  lockstep with the burnt NFTs.

**This is not a rebase.** `totalSupply` genuinely decreases as
NFTs are burnt on the base's side; DN404's `_burn` handles the
uint96 bookkeeping correctly.

**Why nobody has shipped this**: it takes DN404 (year-old
primitive) plus a specific launchpad willing to run an off-chain
keeper for it. Plain ERC-20s can't do it (no paired NFT), plain
NFTs can't do it (no ERC-20 transfer tax), and DN404 launches
without a keeper can't do it (no marketplace-buy path from a
solidity hook).

**Threat model**: the keeper wallet is the trust surface. Its
compromise doesn't let anyone mint free NFTs (the base's
`_initializeDN404` cap still holds) but does let an attacker
front-run its buys. Cap the per-window buy volume, use flashbot-
style private submission, rotate the keeper key on a schedule.

### 7. `Off` — no tax

The default. DN404 launches that don't want any of the above just
leave the hook mode set to `Off` and behave identically to the
current v1 launch.

## Contract layout

```
contracts/src/dn404/
  Dn404Template.sol              — unchanged base half
  Dn404MirrorTemplate.sol        — unchanged mirror half
  Dn404TaxHook.sol               — NEW: mixin adding _beforeERC20Transfer
                                   with the tax-take + destination dispatch
  Dn404TaxDestinations.sol       — NEW: enum + per-destination handlers
  Dn404TaxAllowlist.sol          — NEW: owner-managed registry of
                                   allowlisted ERC-20 destinations
                                   (governance-controlled multisig)
  Dn404LaunchFactory.sol         — MODIFIED: LaunchParams gains
                                   `taxMode`, `taxBps`, `taxTarget`
                                   fields; factory routes them into the
                                   base template's initialize()
```

Optional additional templates for launchers who want the hook
without paying gas on every trade when they'll never enable it:

```
  Dn404TemplateNoHook.sol        — impl without the mixin; taxMode
                                   is validated as Off at launch
```

Rationale: paying ~2k gas per transfer for a hook you never use is
a real cost on high-frequency trading pairs. Two impl slots on the
factory, code-hash-pinned per URU-A08 posture, launcher picks one
at launch time. `TaxMode.Off` + no-hook template is the default;
launchers who want tax pick the with-hook template explicitly.

## Launcher UX

`/create/dn404` gains a new "hooks (optional)" section:

- Radio: tax mode (Off / BuybackURU / BuyAllowedToken / AddToLP /
  HolderReflections / BurnDead / MirrorFloorSupport)
- Slider: tax bps 0 – 500
- If tax mode = BuyAllowedToken: a dropdown of allowlisted targets
  populated from the on-chain allowlist (indexer surfaces this)
- Live-preview: for a hypothetical $X in volume, how much tax gets
  routed and what happens to it

## Rollout

Same posture as the DN404 core:

1. Docs + review (this file).
2. Write the mixin + factory changes + tests on a `dn404-lane-hooks`
   branch OR fold into the existing `dn404-lane` if the audit hasn't
   started yet.
3. Route it into the same DN404 audit round (adds maybe 3-5 days
   of auditor time; net cheaper than a separate round).
4. Testnet rehearsal alongside the base DN404.
5. Ship together as one launch moment.

If the DN404 audit has already started when this SPEC gets
greenlit, punt hooks to a v1.1 rotation to avoid re-opening the
scope.

## Decisions (rev 2, 2026-09-03)

1. **Post-launch tax destination change:** ALLOWED, but only among
   the enum options we shipped. Since destination is an enum, this
   is enforced by construction — the launcher (via Ownable) can call
   `setTaxDestination(newEnum, newTarget?)` and the setter validates
   the enum is in-range + target is on the allowlist. No escape
   outside the menu is possible. Emits `TaxDestinationChanged` for
   consumers.
2. **Tax rate:** NOT adjustable. Set once at initialize, immutable
   for the life of the pair. Removes the "raise tax after launch"
   rug vector entirely.
3. **Keeper (MirrorFloorSupport):** WE run it. Same posture as the
   flywheel keeper. Adds ops load — one more process to monitor —
   but keeps the promise credible for launchers who couldn't
   operate one themselves.
4. **Keeper fee:** 5% of the tax stream, transparent per-transaction.
   Emitted in the `MirrorFloorSweep` event as a separate line item so
   the launcher and holders can see what the keeper took vs. what
   went to floor buys. Held in an owner-managed treasury; consumed
   for keeper gas + operational overhead.

## Stock-pair DN404 launches (rev 2 — MOVED INTO SCOPE)

Launcher picks a **pair currency** at launch time from a curated
allowlist. The DN404's bonding curve prices in that currency
instead of ETH — buyers pay in the chosen currency to receive the
base token, and post-graduation the v4 pool trades against it.

Combined with the existing "launcher brings their own art" flow
(baseURI + contractURI from studio-pinned metadata, already
shipped in slice 9b), a launcher can now ship: **a DN404 pair
where the token trades against $NVDA, with the mirror NFTs being
their own studio-uploaded art**.

Nothing about this needs us to become a broker-dealer — the RH
stock tokens are already issued compliantly on RH chain (see the
canonical registry at `docs.robinhood.com/chain/contracts`). We
route to already-existing regulated tokens; the launcher trades
against them via a normal ERC-20-paired bonding curve.

### v1 pair-currency allowlist

Governance-managed, seeded from the RH stock registry. Adding /
removing entries is a multisig call, same posture as
`Dn404TaxAllowlist` and `CurveFactory.trustedRouters`.

Requested v1 set:

- **URU** (ecosystem token, baseline)
- **USDG** (RH stablecoin — quietest starting pair)
- **WETH** (identical to today's ETH-paired behavior, kept as
  default for existing memecoin launches)
- **NVDA, TSLA, AAPL, AMZN, GOOGL, PLTR, COST, HIMS, RBLX, GME**
  (10 stock tokens — subject to canonical addresses actually
  being live on the RH registry at build time)
- **SPCX / SPCE** (space-exposure asset — needs canonical ticker
  confirmation from the RH registry; flagged as "if available")

Any ticker whose canonical RH registry entry isn't populated at
build time drops from v1 and gets added post-launch via
governance — no re-audit needed because the mechanic is generic
over the allowlist.

### What has to change to ship this

**Scope narrowed 2026-09-03: pair-currency support is DN404-ONLY.**
ERC-20 launches through `Router.launch` continue to price in ETH,
unchanged. This means the existing V10 curve stack (CurveFactory,
BondingCurve impl, Graduator) keeps serving every existing and
future plain ERC-20 launch untouched — zero blast radius on that
path. The rotation described below is DN404-exclusive:

- Existing V10 CurveFactory + BondingCurve impl + V8 Graduator:
  still the target for `Router.launch` ERC-20 flows. Unchanged
  behavior, unchanged code.
- NEW V11 CurveFactory + BondingCurve impl + V9 Graduator: **only
  the `Dn404LaunchFactory` routes to these.** Adds pair-currency
  support; no other lane sees them.

Both factories are whitelisted trusted routers on their respective
curve factories. Old ERC-20 launches are physically incapable of
picking a non-ETH pair currency because their factory (Router) never
exposes the argument.

The heavy lift is in the curve stack, which today assumes ETH:

**`BondingCurve.sol`:**
- `initialize()` gains a `pairCurrency` field (address; zero =
  ETH for backward compatibility with all existing launches).
- Buy path: replace `msg.value` accounting with
  `IERC20(pairCurrency).transferFrom(buyer, curve, amount)` when
  the pair is non-zero.
- Sell path: transfer pair currency out instead of ETH.
- Graduation math already works in units of "pair currency"
  internally, so the change is at the I/O boundary.

**`CurveFactory.sol`:**
- `createCurveWithConfigFor` gains a `pairCurrency` argument.
- Pair currency validated against the allowlist at create time
  (revert `CurveFactory__UnallowedPairCurrency`).

**`Graduator.sol`:**
- Graduation into a v4 pool needs the pair currency as pool
  key's `currency0` / `currency1` slot instead of hard-wired
  ETH/WETH.
- Existing ETH graduations continue to route through WETH.

**`Dn404LaunchFactory.sol`:**
- `LaunchParams` gains `pairCurrency` field.
- Validated against `Dn404PairCurrencyAllowlist` (new contract,
  or reuse the tax allowlist — TBD in impl).

**Frontend:**
- `/create/dn404` gains a pair-currency dropdown populated from
  the allowlist (indexer surfaces this from the on-chain
  contract).
- `/trade/[address]` price / mcap displays render in the pair
  currency for the token (e.g. "0.02 NVDA" not "0.02 ETH").
- Live-price rail on the home + discover cards render pair-
  currency-appropriately.

**Indexer:**
- `curves` and `launches` tables gain a `pairCurrency` column.
- Price computations in v4Router indexing use the correct pair.

### Audit blast radius

Now that pair-currency is DN404-only, the audit picture is
materially smaller than rev 1 suggested. The V11 curve stack is
new code that nobody has run in production yet, so it does need
audit — but it does NOT need re-audit of the V10 stack, and it
does NOT change any live launch's code path.

**What needs new audit:**
- CurveFactoryV11 (delta vs. V10: adds `pairCurrency` arg + allowlist
  gate on `createCurveWithConfigFor`)
- BondingCurveV11 impl (delta vs. V10: ETH I/O replaced with
  IERC20 transfers when `pairCurrency != address(0)`; otherwise
  identical)
- GraduatorV9 (delta vs. V8: v4 PoolKey built from `pairCurrency`
  instead of hardcoded WETH; otherwise identical)
- Dn404LaunchFactory delta (adds `pairCurrency` to LaunchParams
  and forwards it to the new curve stack)
- Dn404PairCurrencyAllowlist (new tiny contract)

**What does NOT need re-audit:**
- V10 CurveFactory, V10 BondingCurve impl, V8 Graduator — no code
  change, and no ERC-20 launcher will ever reach the V11 stack.

Audit-round-wise this could still fold into the DN404 audit round
because the delta is characterized (three targeted rotations vs.
V10/V8, plus one factory field, plus one allowlist contract).

**Rollout paths, rev 2:**

1. **Full stock-pair support in v1** (Recommended given scope is
   DN404-only): fold V11 curve rotation into the DN404 audit
   round. Adds ~2-3 weeks vs. shipping DN404 with ETH-only, but
   ships one coherent story ("DN404 pairs, choose ETH / USDG /
   any RH stock token"). Two-lanes launch (NFT + DN404) still
   hits its window with modest slip.

2. **Compromise: v1 = USDG only, stocks in v1.1**: ships fastest.
   USDG allowlist as day-one non-ETH option; other stock tokens
   added as pure allowlist entries after launch with zero
   additional audit. Adds ~1 week vs. ETH-only.

3. **Serial: v1 ETH-only, stock pairs v2 later**: unchanged from
   rev 1. Zero delay on v1; stock story lands 4-6 weeks after
   launch as a separate rotation.

## Not-shipping-but-explored (unchanged)

- **Oracle-priced DN404**: launcher picks a Chainlink price feed
  (e.g. NVDA), the DN404's price is pegged to the feed via a
  rebalancing mechanic. Interesting but pulls oracle risk into
  the launch surface. Deferred to a possible v1.2 lane once
  we've observed how launchers actually use the tax hook.
- **Cross-lane composition**: allow the tax destination to be
  ANOTHER DN404 pair on the launchpad, so launcher A's trades
  buy launcher B's NFTs. Cute; adds coordination risk; defer.
- **NFT wrapping / fractionalization**: let launchers "bring an
  existing ERC-721 collection" and wrap it as the DN404 mirror
  side. Distinct from "bring your own art metadata" (which is
  already shipped as baseURI + contractURI). Wrapping requires
  custody logic + redemption + per-collection deployment; a
  bigger product than the tax hooks. Defer.
