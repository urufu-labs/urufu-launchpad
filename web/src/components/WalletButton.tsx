'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

import { Menu } from '@/components/ui/Menu';
import { IconChevron, IconCopy, IconLogout, IconUser, IconFeed } from '@/components/shell/icons';
import styles from '@/components/shell/shell.module.css';

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// Deterministic two-tone avatar from the address so a wallet is recognizable at a glance.
function avatarStyle(address: string): React.CSSProperties {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = (h1 + 60 + (parseInt(address.slice(6, 8), 16) % 120)) % 360;
  return { background: `linear-gradient(135deg, hsl(${h1} 70% 60%), hsl(${h2} 70% 50%))` };
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors[0];
  const [copied, setCopied] = useState(false);

  // Wagmi's connection state is client-only — the SSR render always shows disconnected,
  // but the client rehydrates with the persisted account. Rendering the account branch
  // during SSR causes a hydration mismatch. Gate on a post-mount flag so the first client
  // paint matches the server output; wagmi then re-renders us into the connected state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) {
    return (
      <button type="button" className={styles.connect}>
        Connect wallet
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <Menu
        label="Wallet"
        width={230}
        trigger={(open) => (
          <button type="button" className={styles.pill} aria-haspopup="menu" aria-expanded={open}>
            <span className={styles.avatar} style={avatarStyle(address)} aria-hidden />
            <span className={styles.mono}>{short(address)}</span>
            <IconChevron />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="ui-menu-label">Connected</div>
            <Link href={`/profile/${address}`} className="ui-menu-item" onClick={close}>
              <IconUser /> Profile
            </Link>
            <Link href="/feed" className="ui-menu-item" onClick={close}>
              <IconFeed /> Feed
            </Link>
            <button
              type="button"
              className="ui-menu-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {}
              }}
            >
              <IconCopy /> {copied ? 'Copied' : 'Copy address'}
            </button>
            <div className="ui-menu-sep" />
            <button
              type="button"
              className="ui-menu-item"
              onClick={() => {
                close();
                disconnect();
              }}
            >
              <IconLogout /> Disconnect
            </button>
          </>
        )}
      </Menu>
    );
  }

  const disabled = isPending || !injected;
  return (
    <button
      type="button"
      onClick={() => injected && connect({ connector: injected })}
      disabled={disabled}
      className={styles.connect}
    >
      {isPending ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
