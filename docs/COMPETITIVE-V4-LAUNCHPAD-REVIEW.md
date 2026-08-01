# Competitive V4 Launchpad Review

Research snapshot: 2026-08-01.

PR #1 note: GitHub PR #1 (`origin/audit-round-2`) removes the separate
`RouterV2.sol` file and folds ETH, URU, and whitelist paths into `Router.sol`.
That is directionally aligned with this review, but the competitive requirement
remains stricter: users and auditors should see one launch model, not four
public launch entrypoints with mirrored safety rules. See
[`PR-1-ACCOUNTING.md`](./PR-1-ACCOUNTING.md).

This is the competitive follow-up to the first-principles review. The question
is no longer "do v4 hooks differentiate us?" The better question is:

> What kind of v4 hook launchpad is still worth shipping now that competitors
> are already using v4 hooks as their core primitive?

Short answer: urufu can be competitive, but not as the broad, organically
evolved product currently implied by the repo. The sharp v1 should be a
protected v4 launchpad: one launch path, audited hook presets, factual launch
state, locked liquidity, clear creator/platform fees, and enough indexing to be
discovered where traders already buy new launches.

## Market Read

The competitive market has moved past generic token deployment. The current
launchpad bar is:

- v4-native liquidity or v4 graduation.
- Locked liquidity or no migration rug surface.
- Creator revenue from swaps.
- Launch fairness / anti-bot / anti-MEV mechanics.
- Simple launch UX that hides protocol machinery.
- Aggregation into broader discovery surfaces.

That is why our current router/matrix/module sprawl is dangerous. It spends
complexity on optionality that competitors are not asking users to care about.
The winning story is not "we support many token bases and mechanics." The
winning story is "your token launches with credible protection and survives
into a v4 pool whose behavior you understand."

## Competitor Landscape

| Project               | What They Emphasize                                                                                                                               | Competitive Pressure On Us                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Programmable          | Simple fixed-supply v4 launches, permanent one-sided liquidity, configurable buy/sell fees, creator rewards, optional stock-token pairs           | V4 hooks and creator rewards are already table stakes. Our anti-sniping and hook presets must be clearer than their generic fee/hook story. |
| Flaunch               | Fixed-price fair launch, v4 hooks, creator/community revenue split, auto buybacks, SDK/API/manager layer                                          | Their launch fairness is productized. We need protection presets that feel equally legible, not hidden protocol config.                     |
| Bankr                 | Agent/social token launching, Robinhood/Base support, v4 pools, creator rewards, API integration                                                  | Distribution and launch surface matter. A better contract architecture alone will not win if launches are invisible.                        |
| Pons                  | Robinhood launchpad included in Uniswap Launches; press-reported V2 points at v4 hooks, ETH bonding curves, ETH creator payouts, and custom pairs | This may overlap our exact curve-to-v4 path. We need a sharper reason to exist than "bonding curve then v4."                                |
| Long.xyz              | Uniswap Launches integration and time/epoch-style launch metadata through Mobula integration docs                                                 | Calendar/epoch launches may be easier for users to understand than reserve-triggered graduation.                                            |
| Hyde.fun              | Robinhood v4 launchpad team publicly emphasizes atomic create + seed + first buy                                                                  | Anti-sniping is not only a hook problem. We need to remove the launch-to-first-buy transaction gap.                                         |
| Doppler / Uniswap CCA | v4 hook-based auction and price discovery, anti-snipe/anti-MEV framing, no separate migration in Uniswap's launchpad docs                         | Serious builders will compare us to CCA-style launches, not only meme launchpads.                                                           |

## Programmable

Programmable is the clearest direct comparator because its docs are short,
specific, and centered on v4 mechanics.

### Verified product shape

The Classic model uses a fixed-supply ERC-20. The docs state a 1 billion token
supply, no transfer tax, no blacklist, no sell restrictions, no rebase, and no
minting after launch. It lets the creator choose buy/sell fees in a 1% to 10%
range, with creator rewards equal to the selected fee minus a 0.10% protocol
fee. Liquidity is permanent one-sided Uniswap v4 liquidity. There is no launch
fee beyond gas.

