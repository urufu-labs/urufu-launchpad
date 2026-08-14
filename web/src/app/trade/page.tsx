'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAddress, formatEther } from 'viem';

import { mockProgressPct, launchKind, type MockLaunch } from '@/lib/mockLaunches';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { useMockDataMode } from '@/lib/mockDataMode';
import { loadMetadata, safeBackgroundImage } from '@/lib/metadata';
import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { sizeForName } from '@/lib/nameSize';
import { useLastTradeMap } from '@/lib/useTradeFlash';
import styles from './trade-entry.module.css';

/// Trade index — landing/search page. There's no real indexer yet, so the discovery pattern
/// is: paste a launched token's address to jump into its trade page. Once Ponder is wired,
/// this page grows a live "trending / new / graduated" feed like pump.fun's front page.
export default function TradeIndex() {
  const [addr, setAddr] = useState('');
  const router = useRouter();
  const valid = isAddress(addr);
  const activeChain = useActiveChain();
  const mockData = useMockDataMode();
  const feed = useLaunchFeed(CHAIN_KEY_TO_ID[activeChain]);
  // /trade is for bonding-curve trading — filter direct-mint tokens out; they show up on
  // home + discover instead. Sort so tokens with a recent trade bubble to the top; ties
  // fall back to launch recency so new curves aren't stuck below silent old ones.
  const lastTradeMap = useLastTradeMap();
  const feedLaunches = useMemo(() => {
    return feed.launches
      .filter((l) => launchKind(l) === 'curve')
      .slice()
      .sort((a, b) => {
        const aTs = lastTradeMap.get(a.address.toLowerCase()) ?? 0;
        const bTs = lastTradeMap.get(b.address.toLowerCase()) ?? 0;
        if (aTs !== bTs) return bTs - aTs;
        return b.launchedAt - a.launchedAt;
      })
      .slice(0, 6);
  }, [feed.launches, lastTradeMap]);

  return (
    <div className={styles.entryPage}>
      <header className={styles.marketHeader}>
        <div>
          <div className="uru-eyebrow">trade</div>
          <h1 className={`uru-h1 ${styles.title}`}>market lookup</h1>
        </div>
        <div className={styles.marketMeta}>
          <span>{mockData.enabled ? 'demo data' : activeChain}</span>
          <span>{feedLaunches.length} bonding curves</span>
          <Link href="/discover">all launches »</Link>
        </div>
      </header>

      <section className={`uru-shell-tight ${styles.lookupPanel}`}>
        <div className={styles.lookupCopy}>
          <div className={styles.lookupTitle}>open token terminal</div>
          <p className={styles.subtitle}>
            Paste a launched ERC-20 address, or pick a bonding curve from the market list.
          </p>
        </div>
        <form
          className={styles.lookupForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) router.push(`/trade/${addr}`);
          }}
        >
          <input
            className={`uru-input ${styles.lookupInput}`}
            value={addr}
            onChange={(e) => setAddr(e.target.value.trim())}
            placeholder="0x... paste a launched ERC-20 token address"
            autoFocus
          />
          <button
            type="submit"
            disabled={!valid}
            className="uru-btn uru-btn-primary"
            style={{
              justifyContent: 'center',
              opacity: valid ? 1 : 0.5,
              cursor: valid ? 'pointer' : 'not-allowed',
              padding: '8px 18px',
            }}
          >
            open terminal <span className="uru-arrow">→</span>
          </button>
        </form>
      </section>

      {/* ================================================================
          PREVIEW LAUNCHES — active chain card grid
          ================================================================ */}
      <div className={styles.sectionHeader}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="uru-h1" style={{ fontSize: 18 }}>active bonding curves</span>
          <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 12, color: 'var(--anchor-soft)' }}>
            新着
          </span>
        </div>
        <Link
          href="/discover"
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 11,
            color: 'var(--link-blue)',
            textDecoration: 'underline',
          }}
        >
          all launches »
        </Link>
      </div>
      <div className={styles.launchGrid}>
        {feedLaunches.map((l) => (
          <TradeTile key={l.address} launch={l} />
        ))}
      </div>
      {feedLaunches.length === 0 && (
        <div className={`uru-shell-tight ${styles.emptyState}`}>
          No active bonding curves on this chain yet. Paste a token address above, browse all launches, or create the first ERC-20 token.
        </div>
      )}

      {/* ================================================================
          HOW IT WORKS — collapsed to a slim strip below the fold
          ================================================================ */}
      <details className={`uru-shell-tight ${styles.helpPanel}`}>
        <summary
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontWeight: 700,
            fontSize: 13,
            listStyle: 'none',
          }}
        >
          how ERC-20 trading works
        </summary>
        <ol style={{ margin: '8px 0 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.65 }}>
          <li>
            <b>launch an ERC-20</b> in the{' '}
            <Link href="/create" style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
              token creation page
            </Link>{' '}
            with art, ticker, socials, and curve settings.
          </li>
          <li>
            <b>create the curve:</b> once the CurveFactory is deployed, call{' '}
            <code style={{ fontFamily: 'var(--font-pixel), monospace' }}>curveFactory.createCurve(tokenAddress)</code>{' '}
            — this pulls the curve supply from the launcher and initializes trading.
          </li>
          <li>
            <b>trade:</b> paste the token address above or open{' '}
            <code style={{ fontFamily: 'var(--font-pixel), monospace' }}>/trade/&lt;tokenAddress&gt;</code>.
          </li>
          <li>
            <b>graduate:</b> once the curve hits its ETH target, it auto-graduates onto uniswap v4.
          </li>
        </ol>
      </details>
    </div>
  );
}

function TradeTile({ launch }: { launch: MockLaunch }) {
  // Prefer indexer-supplied imageUrl (shared), fall back to browser local.
  const [localImage, setLocalImage] = useState<string | undefined>();
  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);
  const logoDataUrl = launch.imageUrl ?? localImage;
  return (
    <Link
      href={`/trade/${launch.address}`}
      className={`uru-shell-tight uru-launch-card ${styles.tile}`}
    >
      <div
        className={styles.tileMark}
        style={{
          background: safeBackgroundImage(logoDataUrl, launch.logoBg),
        }}
      >
        {!logoDataUrl && launch.ticker.slice(0, 3)}
      </div>
      <div className={styles.tileBody}>
        <div className={styles.tileTitle}>
          <div className="uru-h2" style={{ fontSize: sizeForName(launch.name, 13), lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {launch.name}
          </div>
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
            ${launch.ticker}
          </div>
        </div>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressFill}
            style={{
              width: `${mockProgressPct(launch)}%`,
              background: launch.graduated ? 'var(--mint-hot)' : undefined,
            }}
          />
        </div>
        <div
          style={{
            marginTop: 3,
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            color: 'var(--anchor-soft)',
          }}
        >
          {Number(formatEther(launch.ethReserve)).toFixed(3)} / {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} Ξ
        </div>
      </div>
    </Link>
  );
}
