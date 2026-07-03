'use client';

/// Shortcut: /profile → /profile/<connected wallet>, or a "connect to see ur profile"
/// prompt if disconnected. The real profile UI lives in /profile/[address].

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import { Mascot } from '@/components/Mascot';

export default function ProfileMePage() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  // Gate on mount so wagmi's post-hydration `isConnected` flip doesn't mismatch SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (mounted && isConnected && address) router.replace(`/profile/${address}`);
  }, [mounted, address, isConnected, router]);

  // Until mount, render the disconnected state — it's the SSR-safe baseline.
  const showConnected = mounted && isConnected;

  return (
    <div className="mx-auto max-w-2xl px-4 py-14 text-center">
      <Mascot size={80} mood={showConnected ? 'happy' : 'confused'} className="uru-idle-bob" />
      <div className="uru-eyebrow" style={{ marginTop: 8 }}>profile</div>
      <h1 className="uru-h1" style={{ fontSize: 32 }}>
        {showConnected ? 'redirecting ~~' : 'connect ur wallet first ✿'}
      </h1>
      <p style={{ marginTop: 6, color: 'var(--anchor-soft)', fontFamily: 'var(--font-round), Klee One, cursive' }}>
        {showConnected
          ? 'sending u to ur profile page ~'
          : 'ur profile lives at /profile/<ur wallet>. connect above to see urs, or paste any address in the url to see theirs.'}
      </p>
      {!showConnected && (
        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <Link href="/discover" className="uru-btn">« back to launches</Link>
        </div>
      )}
    </div>
  );
}
