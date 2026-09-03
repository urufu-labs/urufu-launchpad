# SPEC — DN404 Launchpad

> **Status:** draft
> _last updated: 2026-09-02_

> A third launch template that deploys a DN404 pair (one ERC-20 + one paired ERC-721 that auto-mints/burns as ERC-20 balance crosses whole units). Launcher gets a fungible token with a bonding curve AND a matching NFT collection out of the box. The ERC-20 side plugs into the existing curve stack unchanged; the ERC-721 side reuses the current /collection/[address] surface.

**Status:** 🟡 DRAFT — scope + architecture only. No code yet.
**Depends on:** V5 NFT stack (`NftLaunchFactory` + `ERC721ATemplate`), V10 curve stack (`CurveFactory` + `RouterV2` + `Graduator` + `FeeSplitter`), LoyaltyOracle, compile service.
**Blast radius:** additive — new factory + new template + new frontend route. Existing token and NFT stacks are untouched.

---

## Why DN404

Today a launcher picks one of:
- **Token launch** — ERC-20 with a bonding curve, graduates to a Uniswap v4 pool.
- **NFT launch** — ERC-721A collection with fixed / linear-step pricing, tier discounts, optional whitelist.

DN404 collapses those into one product for a specific class of launcher: they want a memecoin AND collectible art tied to it, without asking holders to acquire two separate assets or bridging between them. Every whole token = one NFT; sell fractional tokens and the NFT auto-burns; buy back to a whole unit and one is auto-minted. Trading happens on the ERC-20 curve; art (and marketplace listings) live on the ERC-721 side.

This is a genuinely new lane, not a variant of either existing one. Do not fold it into the ERC-721A path.

---

## What DN404 is (one-paragraph refresher)

DN404 is a paired-contract standard (Vectorized, 2024) where the "base" contract is an ERC-20 that internally tracks a "mirror" ERC-721 contract. When a holder's ERC-20 balance crosses a whole `unit` (default `1e18`, i.e. 1 token = 1 NFT), the base contract asks the mirror to mint an NFT to the holder; when it drops below, the mirror burns one. Both contracts implement their standard ABIs so wallets and marketplaces see them normally. Skip-lists let CEXes and pools opt out of NFT mints (avoids spamming exchange wallets with junk NFTs). Fresh audits exist for the reference impl.

**Fallback variant to keep in mind:** DN420 is the single-contract ERC1155-shaped variant. Not planned for v1 — too much marketplace friction and no compelling launcher demand yet.

---

## Design choice: dedicated factory, not an extension