Programmable's launch flow is intentionally simple: set token metadata,
choose fees, optionally provide an initial buy, and launch. The initial buy is
custodied and unlocks after a configured period or vesting schedule. Trading
then occurs through the v4 pool and creator rewards accrue from fees.

Its Stock-Paired model extends the same idea to reviewed stock-token pairs.
The docs describe using Ondo Global Markets tokens as approved quote assets and
routing ETH into the quote token before the initial buy. Creator rewards accrue
in the quote token instead of ETH.

### Why this matters

Programmable is not selling "modules." It is selling:

- fixed supply;
- v4 liquidity from day one;
- creator revenue;
- simple fee choice;
- no obvious token tax traps;
- optional stock-paired novelty.

That is a tighter product than our current matrix. It also means "we have v4
hooks" is not enough. If our hook layer does not give launchers something
legibly safer or more useful than configurable fees, we are not differentiated.

### Opening for urufu

Programmable does not appear, from the current docs reviewed, to center a
deployer-selectable anti-sniping menu. The opening is to make launch protection
the deployer-facing hook product:

- Off: normal trading, locked liquidity, simple creator/platform fees.
- Standard: short post-launch protection window with mild dynamic fee or
  wallet/transaction caps.
- Strict: launch window with stronger bot friction, allowlist option, and
  clear restrictions.

Those settings must be presets, not arbitrary hook knobs.

## Flaunch

Flaunch is a strong example of productized v4 hooks. It documents developer
integration paths through a Web2 API, TypeScript SDK, and treasury managers.
The product pitch is not just "launch a token"; it is launch, trade, route
treasury behavior, and build downstream products on the protocol.

### Verified product shape

Flaunch's docs describe a Fixed Price Fair Launch period where a set number of
coins are available at one price for early buyers. The docs show a 30 minute
fixed-price window. The point is fairness: early traders are not forced into
instant price discovery against bots and aggressive buyers.

Flaunch also makes creator revenue a first-class product surface. Creators can
choose a revenue share from 0% to 100% of the coin's revenue, and that split is
immutable after launch. Creator revenue is paid in ETH on swaps. The remainder
can flow to the community through auto buybacks.

The auto-buyback feature uses a v4 hook called Progressive Bid Wall. Fees fund
bid-wall orders below spot, so the token builds buy support as trading fees
arrive. Treasury managers add another extension surface for revenue and
ownership behavior.

### Why this matters

Flaunch turns launch fairness and treasury routing into obvious product
benefits. That is exactly the layer where urufu should compete, but our current
codebase exposes too many half-products around it.

### Opening for urufu

Flaunch's fair launch is more like a fixed-price early market. Urufu can carve
out a different wedge:

- anti-sniping and anti-MEV presets instead of only fair-price inventory;
- graduation-aware protection, covering both curve launch and v4 pool opening;
- Robinhood-native launch discovery and URU/gemu economics later, after the
  base product works.

## Bankr

Bankr matters because it is in Uniswap Launches and because it treats launch as
a distribution surface, not just a smart-contract workflow.

### Verified product shape

Bankr docs describe natural-language token launching through BankrBot and X,
with API endpoints for app integrations. Supported launch chains include
Robinhood Chain and Base. Launched tokens receive a fixed supply and are made
tradable immediately through a Uniswap v4 pool.

Bankr's docs specify several launch constraints and economics:

- 15% of supply vests to the creator by default, with no presale.
- Creator claims are available through Bankr and contract calls.
- Creator fees accrue as a mix of the launched token and quote token by
  default, with quote-only fees available as an opt-in at launch.
- The documented fee stack totals 1.75% on swaps, split among creator rewards,
  a hook-added locked-liquidity leg, protocol fee, BNKR buybacks, and Doppler.
- Robinhood deployment includes anti-Sybil wallet restrictions and daily launch
  caps.

### Why this matters

Bankr's threat is not just contract design. It owns an easier top-of-funnel:
agents, social launch, and Uniswap Launches discovery. If urufu is only a
standalone create form, we are competing with distribution already turned on.

### Opening for urufu

Bankr's automated/agent launch flow is convenient, but it may not give serious
deployers much control over launch protection. Urufu should not copy the bot
surface for v1. It should win with trusted launch configuration:

