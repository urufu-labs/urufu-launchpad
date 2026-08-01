# PR #1 Accounting

Snapshot: 2026-08-01.

PR: <https://github.com/urufu-labs/urufu-launchpad/pull/1>
Head: `origin/audit-round-2`
Base: `main`

GitHub reports PR #1 as open, not draft, and clean to merge against remote
`main`. The PR body also says: "Do not merge." Treat it as review evidence and
a handoff branch until the repo owner explicitly says otherwise.

## Remote Sync

- `git fetch origin --prune` refreshed `origin/audit-round-2`.
- `git pull --ff-only origin main` returned `Already up to date`.
- `git rev-list --left-right --count main...origin/main` returned `5 0`.
- `git rev-list --left-right --count main...origin/audit-round-2` returned
  `5 4`.

Interpretation: local `main` contains five review/doc commits that are not on
remote `main`. Remote `main` has no unseen commits. PR #1 contributes four
branch commits that are not in local `main`.

## Clean-Merge Probe

`git merge-tree --write-tree --messages HEAD origin/audit-round-2` returned:

```text
f5a1c2f08e536dc199e7a54d406c82b3eaaf27b0
```

There were no conflict messages. That means PR #1 merges textually with the
current local review docs, but it does not override the PR body's "Do not merge"
instruction.

## Changes That Affect The Review

### Router split

On local `main`, the active contract tree still has both:

- `contracts/src/router/Router.sol`
- `contracts/src/router/RouterV2.sol`

PR #1 deletes `RouterV2.sol` and flattens the ETH, URU, and whitelist entrypoints
into `Router.sol`. That addresses the narrow "why do we have two routers before
launch?" smell.

It does not yet address the deeper first-principles concern. The PR branch still
has four public launch entrypoints:

- `launch`
- `launchWithURU`
- `launchWithWhitelist`
- `launchWithURUAndWhitelist`

So the recommendation changes from "delete `RouterV2`" to "collapse the public
launch surface into one request/payment/policy flow." ETH, URU, and whitelist
should be modes inside the same launch model, not separate business paths with
mirrored safety rules.

### Loyalty wiring

The earlier review found that loyalty-discount copy was unsafe because the live
Router had no oracle wired. PR #1 reports two owner-only live setter
transactions, and the live checks on 2026-08-01 confirmed:

- `LoyaltyOracle.uruToken()` is
  `0x9fbe210007dDd8389f98d0253018e65CC48b9D24`.
- `LoyaltyOracle.gemuNft()` is
  `0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17`.
- `Router.loyaltyOracle()` is
  `0xd13A1fb6d9c209B56044464269fce66Ed417AC2E`.

That supersedes the "discounts are not live" finding for current Robinhood
chain state. The release requirement should now be a live wiring guard: if the
UI advertises loyalty discounts, the deployment snapshot must assert the Router
oracle and oracle token pins.

### URU payment

The live Router also reports:

```text
minUruFee() = 1000000000000000000000
```

That is a nonzero floor, so the old "dust URU" diagnosis is stale for the live
deployment. The deeper issue remains: the URU path still accepts a
caller-supplied `uruAmount` above a floor. It does not enforce a contract-side
quote equivalent to the ETH launch fee. That is acceptable only if the product
describes URU pay as a configured floor, not as a guaranteed market-priced ETH
equivalent.

### Cleanup and test posture

PR #1 moves in the same simplification direction as the bottom-up review:

- retires the airdrop module end-to-end;
- nulls retired chain config;
- deletes stale hook/script/test surfaces;
- adds a fork-free local Uniswap v4 stack and launch/graduation invariants;
- adds live Robinhood snapshot tests for the loyalty/router wiring.

Those are useful repairs, not slop. The main risk is that the PR is a large
97-plus-file cleanup branch, so it should be reviewed as a branch of its own
rather than casually merged into the review-doc branch.

## Still Unresolved After PR #1

- No atomic launch-and-buy path.
- `BondingCurve.buy()` still transfers bought tokens to `msg.sender`, so a
  router-executed first buy likely needs `buyFor(recipient)` or equivalent
  recipient-aware logic.
- Hook-based anti-sniping still starts at v4 graduation, while the first curve
  buy remains a separate protection surface.
- The public launch API is still split across ETH, URU, and whitelist variants.
- URU pay still has floor enforcement, not full on-chain price enforcement.
- The product still needs a small, deployer-facing v4 protection preset model.

## Recommendation

Do not merge PR #1 just because it is conflict-clean. Account for it this way:

1. Treat the RouterV2 deletion as directionally correct.
2. Keep the architectural target stricter than PR #1: one launch request, one
   payment abstraction, one hook/protection policy abstraction.
3. Mark the loyalty-discount finding as superseded by live wiring, but keep a
   live snapshot test as a release gate.
4. Keep atomic launch-and-buy as a must-have if the product advertises a
   protected creator/seed first buy.
5. Review PR #1's large cleanup separately before adopting it, because it
   changes contracts, scripts, web config, and tests in one branch.
