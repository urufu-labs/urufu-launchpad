# Zero-fee NFT marketplace (spec)

> **Status:** approved 2026-10-19 with all defaults (M1-M5)
> _written 2026-10-19_

Buy and sell NFTs from collections launched on urufu, with **no platform
fee**. Covers both the NFT lane and DN404 NFTs (people do buy DN404 NFTs
for traits).

## No new contracts

Seaport 1.6 is already deployed on Robinhood Chain (checked 2026-10-19):

| Contract | Address |
|---|---|
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| ConduitController | `0x00000000F9490004C11Cef243f5400493c00Ad63` |

Sellers sign orders off-chain (EIP-712, no gas to list). Buyers fill them
on-chain through Seaport. "Zero fee" means our orders have no platform
consideration item: the seller gets the full price minus the creator royalty,
if any. No contract of ours holds anyone's NFTs or ETH, so there is nothing
new to audit.

## Scope (v1)

- **Collections:** only ones launched through the NFT lane or DN404 lane. The
  indexer already knows every one. No outside collections, so no fakes.
- **Listings only**, priced in ETH. Collection-wide and per-token offers need
  WETH approvals and come later.
- **Royalties (M1):** honor ERC-2981 when the collection has it (NFT-lane
  launches that picked a royalty template do). DN404 mirrors don't, so no
  royalty there.

## DN404 specifics

- Seller approves Seaport on the **mirror** (ERC-721) contract.
- Moving an NFT moves one NFT's worth of tokens with it. If the seller later
  sells tokens and the NFT gets burned, the listing goes dead. We hide it the
  moment the indexer sees the mirror `Transfer` and re-check `ownerOf` before
  showing the buy button.
- Each listing shows **"token value of 1 NFT"** next to its price, so buyers
  see when a trait premium is real and when they would be overpaying vs just
  buying the token.
- Buyer must be able to receive NFTs (skipNFT off). The buy button checks
  `getSkipNFT(buyer)` and explains it if it's on.

## Backend (compile-service)

New tables in the site Postgres (`railway` db), new routes:

| Route | Does |
|---|---|
| `POST /market/orders` | Validate signature, collection is ours, seller owns the token, Seaport approved, no platform fee item, royalty item matches ERC-2981, price > 0, expiry ≤ 180 days. Store. |
| `GET /market/collections/:addr/listings` | Live listings, cheapest first, with traits |
| `GET /market/tokens/:addr/:id` | Listing for one NFT, if any |
| `GET /market/wallet/:addr` | A wallet's listings |

Cancels happen on-chain (Seaport `cancel` or `incrementCounter`); the indexer
marks them. Rate limits match the WL routes.

## Indexer

Index Seaport `OrderFulfilled`, `OrderCancelled`, `CounterIncremented`,
filtered to our collections (offer item token in our launch list). Gives a
sales feed and floor history. Events only. Count `logFilterIntervals` rows
before pushing and warn about restart time.

## Web

- **Collection page:** "Listed" tab with floor, listing count, sort by price
  or rarity, Buy button. "Activity" tab with sales.
- **Profile:** "List" on each owned NFT (price + expiry), "Cancel" on your
  listings.
- **NFT detail:** price, seller, Buy, and for DN404 the token-value line.
- **Home rail (later):** NFT sales next to token trades.

Copy rule for the site: say "No marketplace fee. Creator royalty, if set,
still goes to the creator."

## Tests

- Signature and order validation unit tests, including fee-item injection
  attempts.
- Fork tests on live RH: list and fill against real Seaport for an NFT-lane
  collection and a DN404 mirror; DN404 burn invalidates the listing; royalty
  goes to the right address.
- Fill through the browser with a real wallet once on a preview deploy.

## Decisions to sign off

| # | Question | Default |
|---|---|---|
| M1 | Honor creator royalties | Yes, when ERC-2981 is set |
| M2 | Collections allowed | Our NFT + DN404 launches only |
| M3 | v1 order types | ETH listings only (offers later) |
| M4 | Max listing expiry | 180 days |
| M5 | Where orders live | compile-service + site Postgres |
