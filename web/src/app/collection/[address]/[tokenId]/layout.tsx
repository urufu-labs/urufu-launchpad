import type { Metadata } from 'next';

import { nftPreview } from '@/lib/sharePreview';

/// Server wrapper for the client-only NFT page. Its only job is the link
/// preview: this NFT's art and name, falling back to the collection preview
/// (see lib/sharePreview.ts).
export async function generateMetadata(
  { params }: { params: Promise<{ address: string; tokenId: string }> },
): Promise<Metadata> {
  const { address, tokenId } = await params;
  return nftPreview(address, tokenId);
}

export default function NftTokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
