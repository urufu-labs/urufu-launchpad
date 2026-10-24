import type { Metadata } from 'next';

import { collectionPreview } from '@/lib/sharePreview';

/// Server wrapper for the client-only marketplace collection page: the same
/// creator-image link preview as /collection/[address] (lib/sharePreview.ts).
export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
  const { address } = await params;
  return collectionPreview(address, 'market');
}

export default function MarketAddressLayout({ children }: { children: React.ReactNode }) {
  return children;
}
