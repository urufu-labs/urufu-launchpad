import type { Metadata } from 'next';

import { collectionPreview } from '@/lib/sharePreview';

/// Server wrapper for the client-only collection page. Its only job is the
/// link preview: the creator's banner / collection image / first NFT, the
/// collection name and their description (see lib/sharePreview.ts).
export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
  const { address } = await params;
  return collectionPreview(address, 'collection');
}

export default function CollectionAddressLayout({ children }: { children: React.ReactNode }) {
  return children;
}
