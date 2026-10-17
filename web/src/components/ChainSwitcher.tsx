'use client';

/// Chain switcher for the header. Reflects the connected wallet's chain when it's on
/// a supported network; when the wallet is disconnected or on an unsupported chain, falls
/// back to DEFAULT_CHAIN (Sepolia) so the /discover feed always shows *something*.
///
/// Clicking a chip either dispatches wagmi.switchChain() (if a wallet is connected) or fires
/// a client-side event so unconnected pages can still filter to the picked chain via the
/// `activeChain` hook below.

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';

import { CHAINS_ENABLED, CHAINS_COMING_SOON, CHAIN_LABELS, CHAIN_META, DEFAULT_CHAIN, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { IconChevron } from '@/components/shell/icons';
import styles from '@/components/shell/shell.module.css';

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
    <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className={styles.pill}
        aria-haspopup="menu"
        aria-expanded={open}
        title={mounted && isConnected ? `Chain: ${CHAIN_LABELS[active]}` : 'Chain (view only until a wallet connects)'}
      >
        <Image src={activeMeta.iconPath} alt="" width={16} height={16} aria-hidden style={{ display: 'block', borderRadius: 4 }} unoptimized />
        <span>{CHAIN_LABELS[active]}</span>
        <IconChevron />
      </button>

      {open && (
        <div role="menu" aria-label="Chain" className="ui-menu-panel" data-align="end" style={{ width: 210 }}>
          <div className="ui-menu-label">Chain</div>
          {CHAINS_ENABLED.map((c) => {
            const meta = CHAIN_META[c];
            return (
              <button
                key={c}
                type="button"
                role="menuitemradio"
                aria-checked={c === active}
                className="ui-menu-item"
                data-active={c === active ? 'true' : undefined}
                onClick={() => pick(c)}
              >
                <Image src={meta.iconPath} alt="" width={18} height={18} aria-hidden style={{ display: 'block', borderRadius: 4 }} unoptimized />
                {CHAIN_LABELS[c]}
                {c === active && <span className={styles.dot} style={{ marginLeft: 'auto' }} aria-hidden />}
              </button>
            );
          })}
          {CHAINS_COMING_SOON.length > 0 && <div className="ui-menu-sep" />}
          {CHAINS_COMING_SOON.map((c) => {
            const meta = CHAIN_META[c];
            return (
              <span key={c} role="menuitem" aria-disabled="true" className="ui-menu-item" title={`${CHAIN_LABELS[c]} is coming soon`}>
                <Image src={meta.iconPath} alt="" width={18} height={18} aria-hidden style={{ display: 'block', borderRadius: 4, opacity: 0.4 }} unoptimized />
                {CHAIN_LABELS[c]}
                <small>soon</small>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
