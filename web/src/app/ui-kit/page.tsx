import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { UiKit } from './UiKit';

export const metadata: Metadata = { title: 'UI kit', robots: { index: false, follow: false } };

/// Dev-only gallery of the v2 primitives (docs/PLAN-ui-revamp.md, Phase 1).
/// Returns 404 in production builds so it never ships to users.
export default function UiKitPage() {
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SHOW_UI_KIT !== '1') notFound();
  return <UiKit />;
}