The V5 `NftLaunchFactory` deploys ERC-721 + mint module. DN404 needs ERC-20 + mirror ERC-721 + curve wiring. Overloading the NFT factory would:
- Mix curve logic (currently ERC-20-side-only) into what is deliberately a Router-bypass path.
- Break the code-hash pinning story (one factory pinning three impls per launch type doesn't scale).
- Force the mint-module concept onto a token that doesn't need one (pricing is handled by the curve).

**Decision: build a dedicated `Dn404LaunchFactory` under `contracts/src/dn404/`.** It reuses the URU-fee + LoyaltyOracle wiring pattern from `NftLaunchFactory` (copy the fee guard verbatim, keep behavior identical) and reuses the curve stack for the ERC-20 side by calling into `CurveFactory.createCurve(...)` with the freshly-deployed base contract. The mirror ERC-721 is registered with the indexer via a new event so the /collection/[address] page renders normally.

---

## Contract layout

```
contracts/src/dn404/
  Dn404LaunchFactory.sol       — user-facing factory (URU fee + clone + curve wire)
  Dn404Template.sol            — base ERC-20 half (Vectorized DN404 impl, cloneable)
  Dn404MirrorTemplate.sol      — mirror ERC-721 half (Vectorized DN404Mirror, cloneable)
```

Both templates are cloneable via `LibClone.cloneDeterministic`. Impl addresses are pinned by code hash on the factory, matching URU-A08 posture — one-shot `setExpectedCodeHashes` + `setImpls`. Rotation requires a fresh factory.

**Vectorized impl integration.** We copy `dn404/src/DN404.sol` + `DN404Mirror.sol` into `contracts/lib/dn404/` (or vendor via foundry remapping), then wrap each in a thin cloneable subclass with an `initialize(bytes)` entrypoint matching our two-role model:

```solidity
// Dn404Template.sol (sketch)
contract Dn404Template is DN404, Initializable {
    address public owner;      // launcher
    address public curve;      // bonding curve address; only sink allowed to skip NFT mints

    function initialize(bytes calldata data) external {
        (address launcher_, address curve_, string memory name_, string memory symbol_,
         uint96 totalSupply_, address baseURIStorage) = abi.decode(data, (...));
        _initializeDN404(totalSupply_, curve_, mirrorAddress);
        // Curve receives full supply, then the curve mints out over time.
        _setSkipNFT(curve_, true);        // curve never accumulates NFTs
        _setSkipNFT(FEE_SPLITTER, true);  // fee splitter never accumulates NFTs
        // Graduator will be skip-listed too on graduation via governance call.
    }
}
```

Two-role model on the mirror: `owner` = launcher (edits on marketplaces), `minter` = base contract (only entity allowed to trigger mints/burns). Launcher cannot directly mint NFTs — mints are strictly driven by ERC-20 balance transitions.

---

## Curve integration

The DN404 base ERC-20 is a standard ERC-20 from the curve's perspective. `Dn404LaunchFactory.launch` does:

1. Charge URU launch fee (same helper as `NftLaunchFactory._minUruFeeFor`).
2. Clone `Dn404Template` and `Dn404MirrorTemplate`; deterministic-salt them together so both addresses are predictable from `(launcher, name, ticker)`.
3. Initialize the mirror with `(owner=launcher, base=<baseAddr>, mintersOnly=<baseAddr>)`.
4. Initialize the base with `(launcher, curveAddr, totalSupply, name, ticker, baseURIStorageContract, mirrorAddr)`.
5. Call `CurveFactory.createCurveForToken(baseAddr, launcher, curveParams)` — the curve now holds the initial supply and sells it via the standard bonding curve path.
6. Emit `Dn404Launched(base, mirror, curve, launcher, configHash, uruPaid, name, ticker)`.

**CurveFactory needs one small change.** Today `CurveFactory.createCurve` internally deploys the ERC-20. Add a sibling `createCurveForToken(address existingToken, ...)` that skips the deploy step and only wires the curve + supply pull. This is a compat-safe additive change; existing `createCurve` callers keep working.

**Graduator/Uniswap v4 side.** The base ERC-20 graduates normally into a v4 pool. The pool contract MUST be skip-listed for NFT mints — the base contract exposes an owner-callable `setSkipNFT(pool, true)` that Graduator invokes as part of graduation. Verify on fork: without this, the pool contract would end up holding thousands of NFTs, wasting gas on every trade.

**FeeSplitter.** Skip-listed at initialize time (see sketch above). Fee flow is unchanged — a normal ERC-20 fee stream to the flywheel.

---

## Launcher-configurable knobs

Same shape as the current LaunchParams: one struct, one call. Fields:

- `name`, `ticker`
- `collectionSize` (N) — **derived from the studio flow, not a raw input**. Launcher creates/mints an NFT collection of N pieces in the studio first (same as today's ERC-721 launch flow, no hard cap on N).
- `unit` — **tokens required to hold one NFT**. This is the launcher's headline knob and the marketing hook ("hold 10,000 $TICK, get an NFT"). Denominated in whole tokens (min 1). The DN404 base contract stores this as `unit * 1e18` wei internally.
- `totalSupply` — **derived**, not a raw input. Computed as `collectionSize * unit` and displayed as a live preview on the create form. This coupling is what makes the DN404 story hang together: every possible NFT id has exactly enough token supply to back it and no more.
- `baseURI` — mirror ERC-721 token metadata prefix (studio-pinned `/N.json` pattern, same as V5).
- `contractURI` — mirror collection metadata (cover + description).
- `royaltyBps` — ERC-2981 royalties on the mirror.
- `curveParams` — same struct the token launchpad already exposes (target ETH, virtual liquidity, etc.).
- `payWithUru` — bool. Same URU vs ETH pay-in-choice as V5 NFT.
- `uruAmount` — URU launch fee. **Priced higher than a plain token or NFT launch to reflect the added audit + support surface** (exact number TBD; propose 2× the plain-NFT floor).
- `founderPremintBps` — 0-2000 (i.e. 0-20%). Portion of `totalSupply` minted directly to the launcher before the curve activates. The remaining `10_000 - founderPremintBps` bps goes to the curve as the tradeable supply. Hard cap at 2000 so the curve still discovers real price.

**Deliberately NOT knobs in v1:**
- Whitelist / tier discounts — mint path is driven by ERC-20 balance transitions, not a dedicated mint call, so there is nowhere to insert discount logic. Restricted-access token distribution is handled via `founderPremintBps` for creators and via the curve's own pre-buy mechanic for allowlists.
- Per-wallet cap — same reason.
- Mint mode (Fixed / LinearStep) — price is set by the curve.

---

## Metadata model

DN404 NFT ownership is fluid: token id N might be held by wallet A one block and burnt the next. Two paths:

1. **Deterministic-from-token-id (recommended).** `tokenURI(N) = baseURI + N + ".json"`. Studio pins all N files up-front (same flow as V5). Every mint of token id N always shows the same art. Simplest, cheapest, matches how DN404 mints are assigned.
2. **Reveal / trait randomization.** Add an on-chain seed and derive traits per token id. More flexible, adds complexity + attack surface, skip for v1.

Go with #1. Studio needs zero changes.

---

## Marketplace + edge-case risks

DN404 has well-documented quirks. The plan must account for:

- **OpenSea listing gaps.** OpenSea historically indexes DN404 mirrors with delay — collection may look empty on OS for hours after launch. Frontend already renders live from indexer + Alchemy, so this is only an external-marketplace UX concern; document it in the launcher onboarding text.
- **Skip-list correctness.** Failure to skip-list the curve, feeSplitter, and graduated pool causes NFTs to accumulate in system contracts. Must be covered by a fork test that graduates a DN404 launch and asserts pool balance == 0 NFTs.
- **Gas budget on transfers.** DN404 transfers cost more than plain ERC-20 (potentially mint + burn per whole-unit transition). Fine for curve trading; measure on fork before defaulting `unit=1`.
- **Approval semantics divergence.** DN404 mirror `setApprovalForAll` behaves like a normal ERC-721 but the base contract handles its own ERC-20 approvals — front-end must not conflate the two contracts when a user "approves this collection".
- **Ordinal id assignment.** Vectorized's DN404 assigns ids incrementally on mint and reuses freed ids on burn+mint sequences. Studio metadata pinning must be tolerant of gaps and re-issuance of the same id.

---

## Frontend + indexer touchpoints

**Frontend.**
- New route: `/create/dn404` with launcher form. Feature-flagged behind `DN404_LAUNCHES_ENABLED[robinhood]` in `web/src/lib/config.ts` — dark on merge, flip after audit + rehearsal.
- Extend the create-picker (`/create`) to offer the third option.
- `/collection/[address]` works unchanged for the mirror ERC-721 (existing cover / description / mints / holders wiring reads via the ERC-721 ABI; DN404 mirror satisfies it).
- Add a "paired token" strip at the top of the collection page pointing to the base ERC-20 token page. Bidirectional link on the token page.
- Wagmi reads: mirror has `owner()` and `base()`; frontend uses `base()` to discover the ERC-20 side.

**Indexer (Ponder).**
- New event handler: `Dn404LaunchFactory:Dn404Launched(base, mirror, curve, launcher, ...)`.
- On indexing this event, register BOTH the base (as a curve token via existing curve handler machinery) AND the mirror (as an NFT collection, same schema as `nftCollections`). Add a `pairedToken` FK column to `nftCollections` so the collection page can render the token-side link.
- No new tables required; two rows in existing tables + one FK.

**Compile service.**
- Studio "create NFT" flow already pins `N.json` files to IPFS. No change needed for the deterministic-tokenURI path. Add a "DN404" preset that binds the pin count to `totalSupply` (since every whole unit is a mintable id).

**Env vars (Railway `indexer-robinhood`).**
- New: `ROBINHOOD_DN404_LAUNCH_FACTORY_ADDRESS`
- Same pattern as the existing `ROBINHOOD_NFT_LAUNCH_FACTORY_ADDRESS`. Indexer bootstraps from this address at first block.

---

## Audit + rollout

Do NOT flip live on merge. Sequence:

1. **Vendor Vectorized DN404** into `contracts/lib/dn404/` and verify checksums match upstream.
2. **Write templates + factory + tests.** Full coverage of skip-list correctness, curve integration, graduation. Add a `Dn404LiveStackSnapshot.t.sol` mirroring the token-side pattern from [live-stack-snapshot](../memory/project_live_stack_snapshot_pattern.md).
3. **External audit round.** DN404 has enough surface + subtlety that a fresh audit is required — do not stack it onto an existing round. Bug-fix rotation posture identical to V6-V10 pattern.
4. **Testnet rehearsal.** Full launch + trade + graduate cycle on a rehearsal collection. Verify OpenSea picks it up eventually.
5. **Deploy dark.** `DN404_LAUNCHES_ENABLED[robinhood] = false` in config; contracts on-chain and verified, indexer running.
6. **First real launch by internal team.** Watch for 48h. Verify holder list, /collection page, token trading, graduation.
7. **Flip live.** `DN404_LAUNCHES_ENABLED[robinhood] = true` + announcement.

---

## Decisions confirmed 2026-09-02

1. **Collection size comes from the studio; `unit` is the launcher's headline knob; `totalSupply` is derived.** Launchers create the NFT collection in the studio first (same flow as today's ERC-721 launch — no hard cap on how many they mint). They then pick `unit` (tokens required per NFT — this is the "hold X tokens, get an NFT" story). `totalSupply = collectionSize * unit`, shown as a live preview. No raw `totalSupply` field. Minimum `unit` is 1 whole token.
2. **URU launch fee: its own higher tier.** Justified by DN404's added audit + support surface. Concrete floor TBD, sketching at 2× the plain-NFT launch fee.
3. **Founder pre-mint allowed.** `founderPremintBps` knob added, hard-capped at 2000 (20%) so the curve still discovers price. Amount goes to the launcher's wallet at launch, remainder to the curve.
4. **Graduation: same v4 pool params as ERC-20 launches.** No dedicated DN404-only hook in v1. Revisit only if trading data motivates it.
5. **RH-only.** Same posture as every other post-migration launch surface.
6. **Vectorized DN404 impl is the primary target.** Before impl starts, build a shortlist of alternate maintained forks + rough re-audit cost estimates so we have a fallback if a fresh known-issue lands during the build window.
