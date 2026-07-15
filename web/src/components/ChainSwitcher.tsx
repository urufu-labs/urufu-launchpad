'use client';

/// Kawaii chain switcher for the header. Reflects the connected wallet's chain when it's on
/// a supported network; when the wallet is disconnected or on an unsupported chain, falls
/// back to DEFAULT_CHAIN (Sepolia) so the /discover feed always shows *something*.
///
/// Clicking a chip either dispatches wagmi.switchChain() (if a wallet is connected) or fires
/// a client-side event so unconnected pages can still filter to the picked chain via the
/// `activeChain` hook below.

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';

import { CHAINS_ENABLED, CHAIN_LABELS, CHAIN_META, DEFAULT_CHAIN, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID } from '@/lib/wagmi';

const STORAGE_KEY = 'urufu:activeChain';
const EVENT = 'urufu:activeChainChanged';

/// Broadcast the client-selected chain so listeners in other components pick it up without a
/// full page reload. Wagmi's switchChain updates automatically for connected wallets — this
/// covers the disconnected case.
function broadcastActiveChain(chain: ChainKey) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, chain);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: chain }));
}

/// Read the active chain, preferring the connected wallet's chain when it's supported, then
/// the last localStorage pick, then DEFAULT_CHAIN. Subscribes to both wagmi + the custom
/// event so all consumers stay in sync.
///
/// SSR-safety: server + first client render always return DEFAULT_CHAIN (Sepolia). Wallet
/// state + localStorage overrides only kick in AFTER useEffect fires. This is deliberate —
/// wagmi's `isConnected` and localStorage both differ between server (false / null) and
/// client (whatever the browser knows), which would hydrate-mismatch every consumer that
/// renders anything derived from the active chain (labels, emoji, links, filter state).
export function useActiveChain(): ChainKey {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const [override, setOverride] = useState<ChainKey | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY) as ChainKey | null;
    if (stored && CHAINS_ENABLED.includes(stored)) setOverride(stored);

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ChainKey>).detail;
      if (detail && CHAINS_ENABLED.includes(detail)) setOverride(detail);
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  if (!mounted) return DEFAULT_CHAIN;

  // Wallet-connected + on a supported chain wins.
  if (isConnected) {
    const key = CHAIN_ID_TO_KEY[chainId];
    if (key && CHAINS_ENABLED.includes(key)) return key;
  }
  return override ?? DEFAULT_CHAIN;
}

export function ChainSwitcher() {
  const active = useActiveChain();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const [open, setOpen] = useState(false);
  // Same hydration gate as WalletButton — wagmi's `isConnected` differs between SSR (false)
  // and post-hydration (whatever the wallet persisted), which would flip the button's title.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  const pick = (chain: ChainKey) => {
    broadcastActiveChain(chain);
    setOpen(false);
    if (isConnected) {
      const target = CHAIN_KEY_TO_ID[chain];
      if (target) switchChain({ chainId: target });
    }
  };

  const activeMeta = CHAIN_META[active];

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        title={mounted && isConnected ? `chain: ${CHAIN_LABELS[active]}` : 'chain (view-only until wallet connects)'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 9px',
          background: 'var(--cream-deep)',
          color: 'var(--anchor)',
          border: '1.5px solid var(--anchor)',
          boxShadow: '2px 2px 0 var(--anchor)',
          borderRadius: 4,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 11,
          fontWeight: 600,
          cursor: isPending ? 'wait' : 'pointer',
          lineHeight: 1.1,
        }}
      >
        <Image
          src={activeMeta.iconPath}
          alt=""
          width={14}
          height={14}
          aria-hidden
          style={{ display: 'block' }}
          unoptimized
        />
        <span>{CHAIN_LABELS[active]}</span>
        <span aria-hidden style={{ fontSize: 9, marginLeft: 2, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 100,
            display: 'grid',
            gap: 2,
            padding: 4,
            minWidth: 160,
            background: 'var(--cream)',
            border: '1.5px solid var(--anchor)',
            boxShadow: '3px 3px 0 var(--anchor)',
            borderRadius: 4,
          }}
        >
          {CHAINS_ENABLED.map((c) => {
            const isActive = c === active;
            const meta = CHAIN_META[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => pick(c)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  background: isActive ? 'var(--pink-warm)' : 'transparent',
                  border: 'none',
                  color: 'var(--anchor)',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 11,
                  fontWeight: isActive ? 700 : 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderRadius: 3,
                }}
              >
                <Image
                  src={meta.iconPath}
                  alt=""
                  width={16}
                  height={16}
                  aria-hidden
                  style={{ display: 'block' }}
                  unoptimized
                />
                <span>{CHAIN_LABELS[c]}</span>
                <span aria-hidden style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 10, opacity: 0.6 }}>{meta.jp}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
