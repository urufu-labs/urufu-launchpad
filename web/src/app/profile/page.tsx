'use client';

/// Shortcut: /profile → /profile/<connected wallet>, or a "connect to see ur profile"
/// prompt if disconnected. The real profile UI lives in /profile/[address].

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import { Mascot } from '@/components/Mascot';
import styles from './profile.module.css';

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
    <div className={styles.entryFrame}>
      <section className={`uru-shell ${styles.entryCard}`} style={{ textAlign: 'center' }}>
        <div className={styles.entryMascot}>
          <Mascot size={84} mood={showConnected ? 'happy' : 'confused'} className="uru-idle-bob" />
        </div>
        <div className="uru-eyebrow">creator profile</div>
        <h1 className="uru-h1" style={{ fontSize: 36, lineHeight: 1.05 }}>
          {showConnected ? 'opening your profile' : 'connect to open your profile'}
        </h1>
        <p className={styles.entryCopy}>
          {showConnected
            ? 'sending this wallet to its profile, launched tokens, activity, and holdings.'
            : 'profiles live at /profile/<wallet>. connect above to see yours, or paste any address in the url to view a public profile.'}
        </p>
        {!showConnected && (
          <div className={styles.entryActions}>
            <Link href="/discover" className="uru-btn">browse tokens</Link>
            <Link href="/feed" className="uru-btn uru-btn-mint">open feed</Link>
          </div>
        )}
      </section>
    </div>
  );
}
