'use client';

/// Global token ticker — mounted once in the root layout so every page shows a live
/// scrolling strip of recent launches with their spot price. Clickable pills route to
/// each token's trade page.
///
/// Uses `useLaunchFeed`, the same hook home/discover/trade share. That means the ticker
/// picks up curve tokens whether they were installed atomically by Router.launch OR
/// added later via CurveFactory.createCurve() — the hook derives 'curve' vs 'direct'
/// from whether an indexer curves-table row exists, not from a possibly-stale
/// installedBondingCurve bit on the launches row.

import { useMemo } from 'react';
import Link from 'next/link';

import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { formatGweiPerToken } from '@/lib/priceFmt';
import { launchKind, type MockLaunch } from '@/lib/mockLaunches';
import { useLaunchFeed } from '@/lib/useLaunchFeed';

export function TokenTicker() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const chainLabel = CHAIN_LABELS[activeChain];

  // Ticker is curve-only — direct-mint tokens don't have a spot price to show.
  const feed = useLaunchFeed(activeChainId);
  const source = useMemo(
    () => feed.launches.filter((l) => launchKind(l) === 'curve'),
    [feed.launches],
  );

  const entries = useMemo(() => {
    if (source.length === 0) {
      return [
        { key: 'empty-1', node: <span>✿ no launches yet on {chainLabel} ~ launch the first ✿</span> },
        { key: 'empty-2', node: <span>❀ head to /create → tap tap launch ★</span> },
      ];
    }
    return source.slice(0, 20).map((l, i) => {
      const priceWei = spotPriceOf(l);
      const priceStr = priceWei > 0n ? `${formatGweiPerToken(priceWei)} gwei` : '—';
      return {
        key: `${l.address}-${i}`,
        node: (
          <Link
            href={`/trade/${l.address}`}
            style={{
              display: 'inline-flex',
              gap: 6,
              alignItems: 'center',
              color: 'var(--anchor)',
              textDecoration: 'none',
              padding: '1px 8px',
              borderLeft: `2px solid ${l.graduated ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}`,
            }}
          >
            <span style={{ fontSize: 13 }}>{l.logoEmoji}</span>
            <span style={{ fontWeight: 700 }}>${l.ticker}</span>
            <span style={{ color: 'var(--anchor-soft)' }}>{priceStr}</span>
            {l.graduated && <span style={{ color: 'var(--mint-hot,#2b8a3e)', fontWeight: 700 }}>✿ grad</span>}
          </Link>
        ),
      };
    });
  }, [source, chainLabel]);

  // Duplicate so translateX(-50%) wraps seamlessly.
  const loop = [...entries, ...entries];

  return (
    <div className="uru-marquee-wrap" aria-hidden>
      <div className="uru-marquee">
        <div className="uru-marquee-track">
          {loop.map((e, i) => (
            <span key={`${e.key}-${i}`}>{e.node}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function spotPriceOf(l: MockLaunch): bigint {
  const num = (l.ethReserve + l.virtualEthReserve) * 10n ** 18n;
  const den = l.tokenReserve + l.virtualTokenReserve;
  return den > 0n ? num / den : 0n;
}
