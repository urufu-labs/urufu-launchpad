/// A launcher's own collection image + description (saved from Customize your
/// page on /collection/[address]) win over the indexer's copy wherever a list
/// of collections is shown: home, discover, feed. One batch request per list;
/// if it fails the indexer rows are used as they are.

import type { IndexerNftCollection } from './indexer';
import { fetchTokenMetadataBatch } from './socialApi';

export async function withCreatorDetails<T extends Pick<IndexerNftCollection, 'collectionAddress' | 'coverImageUrl' | 'description'>>(
  rows: T[],
  chainId: number,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const saved = await fetchTokenMetadataBatch(chainId, rows.map((r) => r.collectionAddress));
  return rows.map((r) => {
    const own = saved[r.collectionAddress.toLowerCase()];
    if (!own) return r;
    return {
      ...r,
      coverImageUrl: own.imageUrl || r.coverImageUrl,
      description: own.description || r.description,
    };
  });
}
