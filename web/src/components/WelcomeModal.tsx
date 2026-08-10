'use client';

/// First-visit welcome modal. Shows on the very first page load per browser
/// (gated by localStorage flag), then never again. Explains what urufu labs
/// is + a "not live yet" heads-up in the site aesthetic so new visitors know
/// they're looking at pre-launch testing rather than a production launchpad.
///
/// Design: same shell language as FollowersModal — centered, cream card,
/// dark border + offset shadow, close on backdrop click / ESC / button.
/// Layered ONE LEVEL above the header (zIndex 100) so it appears immediately
/// on page hydration.

import { useEffect, useState } from 'react';

import { Mascot } from './Mascot';

const STORAGE_KEY = 'uru-welcome-seen-v1';

export function WelcomeModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Deliberately check on client mount only (never SSR) so we don't hydrate
    // an already-visible modal + immediately hide it. Also delay by ~350ms
    // so the page paints its background/mascot first — feels less like an
    // interrupt, more like a warm hello.
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch {
      return; // Storage disabled → don't nag on every load, just skip.
    }
    const t = window.setTimeout(() => setOpen(true), 350);
    return () => window.clearTimeout(t);
  }, []);

  const dismiss = () => {
    try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
    setOpen(false);
  };

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
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
          maxWidth: 460,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
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
          <div className="uru-eyebrow" id="welcome-title">✿ welcome to urufu labs</div>
          <button
            type="button"
            onClick={dismiss}
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
        <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Mascot size={56} mood="happy" />
            <div style={{ flex: 1 }}>
              <div className="uru-h1" style={{ fontSize: 20, lineHeight: 1.1 }}>
                hi ~ we&apos;re not live yet
              </div>
              <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>
                urufu labs is a launchpad for <b>customizable tokens</b>. u compose real
                on-chain features (anti-bot, staking, voting, royalties, and more) then
                ship it in one tx.
              </div>
            </div>
          </div>

          <div
            className="uru-shell-tight"
            style={{
              background: 'var(--cream-deep)',
              padding: '8px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div className="uru-eyebrow" style={{ fontSize: 10 }}>❀ how it works</div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 12.5,
                lineHeight: 1.55,
                listStyle: '"✿ "',
              }}
            >
              <li>launches onto a bonding curve so anyone can trade day-1</li>
              <li>graduates to a <b>uniswap v4 pool with a custom hook</b>, LP locked forever</li>
              <li>the v4 hook routes trade fees to creators, holder rewards, and on-token buyback-burn</li>
              <li>creators earn on every trade for as long as the pool exists ~</li>
            </ul>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--anchor-soft)', lineHeight: 1.45 }}>
            right now we&apos;re still <b>polishing + testing</b> on robinhood mainnet. everything is
            real (real ETH, real contracts), so treat this as a preview and{' '}
            <b>don&apos;t launch anything u care about yet</b>. we&apos;ll announce when we&apos;re open ✿
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <a
              href="/docs"
              onClick={dismiss}
              className="uru-btn"
              style={{ padding: '6px 12px', fontSize: 12, textDecoration: 'none' }}
            >
              read the docs
            </a>
            <button
              type="button"
              onClick={dismiss}
              className="uru-btn uru-btn-primary"
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              got it ~
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