- protection preset;
- fee preset;
- liquidity lock proof;
- launch/graduation state clarity;
- an API/event shape that can later feed aggregators.

## Pons

Pons is important because it appears in Uniswap Launches on Robinhood, and
because press reports about Pons V2 describe a feature set close to our own
desired shape.

### Verified product shape

Uniswap's official Launch Aggregator says it starts with Bankr, Pons, and
Longtail. Mobula's integration docs describe Pons launchpad integration,
including Pons creator events, pool metadata, graduation state, deployer/owner
metadata, launch type, and liquidity locking concepts.

### Press-reported V2 shape

Crypto.news reported that Pons V2 on Robinhood Chain planned to use Uniswap v4
hooks, ETH-denominated bonding curves, ETH creator payouts, custom trading
pairs, and lower graduation thresholds.

Treat this as useful competitive signal, not primary protocol documentation.
It is enough to tell us the market is already aiming at our lane.

### Why this matters

If Pons V2 really becomes ETH curve plus v4 hooks plus creator payouts, then
"curve then v4" is not a moat. It is a common shape. Urufu needs a sharper
answer:

> We provide the simplest protected launch path for deployers who care about
> sniping, MEV, liquidity locks, and clear post-graduation hook behavior.

## Long.xyz / Longtail

Uniswap Launches identifies Longtail as one of the first integrated launchpads.
Mobula's Robinhood launchpad integration docs also include Long.xyz, with
fields for launch epochs, pool initialization, hook address, PoolId, and time
completion.

The interesting contrast is that Long-style launches appear easier to explain
as time-bounded launch epochs. Urufu's reserve-triggered curve graduation may
be a better market mechanic, but it is not automatically simpler. We need the
UI to explain graduation state as plainly as a countdown.

## Hyde.fun And Atomic Launches

Hyde.fun's public note is worth treating as a design requirement, not just a
tweet. Their point: one common snipe vector is the gap between token/market
creation and the deployer's first buy. If those are separate transactions, bots
can observe the newly created market and insert before the intended buyer.

The mechanical fix is atomic launch:

```text
one transaction:
  create token
  seed curve or pool
  execute first buy
```

No external transaction can land between internal calls in the same transaction,
so there is no mempool gap to front-run. This does not prevent backruns after
the launch transaction lands, and it does not replace post-launch hook
protections. It covers a different surface: the moment before the first real
trade.

This maps directly to urufu. Current Router logic deploys the token and installs
the bonding curve in one transaction, but surplus ETH is refunded and the first
actual curve buy is a separate `BondingCurve.buy()` call. If v1 advertises a
creator first buy or seed buy, that buy should be part of the launch call with a
minimum output check.

## Doppler And Uniswap CCA

This is the architectural comparison that matters most.

Uniswap's own liquidity launchpad docs describe a v4-based launchpad using
Collateralized Competitive Auction mechanics. The documented feature list
includes gradual price discovery, MEV-resistant auction mechanics, low-capital
launches, anti-snipe/anti-MEV protection, custom fees, funds returned to issuer,
no migration, and a referral system.

Doppler's public materials describe a v4-hook protocol for fair price
discovery and MEV protection, with automatic liquidity migration into Uniswap
v2 or v4. Its repository documentation describes auctions implemented through a
v4 hook, with logic in swap callbacks.

### Why this matters

Our current architecture assumes a bonding curve first and Uniswap v4
graduation later. That can be viable, but only if we choose it intentionally.
CCA-style competitors force the core question:

> Why should urufu launch on its own curve before v4 instead of launching
> directly into a v4 hook that handles price discovery?

Good possible answers:

- Robinhood users expect small-launch bonding curves.
- The curve creates a clear graduation moment and social milestone.
- The curve lets us enforce launch protections before v4 liquidity exists.
- The curve gives deployers a simpler "raise to graduate" story.

Bad answer:

- The code already evolved that way.

## Uniswap Launches And Distribution

Uniswap's Launch Aggregator is a major competitive clue. It aggregates launches
from supported launchpads directly in the Uniswap interface, initially across
Base and Unichain. The launch aggregator blog says the integrated launchpads
at announcement were Bankr, Pons, and Longtail. It also cited more than
340,000 tokens and over $3.6 billion of Uniswap Protocol volume from launchpads
in July.

