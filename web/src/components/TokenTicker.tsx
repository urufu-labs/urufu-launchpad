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

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';
import { launchKind, mockSpotPriceWei, type MockLaunch } from '@/lib/mockLaunches';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { startTradeFlashPolling, tradeFlashClass, useTradeFlash } from '@/lib/useTradeFlash';
import { loadMetadata, safeBackgroundImage } from '@/lib/metadata';
import styles from '@/components/shell/shell.module.css';

export function TokenTicker() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const chainLabel = CHAIN_LABELS[activeChain];
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();

  // Kick the shared trade-flash poller here since TokenTicker mounts once
  // globally in the root layout — every page inherits the poller regardless
  // of which page-specific card grids come and go.
  useEffect(() => {
    startTradeFlashPolling(activeChainId);
  }, [activeChainId]);

  // Ticker is curve-only — direct-mint tokens don't have a spot price to show.
  const feed = useLaunchFeed(activeChainId);
  const source = useMemo(
    () => feed.launches.filter((l) => launchKind(l) === 'curve'),
    [feed.launches],
  );

  const entries = useMemo(
    () =>
      source.slice(0, 20).map((l, i) => {
        // Graduated-aware price: v4 pool sqrtPriceX96 post-grad, curve virtual
        // reserves pre-grad. Same numbers the trade + discover pages show, and
        // formatPrice respects the USD/ETH header toggle.
        const priceWei = mockSpotPriceWei(l);
        const priceStr = priceWei > 0n ? formatPrice(priceWei, unit, ethUsd) : '–';
        return { key: `${l.address}-${i}`, launch: l, priceStr };
      }),
    [source, unit, ethUsd],
  );

  // Nothing to scroll yet: render nothing rather than filler text.
  if (entries.length === 0) return null;

  // Duplicate so translateX(-50%) wraps seamlessly.
  const loop = [...entries, ...entries];

  return (
    <div className={styles.ticker} aria-label={`Live tokens on ${chainLabel}`}>
      <div className={styles.tickerTrack}>
        {loop.map((e, i) => (
          <TickerPill key={`${e.key}-${i}`} launch={e.launch} priceStr={e.priceStr} />
        ))}
      </div>
    </div>
  );
}

/// Individual ticker pill. Extracted so it can subscribe to per-token flash
/// state via the shared bus without forcing the parent to re-render every
/// pill on every flash event. Renders the token's own artwork (from the
/// indexer's `imageUrl` or browser-local metadata if the indexer hasn't
/// caught up yet), falling back to `logoBg` + `logoEmoji` when neither is
/// available — same precedence LaunchTile and LaunchCard use.
function TickerPill({
  launch,
  priceStr,
}: {
  launch: MockLaunch;
  priceStr: string;
}) {
  const flash = useTradeFlash(launch.address);
  const [localImage, setLocalImage] = useState<string | undefined>();
  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);
  const image = launch.imageUrl ?? localImage;
  return (
    <Link href={`/trade/${launch.address}`} className={`${styles.tickItem} ${tradeFlashClass(flash)}`}>
      <span aria-hidden className={styles.tickImg} style={{ background: safeBackgroundImage(image) }}>
        {!image && launch.logoEmoji}
      </span>
      <span className={styles.tickSym}>${launch.ticker}</span>
      <span className={styles.tickPrice}>{priceStr}</span>
      {launch.graduated && <span className={styles.tickGrad}>graduated</span>}
    </Link>
  );
}
