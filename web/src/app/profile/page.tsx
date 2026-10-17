'use client';

/// Shortcut: /profile → /profile/<connected wallet>, or a "connect to see ur profile"
/// prompt if disconnected. The real profile UI lives in /profile/[address].

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import { WalletButton } from '@/components/WalletButton';
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
      <section className={styles.entryCard}>
        <p className={styles.entryEyebrow}>Profile</p>
        <h1 className={styles.entryTitle}>
          {showConnected ? 'Opening your profile…' : 'Connect to see your profile'}
        </h1>
        <p className={styles.entryCopy}>
          {showConnected
            ? 'Taking you to your launches, holdings and activity.'
            : 'Your profile shows the tokens you launched, what you hold, and your trades. You can also open anyone’s profile from a trade or the feed.'}
        </p>
        {!showConnected && (
          <div className={styles.entryActions}>
            <WalletButton />
            <Link href="/feed" className="ui-btn" data-size="lg">Open the feed</Link>
          </div>
        )}
      </section>
    </div>
  );
}