The implication is harsh but useful:

> If urufu launches are not easy for aggregators, indexers, and trading UIs to
> discover, the product will feel invisible even if the contracts are good.

V1 needs an integration posture:

- canonical launch events;
- canonical pool/hook/graduation metadata;
- canonical token metadata;
- indexer queries for launch state, protection preset, fees, and lock status;
- deep links to trade;
- documented API or subgraph-like query surface.

## Competitive Product Bar For Urufu V1

### Must have

- One public launch path.
- One current router.
- ERC-20 only.
- ETH payment first.
- Bonding curve only if we can explain why it beats direct v4 launch.
- Atomic create + seed + optional first buy, with slippage protection.
- V4 hook from the beginning of the product story.
- Locked post-graduation liquidity.
- Three deployer-facing protection presets: off, standard, strict.
- Clear fee model: creator fee, platform fee, claim path, payout asset.
- Graduation state users can understand without reading contracts.
- Indexer/API shape designed for aggregator compatibility.

### Should have

- Initial buy policy that is explicit about recipient, amount, slippage, and
  whether the buy is protected by atomic launch.
- Whitelist or allowlist only as part of the strict protection preset.
- A launch card that previews supply, allocation, fees, protections, lock, and
  graduation rules before signing.
- A protection explainer written in user language, backed by exact hook config.
- Audit notes for each hook preset before the preset is public.

### Should not have in v1

- Router and RouterV2 as separate public architecture. If PR #1 lands, treat
  this as partially fixed and focus on the remaining four-entrypoint launch
  surface.
- ERC-721A or ERC-1155 launch modes.
- Arbitrary runtime compile/register.
- Direct/no-sale/fixed-sale/LBP mechanics.
- URU payment as a primary path until the contract enforces pricing safely.
- URU/gemu flywheel as the lead product story.
- Arbitrary deployer-configured hook knobs.
- Stock/RWA pairs until legal, oracle, routing, and UX risks are intentionally
  owned.

## Architecture Implications

### 1. Pick the launch primitive before more feature work

We should make one explicit v1 decision:

- Curve-to-v4: keep the current bonding-curve product, but simplify the stack
  and make graduation/protection the core.
- Direct v4/CCA-like launch: redesign around a v4 hook from block zero, using
  price discovery and anti-sniping inside the hook.

Both can work. Supporting both before launch is the smell.

Recommendation: keep curve-to-v4 only if the team wants the social
"graduate to v4" mechanic. Otherwise pause new curve work and prototype a
direct-v4 protected launch design.

### 2. Replace duplicated router paths with one launch request

Competitors show simple public surfaces. Local `main` still has the
Router/RouterV2 split, and PR #1 only partially resolves the smell by moving the
same public variants into one file. One v1 router should accept one launch
request and one payment mode.

Suggested shape:

```solidity
enum PaymentMode {
  ETH,
  URU
}

enum ProtectionPreset {
  Off,
  Standard,
  Strict
}

struct LaunchRequest {
  string name;
  string symbol;
  address deployer;
  bytes32 configHash;
  ProtectionPreset protection;
  bytes32 metadataHash;
}

struct LaunchPayment {
  PaymentMode mode;
  uint256 maxAmount;
}
```

URU can exist later as a payment mode. It should not create another launch
surface.

### 3. Remove the token-create-to-first-buy gap

The current urufu Router creates the token and curve atomically, but it refunds
extra ETH instead of using it for a first buy. That means an advertised deployer
entry can only happen in a later transaction.

V1 should either:

- support `launchAndBuy`, where `msg.value = launchFee + initialBuyEth`, the
  router creates the curve, executes the buy through a recipient-aware curve
  path or safe router-forward step, enforces `minTokensOut`, and sends tokens to
  the configured recipient; or
- stop advertising creator first buys as a protected launch feature.

This is separate from hook-based anti-sniping. Atomic launch removes the
pre-first-buy insertion point. Hook policy manages trades after the curve or v4
pool exists.

### 4. Make hook policy a product object

`MultiHookHost` should not be invisible plumbing. It should be represented as a
small immutable launch policy:

- protection preset;
- launch window length;
- early fee behavior;
- wallet/transaction cap behavior, if any;
- creator fee bps;
- platform fee bps;
- burn behavior, if any;
- claim recipients.

