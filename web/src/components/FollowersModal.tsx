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

  const title = mode === 'followers' ? 'followers' : 'following';

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(58, 44, 58, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="uru-shell"
        style={{
          background: 'var(--cream)',
          width: '100%',
          maxWidth: 420,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: '1.5px solid var(--anchor)',
            background: 'var(--cream-deep)',
          }}
        >
          <div className="uru-eyebrow">✿ {title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            style={{
              fontFamily: 'var(--font-round), Klee One, cursive',
              fontSize: 14,
              padding: '2px 10px',
              borderRadius: 999,
              border: '1.5px solid var(--anchor)',
              background: 'var(--cream)',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--anchor-soft)', fontSize: 12, fontFamily: 'var(--font-pixel), monospace' }}>
              loading..
            </div>
          )}
          {!loading && items !== null && items.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--anchor-soft)', fontSize: 12, fontFamily: 'var(--font-pixel), monospace' }}>
              {mode === 'followers' ? 'no followers yet ~~' : 'not following anyone yet ~~'}
            </div>
          )}
          {!loading && items && items.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((u) => {
                const short = `${u.address.slice(0, 6)}…${u.address.slice(-4)}`;
                const label = u.username?.trim() || short;
                return (
                  <li key={u.address}>
                    <Link
                      href={`/profile/${u.address}`}
                      onClick={onClose}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 14px',
                        borderBottom: '1px dashed var(--cream-shadow)',
                        textDecoration: 'none',
                        color: 'var(--anchor)',
                      }}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          background: 'var(--pink-warm)',
                          border: '1.5px solid var(--anchor)',
                          overflow: 'hidden',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontFamily: 'var(--font-round), Klee One, cursive',
                          fontSize: 14,
                          fontWeight: 700,
                        }}
                      >
                        {u.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={u.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          label.slice(0, 1).toUpperCase()
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 14, fontWeight: 600 }}>
                          {label}
                        </div>
                        <div className="uru-num" style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
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
