# NFT launch activation checklist

The NFT (ERC-721A) and multi-item (ERC-1155) bases are wired end-to-end in the
contracts + tests but grayed out in the shop UI while we prove the flywheel on
fungibles first. This doc is the exhaustive punch list to unlock them.

## What's already ready

### Contracts (no changes needed)
- `Router.launch` already accepts `BaseType.ERC721A` and `BaseType.ERC1155`
- `Router` has per-base launch fees (`erc20Fee`, `nftFee`, `erc1155Fee`)
- `ERC721AFactory`, `ERC1155Factory` are deployed by Phase 1
- 5 curated NFT impls registered: `ERC721ATemplateImpl`, `ERC721AWithSvgImpl`,
  `ERC721AWithRoyaltyImpl`, `ERC721AWithSvgAndRoyaltyImpl`, `ERC1155TemplateImpl`
- Composed impls using `PayableMint1155` + `SupplyPerToken1155` are registered

### Flywheel (already ready)
- `LoyaltyOracle` applies discount tiers to NFT launches uniformly
- `FeeSplitter` receives NFT launch fees from Router today (BaseType-agnostic)
- `RoyaltyRouterImpl` + `RoyaltyRouterFactory` deployed by `DeployFlywheel.s.sol`,
  ready for launchers to point their ERC-2981 receiver at
- `PayableMint1155Split.frag.sol` module exists and forwards platform bps of every
  mint to FeeSplitter

## What's needed to activate

### 1. UI: unlock the cards
- `web/src/app/create/page.tsx`: flip `NFT_BASES_ENABLED = false` → `true`
- `web/src/app/page.tsx`: revert the "erc-20 live · nft + 1155 soon" copy to the
  three-bases messaging (or refresh with a Phase-2 launch announcement)

### 2. Contracts: ship the split-mint impl ✅ DONE
- ✅ `PayableMint1155Split.frag.sol` — module fragment exists
- ✅ `shared/matrix.json` — module registered
- ✅ `compile-service/fixtures/erc1155-split-payable.json` — splicer fixture
- ✅ `contracts/src/templates/composed/ERC1155WithSplitPayableGen.sol` — spliced
- ✅ Registered in `DeployPhase1.s.sol` under `ERC1155_SPLIT_PAYABLE_CONFIG`
- ✅ Integration test `contracts/test/composed/ERC1155WithSplitPayableGen.t.sol`
  (9 tests passing)

### 3. Launch flow: wire the royalty router into NFT launches ✅ DONE (predicted-address flow)
- ✅ `web/src/lib/nftRoyalty.ts` — `predictRoyaltyRouting()` computes both the
  collection address and the royalty clone address BEFORE launch, and returns
  the encoded 2981 init data with the clone address baked in as the receiver
- ✅ `materializeRoyaltyClone.build(routerFactory, collection, launcherPayout)`
  — post-launch, anyone can call this to materialize the clone (idempotent)
- ETH sent to a not-yet-materialized clone lands at the deterministic address;
  `distributeStuck()` on the clone flushes accumulated balance after materialize

The full flow when NFTs unlock:
```ts
import { predictRoyaltyRouting, materializeRoyaltyClone } from '@/lib/nftRoyalty';

// pre-launch
const { collection, royaltyClone, royaltyInitData } = await predictRoyaltyRouting(client, {
  factory: contracts.ERC721AFactory,
  royaltyFactory: contracts.RoyaltyRouterFactory,
  launcher: userAddress,
  name, ticker, configHash,
  royalty: { totalRoyaltyBps: 500 }, // 5% ERC-2981 payment from marketplaces
});

// build LaunchParams with royaltyInitData baked into the 2981 module slice
await writeContract({ address: contracts.Router, abi: routerAbi, functionName: 'launch', args: [params], value: fee });

// post-launch: materialize the clone (any wallet can trigger, one-time)
await writeContract(materializeRoyaltyClone.build(contracts.RoyaltyRouterFactory, collection, userAddress));
```

### 4. Web: metadata + trade views
- Collection detail page at `/collection/[address]` (analog of `/trade/[address]`
  for ERC-20s)
- OpenSea / Blur listing links, mint UI for 1155 payable drops
- Indexer subscription for `PayableMintedSplit` events

### 5. Docs
- Update README.md flywheel section: three streams instead of one
- Publish per-launcher royalty split docs (platform 5% / launcher 95% default)

## Contract addresses (post-DeployFlywheel)

The RoyaltyRouterImpl + Factory land in `deployment-flywheel.<chainid>.json`
alongside the other flywheel contracts. The impl is frozen forever (Ownable
irrelevant — clones are init-once-forever). The factory's `platformSink` can be
rotated by admin (affects future deploys only; existing clones keep their
originally-configured sink).

## Fee flow summary once activated

| Stream | Where the fee comes from | Route |
|---|---|---|
| **Launch fee** | Router.launch{value: nftFee} | Router → FeeSplitter → 40/35/25 |
| **Primary mint (1155)** | `PayableMint1155Split.mintPayable{value: price*qty}` | Module → FeeSplitter → 40/35/25 |
| **Secondary royalty** | Marketplace pays clone per ERC-2981 | Clone → 5% FeeSplitter + 95% launcher |

Launch + mint slice the ETH into 40/35/25 (URU buyback / gemu holders / treasury).
The royalty stream is 95% launcher / 5% platform, then the 5% platform slice
enters the same 40/35/25 split when it hits FeeSplitter.
