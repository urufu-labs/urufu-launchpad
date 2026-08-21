'use client';

/// Header nav dropdown for the "✿ create" link — splits into "token" (the
/// existing /create ERC20 launchpad) and "nft" (new /create/nft route).
///
/// Behavior: hovering the trigger opens the menu; clicking the trigger
/// navigates to the token launcher (existing behavior preserved for muscle
/// memory) while a submenu offers the alternative. Menu closes on outside
/// click, Escape, or route change. The "nft" option greys out to "soon"
/// when NFT_LAUNCHES_ENABLED is false for the active chain.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NFT_LAUNCHES_ENABLED } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';

export function CreateNavDropdown() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const activeChain = useActiveChain();
  const nftEnabled = NFT_LAUNCHES_ENABLED[activeChain] === true;

  // Close on route change so the menu doesn't linger after a nav click.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        className="hover:underline"
        style={{
          color: 'var(--anchor)',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ✿ create ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 flex flex-col"
          style={{
            minWidth: 140,
            background: 'var(--cream)',
            border: '1.5px solid var(--anchor)',
            borderRadius: 8,
            padding: 6,
            gap: 4,
            zIndex: 60,
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 13,
            boxShadow: '2px 3px 0 rgba(0,0,0,0.08)',
          }}
        >
          <Link
            href="/create"
            role="menuitem"
            className="hover:underline"
            style={{ color: 'var(--anchor)', padding: '4px 8px', borderRadius: 4 }}
          >
            ✦ token
          </Link>
          {nftEnabled ? (
            <Link
              href="/create/nft"
              role="menuitem"
              className="hover:underline"
              style={{ color: 'var(--anchor)', padding: '4px 8px', borderRadius: 4 }}
            >
              ❁ nft
            </Link>
          ) : (
            <span
              role="menuitem"
              aria-disabled="true"
              style={{
                color: 'var(--anchor)',
                opacity: 0.45,
                padding: '4px 8px',
                cursor: 'not-allowed',
              }}
            >
              ❁ nft <span style={{ fontSize: 10 }}>soon ✧</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
