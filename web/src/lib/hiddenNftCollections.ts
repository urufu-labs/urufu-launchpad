/// Central hide-list for NFT collections. Twin of hiddenTokens.ts, kept
/// separate because NFT collections and ERC-20 tokens live in different
/// address spaces / indexer tables and get filtered in different helpers.
///
/// Hidden collections still work at direct URLs (/collection/<addr> renders),
/// but they don't appear in feed-style lists: discover NFT tab, home NFT
/// section, profile "your NFTs" widget, launcher-earnings widget, etc.
///
/// Keyed by `${chainId}:${lowercaseAddress}` for O(1) lookup.

import type { Address } from 'viem';

export const HIDDEN_NFT_COLLECTIONS: ReadonlySet<string> = new Set<string>([
  // Rehearsal launches broadcast 2026-09-01 through the freshly-deployed
  // NftLaunchFactory (0xBe33…525A). All deployer-owned test collections
  // to prove the workflow end-to-end; not real launches.
  //
  //   - Rehearsal Ephemeral (REH)  — first attempt; mint bricked because
  //     the factory's FeeSplitter slot was stale at initialize time. The
  //     mint module has no setter for feeSplitter so this collection is
  //     permanently unmintable. Hide from every surface.
  '4663:0x5dfbdd8508efbff04dcc14bb255f7a3bde071ce4',
  //   - Rehearsal Ephemeral 2 (REH2) — successful test; base+mint+withdraw
  //     all proven on-chain. Kept hidden anyway so real users don't stumble
  //     into a test collection.
  '4663:0x023ac6d02656805eddb3e1c71083a81ed4ede522',
  //   - Rehearsal Linear Step (REHL) — LinearStep pricing test. 3-mint
  //     batch verified base + step × mintedBefore math on-chain.
  '4663:0x3ed0d9c2f254f5df60b52e0f71d163e05a22abbf',
  //   - Rehearsal URU Fixed (REHU) — URU-paid mint. approve → mintWithUru →
  //     10% to UruDepositSink → 90% accrue → withdrawUru all proven.
  '4663:0xc7ce25d2192bd18b05e004812ad1b216b03e73f0',
  //   - Rehearsal WL Merkle (REHW) — WalletList whitelist gate; deployer on
  //     single-leaf merkle tree minted with empty proof + wlUsed=true.
  '4663:0xa2e34a3ea44e71c51e930470a291b124b20eb7ef',
  //   - Rehearsal WL Discount (REHD) — WalletList discount tier (20% off);
  //     tier proof mint applied discount correctly (net 0.00008 vs gross 0.0001).
  '4663:0x1f9d6f453584d413f10aeaaf17e95e894b0cf64e',
  //   - Rehearsal Ext NFT Discount (REHX) — ExternalNft discount tier via
  //     urufu gemu nft (10% per gemu, cap 5). Deployer had 2 gemus → 20%
  //     off applied at mint time using keeper-signed attestation.
  '4663:0xbf145973a3a119c807e1f2985d725ddfad36939d',
  //   - V2 stack Ext NFT rehearsal — factory 0x5b4D…a77F. Mint reverted;
  //     forge build cache had not picked up the ourCollection fix so the
  //     V2 impl still had the pre-fix semantics. Orphan collection.
  '4663:0x6666906033be027d3820305b7f4e85f4613eda48',
  //   - V3 stack Ext NFT rehearsal — factory 0x861A…44A9. Fix confirmed
  //     working: sig against ERC-721 address verified on-chain and the
  //     mint went through. Kept hidden anyway (it's a rehearsal).
  '4663:0x8221ba10ff881145ad80d17dcc44a52d4a75da63',
]);

export function isHiddenNftCollection(chainId: number, collectionAddress: Address | string): boolean {
  const addr = typeof collectionAddress === 'string'
    ? collectionAddress.toLowerCase()
    : (collectionAddress as string).toLowerCase();
  return HIDDEN_NFT_COLLECTIONS.has(`${chainId}:${addr}`);
}

/// Curried filter for `.filter()` callbacks on rows that carry both fields.
export const notHiddenNft = <T extends { chainId: number; collectionAddress: Address | string }>(row: T): boolean =>
  !isHiddenNftCollection(row.chainId, row.collectionAddress);
