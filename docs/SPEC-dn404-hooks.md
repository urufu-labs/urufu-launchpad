# SPEC — DN404 Transfer Hooks + Tax Destinations

> **Status:** 🟡 DRAFT — scope + architecture only. No code yet.
> _last updated: 2026-09-03_
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

## Open questions

1. Should launchers be able to CHANGE tax destination post-launch?
   Argument for: markets evolve, they should be able to switch to
   BurnDead if BuybackURU stops being interesting. Argument
   against: adds a "rug the tax destination" attack surface.
   Recommend: one-shot at launch, no post-launch mutation.
2. Should the tax rate be adjustable? Same tradeoff. Recommend:
   set once, immutable.
3. `MirrorFloorSupport` — who runs the keeper? Us (matches
   existing keeper-per-flywheel posture) or the launcher (their
   problem)? Recommend: us, to keep the promise credible for
   launchers who couldn't run a keeper themselves. Adds ops load.
4. Fee for the keeper — take ~5-10% of the tax stream as
   compensation, transparent up-front? Or roll into the launch
   fee? Recommend: transparent per-transaction cut.

## Not-shipping-but-explored

- **Oracle-priced DN404**: launcher picks a Chainlink price feed
  (e.g. NVDA), the DN404's price is pegged to the feed via a
  rebalancing mechanic. Interesting but pulls oracle risk into
  the launch surface. Deferred to a possible v1.2 lane once
  we've observed how launchers actually use the tax hook.
- **DN404 pair currency = a Robinhood stock token**: launcher
  launches a DN404 whose bonding curve prices in USDG or TSLA
  instead of ETH. Requires a CurveFactory change (allow the pair
  currency to be an ERC-20, not just ETH). Bigger surface,
  bigger audit; defer.
- **Cross-lane composition**: allow the tax destination to be
  ANOTHER DN404 pair on the launchpad, so launcher A's trades
  buy launcher B's NFTs. Cute; adds coordination risk; defer.
