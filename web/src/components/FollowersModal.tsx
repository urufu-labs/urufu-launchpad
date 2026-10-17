'use client';

/// Centered modal listing followers or following for a wallet. Each row is
/// clickable and navigates to the user's profile page. Data comes from the
/// compile-service (server-stored follows); if the backend is unreachable the
/// modal shows the empty state — no localStorage fallback since only the
/// wallet's own follows would be knowable that way, not who follows them.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from 'viem';

import { fetchFollowers, fetchFollowing, type RemoteFollowUser } from '@/lib/socialApi';
import styles from './FollowersModal.module.css';

export type FollowsMode = 'followers' | 'following';

interface Props {
  address: Address;
  mode: FollowsMode;
  onClose: () => void;
}

export function FollowersModal({ address, mode, onClose }: Props) {
  const [items, setItems] = useState<RemoteFollowUser[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const rows = mode === 'followers' ? await fetchFollowers(address) : await fetchFollowing(address);
      if (cancelled) return;
      setItems(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [address, mode]);

  // ESC closes the modal — standard modal ergonomics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = mode === 'followers' ? 'Followers' : 'Following';

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={styles.backdrop}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={styles.dialog}
      >
        {/* Header */}
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="ui-icon-btn"
            data-size="sm"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && (
            <div className={styles.empty}>
              Loading…
            </div>
          )}
          {!loading && items !== null && items.length === 0 && (
            <div className={styles.empty}>
              {mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}
            </div>
          )}
          {!loading && items && items.length > 0 && (
            <ul className={styles.list}>
              {items.map((u) => {
                const short = `${u.address.slice(0, 6)}…${u.address.slice(-4)}`;
                const label = u.username?.trim() || short;
                return (
                  <li key={u.address}>
                    <Link
                      href={`/profile/${u.address}`}
                      onClick={onClose}
                      className={styles.row}
                    >
                      <div className={styles.avatar}>
                        {u.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={u.avatarUrl}
                            alt=""
                            width={32}
                            height={32}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          label.slice(0, 1).toUpperCase()
                        )}
                      </div>
                      <div className={styles.text}>
                        <div className={styles.name}>
                          {label}
                        </div>
                        <div className={styles.address}>
                          {short}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
