# DN404 fallback strategy

> **Status:** initial pass
> _last updated: 2026-09-03_
> _resolves SPEC-dn404-launchpad.md decision #6_

Fallback plan if a fresh known-issue in Vectorized DN404 lands during the
build or audit window and we cannot ship on the current pin as-is.

## Landscape as of today

Facts gathered 2026-09-03:

- **Vectorized/dn404** is our primary. Pinned at commit `3397cb1` (tag
  `v0.0.25`, released 2025-02-19). See `contracts/lib/dn404.NOTICE.md`.
- **`main` has been quiet ~18 months** — last commit is the v0.0.25 tag
  itself. No new tags, no security advisories, no GitHub releases. Guardian
  audit at v0.0.17 patched 2 highs; that PDF ships in the repo.
- **Issue #155 (Sep 2025)** reported `DNNotInitialized` on the SimpleDN404
  example under Hardhat. Closed. Suggests ongoing user testing but no
  security disclosure. No open bug/correctness issues in the tracker today.
- **~157 forks exist on GitHub** but none surface as a maintained
  general-purpose alternative. Named variants seen (`dn404-adjustable`,
  `dn69`, `undefy-dn404`, `fiftysix-dn404`, `DRAGO404`, etc.) all look
  project-specific customizations, not drop-in replacements.

**Read:** there is no meaningfully-better upstream to switch to. Fallback
planning is not "pick a maintained fork" — it is "how do we ship if
upstream stays quiet on a fresh finding."

## Trigger conditions

Move to a fallback plan if and only if one of these happens:

1. A security researcher discloses a **critical or high** finding in
   `DN404.sol` or `DN404Mirror.sol` at any tag <= our pin, and upstream
   does not patch within 5 business days.
2. Our own audit round surfaces a finding in the vendored source that
   upstream declines to fix.
3. A finding in Vectorized/solady (referenced by DN404) forces a coupled
   rev that upstream does not accept.

Trigger #1 and #3 arrive from the outside world; trigger #2 arrives from
our own audit and is the most likely one.

## Plans, ranked

### Plan A — patch in place, upstream a PR

Cheapest and most transparent. Fix the finding in a temporary internal
branch of the submodule, ship the patch as a fork commit we pin over
`3397cb1`, and open a PR upstream at the same time. NOTICE.md updates to
list the delta commits so reviewers can diff cleanly.

**When it works:** finding is small (<200 LOC), fix is uncontroversial,
audit round can absorb the delta.

**Re-audit cost:** ~$3-8k incremental if the scope stays inside our
existing DN404 audit round. Auditor treats the patch as a delta review.

**Ops cost:** near zero — same submodule mechanics; NOTICE + a `PATCHES/`
directory carrying our diffs.

### Plan B — self-maintained hard fork

If upstream does not respond or the patch is nontrivial. Fork
`Vectorized/dn404` to our own GitHub org, keep the commit hash chain
attributable, and re-point the submodule at our fork. This is not a
rewrite — it is our copy that we take responsibility for.

**When it works:** upstream is quiet, patch is >200 LOC, or we need to
land multiple deltas without waiting on review.

**Re-audit cost:** full DN404 module re-audit range **$20-40k**. Pricing
is bandy because it depends heavily on the audit firm's familiarity with
DN404 (Guardian would be cheapest — they audited the original) and how
much of the surface we touched.

**Ops cost:** we now own upstream. Adds a permanent maintenance line —
tracking upstream commits and back-porting anything useful. Realistic
budget: ~1 engineer-day per month of drift.

### Plan C — switch to a different reference implementation

Only if `DN404` itself is deemed unshippable. Options that exist today
are all specialized (`dn404-adjustable`, `undefy-dn404`, etc.) and none
are visibly maintained as drop-in replacements. Choosing one means
inheriting whichever team's audit posture (or lack of it), so this is
strictly worse than Plan B unless a very specific feature is needed.

**When it works:** effectively never for our use case. Documented for
completeness.

**Re-audit cost:** full audit round + integration re-review, $40-80k+.

**Ops cost:** highest — we become customers of a small team's project
without leverage over its direction.

### Plan D — pivot to DN420 (single-contract ERC1155 variant)

The reference impl also ships `DN420.sol` (vendored at our pin, not used
in v1). DN420 is single-contract and avoids some of DN404's paired-contract
subtleties, but marketplace support is materially worse (OS + Blur handle
ERC721 far better than shared ERC1155 collections).

**When it works:** only if a DN404-specific finding lands that DN420 is
provably immune to AND the marketplace UX regression is acceptable to
the launcher persona.

**Re-audit cost:** roughly the same as Plan A (~$5-10k delta) because
DN420 is already in-tree at our pin.

**Ops cost:** medium — templates and factory would need to be rewritten,
and the SPEC's "ERC-721 side plugs into /collection/[address] unchanged"
promise breaks.

## Decision rules

- **Default:** ship on Vectorized/dn404 v0.0.25 unchanged.
- **On our own audit surfacing a fix:** Plan A first, escalate to Plan B
  if upstream doesn't respond in 5 business days.
- **On external disclosure with no upstream response in 5 business days:**
  go straight to Plan B.
- **Never** Plan C without a specific unavoidable reason.
- **Only** Plan D if the finding is DN404-specific and marketplace
  regression is acceptable — this is a project pivot, not a fix.

## What we hold ready in advance

To keep fallbacks cheap, before slice 4 lands:

1. Vendor is a submodule, not copied source (already done — enables
   fast re-pin without re-auditing every line).
2. NOTICE.md records SHA-256 checksums so any patch produces a visible
   diff in code review (already done).
3. Our wrapper contracts (`Dn404Template`, `Dn404MirrorTemplate`) inherit
   from upstream rather than modifying it — plans A/B/C all reduce to
   changing the parent contract; our subclasses stay stable.
