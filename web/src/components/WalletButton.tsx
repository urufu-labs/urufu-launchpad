'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors[0];

  // Wagmi's connection state is client-only — the SSR render always shows disconnected,
  // but the client rehydrates with the persisted account. Rendering the account branch
  // during SSR causes a hydration mismatch. Gate on a post-mount flag so the first client
  // paint matches the server output; wagmi then re-renders us into the connected state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (mounted && isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title="click to disconnect ~~"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          background: 'var(--cream-deep)',
          color: 'var(--anchor)',
          border: '1.5px solid var(--anchor)',
          boxShadow: '2px 2px 0 var(--anchor)',
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          borderRadius: 4,
          lineHeight: 1.1,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: 'var(--mint)',
            border: '1px solid var(--anchor)',
            display: 'inline-block',
          }}
        />
        {short(address)}
      </button>
    );
  }

  const disabled = !mounted || isPending || !injected;
  return (
    <button
      type="button"
      onClick={() => injected && connect({ connector: injected })}
      disabled={disabled}
      className="uru-btn uru-btn-primary"
      style={{
        padding: '5px 12px',
        fontSize: 12,
        opacity: disabled ? 0.55 : undefined,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {isPending ? 'connecting..' : (
        <>
          <span aria-hidden style={{ marginRight: 4 }}>✿</span>
          connect wallet
        </>
      )}
    </button>
  );
}