Every UI and indexer surface should render the same policy. No hidden launch
rules.

### 5. Cover both launch moments

If we keep curve-to-v4, there are two places snipers care about:

- first curve buy;
- first v4 pool swap after graduation.

Only protecting post-graduation v4 swaps is not enough. Either the curve needs
its own launch protection, or the product copy must be honest that protection
starts at v4 graduation.

### 6. Optimize for aggregator compatibility

The launchpad should emit and index events that external surfaces can consume:

- token launched;
- curve created;
- protection policy selected;
- fees configured;
- graduated;
- v4 pool created;
- hook address;
- liquidity locked;
- creator reward claimable.

This is not a nice-to-have. Uniswap Launches makes aggregation part of the
distribution game.

## Product Positioning

The simplest competitive positioning is:

> Protected v4 token launches on Robinhood Chain.

Supporting copy:

- Launch on a bonding curve.
- Graduate into locked Uniswap v4 liquidity.
- Choose a protection preset before launch.
- Earn transparent creator fees.
- Give traders a launch state they can verify.

Do not lead with:

- URU/gemu flywheel.
- multi-token-base composition;
- arbitrary hook/module architecture;
- future stock pairs;
- compile-service magic.

Those can exist later. They should not define v1.

## Decision Questions

1. Are we trying to beat Pons on Robinhood Chain, or build the broader
   protected-v4-launch primitive?
2. Does curve-to-v4 still beat direct v4 launch once CCA-style patterns are on
   the table?
3. What exact moment does "anti-sniping" protect: first curve buy, first v4
   swap, or both?
4. Should deployers be able to perform an atomic first buy in the launch
   transaction?
5. Are we willing to make protection presets immutable per launch?
6. What launch details must every trader see before buying?
7. What event/API shape would make a launch aggregator want to list us?
8. Which current repo features would we delete if competitors did not exist?

## Recommended Next Moves

1. Freeze the v1 product as protected ERC-20 curve-to-v4 launches, or stop and
   compare against a direct-v4 protected launch design.
2. If PR #1 lands, finish the router simplification by collapsing the four
   public launch entrypoints into one launch request/payment model.
3. Add atomic launch-and-buy support, or remove any protected first-buy claim.
4. Design the three protection presets as product policy first, then map each
   to exact contract behavior.
5. Remove the future product matrix from the public create path.
6. Add an aggregator-minded event/indexer spec.
7. Keep URU/gemu economics as phase two unless they are contract-enforced and
   easy to explain.

## Source Links

- Programmable Classic model:
  <https://programmable.family/docs/models/classic>
- Programmable Stock-Paired model:
  <https://programmable.family/docs/models/stock-paired>
- Flaunch quick start:
  <https://docs.flaunch.gg/guides/quick-start>
- Flaunch fixed price fair launch:
  <https://docs.flaunch.gg/features/fixed-price-fair-launch>
- Flaunch creator revenue:
  <https://docs.flaunch.gg/features/creator-revenue>
- Flaunch auto buybacks:
  <https://docs.flaunch.gg/features/auto-buybacks>
- Bankr token launching docs:
  <https://docs.bankr.bot/token-launching/overview/>
- Uniswap Launch Aggregator:
  <https://blog.uniswap.org/launch-aggregator-explore-top-uniswap-launchpads-in-one-place>
- Uniswap liquidity launchpad / CCA docs:
  <https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/overview>
- Uniswap v4 hook docs:
  <https://developers.uniswap.org/docs/protocols/v4/concepts/hooks>
- Doppler public site:
  <https://www.doppler.lol/>
- Doppler docs repository:
  <https://github.com/whetstoneresearch/doppler-docs>
- Mobula Pons integration docs:
  <https://docs.mobula.io/almanac/robinhood-launchpads/pons>
- Mobula Long.xyz integration docs:
  <https://docs.mobula.io/almanac/robinhood-launchpads/longxyz>
- Hyde.fun atomic launch note:
  <https://x.com/hydefunX/status/2083402010217328707>
- Crypto.news Pons V2 report:
  <https://crypto.news/robinhood-chain-launchpad-pons-announces-v2-with-uniswap-v4-upgrade/>
