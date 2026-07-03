'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';
import { mocksForChain, mockMarketCapEth, mockProgressPct, type MockLaunch } from '@/lib/mockLaunches';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';

export default function HomePage() {
  const activeChain = useActiveChain();
  const chainId = CHAIN_KEY_TO_ID[activeChain];
  // Home feed picks 4 tiles from the active chain: 2 newest, 2 near-graduation. Same
  // MockLaunch shape used on /discover so once the indexer wires in, swapping the source is
  // a one-line change here.
  const { newest, nearGrad } = useMemo(() => {
    const chainMocks = mocksForChain(chainId);
    const sortedNewest = chainMocks.slice().sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 2);
    const sortedNear = chainMocks
      .filter((l) => !l.graduated)
      .sort((a, b) => mockProgressPct(b) - mockProgressPct(a))
      .slice(0, 2);
    return { newest: sortedNewest, nearGrad: sortedNear };
  }, [chainId]);

  return (
    <>
      {/* thin marquee ribbon */}
      <div className="uru-marquee-wrap">
        <div className="uru-marquee">
          <div className="uru-marquee-track">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i}>
                ✿ urufu labs ✿ launch a token in one click ❀ liquidity locked forever ★{' '}
                <span style={{ fontFamily: 'var(--font-jp), monospace' }}>好き好き大好き</span> ❁ trades reward gemu holders ~
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4">
        {/* =====================================================================
            HERO
            ===================================================================== */}
        <header className="relative py-14 sm:py-20 text-center">
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 18,
              marginBottom: 8,
            }}
          >
            <Mascot size={100} mood="happy" className="uru-idle-bob" />
            <div
              className="uru-h1"
              style={{
                fontSize: 'clamp(34px, 5vw, 48px)',
                lineHeight: 1,
                letterSpacing: '-1px',
                textAlign: 'left',
              }}
            >
              urufu<span style={{ color: 'var(--pink-hot)' }}>labs</span>
              <sup
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 12,
                  marginLeft: 3,
                  color: 'var(--anchor-soft)',
                }}
              >
                ®
              </sup>
            </div>
          </div>
          <h1
            className="uru-h1 mt-4"
            style={{ fontSize: 'clamp(40px, 7vw, 62px)', lineHeight: 1.05 }}
          >
            a launchpad <span style={{ color: 'var(--pink-hot)' }}>u</span> can compose
          </h1>
          <p
            className="mt-4"
            style={{
              fontFamily: 'var(--font-round), Klee One, cursive',
              fontSize: 16,
              color: 'var(--anchor-soft)',
              maxWidth: 480,
              margin: '16px auto 0',
              lineHeight: 1.5,
            }}
          >
            every other launchpad hardcodes one shape of token. urufu lets u pick a base, drag
            audited modules into a cart, and deploy real solidity ~~ not a wrapper (◕‿◕✿)
          </p>
          <div className="flex flex-wrap gap-3 mt-7 justify-center">
            <Link href="/create" className="uru-btn uru-btn-primary">
              launch a token <span className="uru-arrow">→</span>
            </Link>
            <Link href="/catalog" className="uru-btn uru-btn-mint">
              see the shelf
            </Link>
          </div>
        </header>

        {/* =====================================================================
            WHAT'S UNDER THE HOOD — one prose shell + inline number chips
            ===================================================================== */}
        <section className="pb-10">
          <div className="uru-shell" style={{ padding: 24 }}>
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>✿ how it works</div>
            <h2 className="uru-h1" style={{ fontSize: 28, lineHeight: 1.15 }}>
              launch a token in one click.
            </h2>
            <p style={{ marginTop: 10, lineHeight: 1.65, maxWidth: 640 }}>
              pick what u want, hit launch, done — no code, no team, no waiting. once it takes
              off, the liquidity locks forever so no one can pull the rug. every trade rewards{' '}
              <b>urufu gemu</b> nft holders, and holding <b>URU</b>{' '}or an urufu gemu nft gets u
              a discount when u launch. &nbsp;
              <Link href="/catalog" style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
                see the shelf »
              </Link>
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
              <NumberChip n="3" label="bases" jp="型" />
              <NumberChip n="23" label="modules shipped" jp="出来" />
              <NumberChip n="5" label="v4 hooks" jp="鉤" />
              <NumberChip n="3" label="planned (B20)" jp="予定" />
              <NumberChip n="37" label="curated combos" jp="定食" />
            </div>
          </div>
        </section>

        {/* =====================================================================
            NEW + TOP LAUNCHES — feed placeholders (pump.fun-style beat)
            ===================================================================== */}
        <section className="pb-10">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="uru-h1" style={{ fontSize: 24, lineHeight: 1 }}>the feed</span>
              <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 18, color: 'var(--anchor-soft)' }}>
                新着
              </span>
            </div>
            <Link
              href="/discover"
              style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--link-blue)', textDecoration: 'underline' }}
            >
              all launches »
            </Link>
          </div>
          <div style={{ display: 'grid', gap: 16 }}>
            {/* NEW column */}
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <div className="uru-eyebrow">✿ freshly launched</div>
                <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>preview data</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {newest.map((l) => (<HomeFeedCard key={l.address} launch={l} tag="new" />))}
              </div>
            </div>

            {/* NEAR GRADUATION column */}
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <div className="uru-eyebrow">❀ near graduation</div>
                <Link href="/discover" style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--link-blue)', textDecoration: 'underline' }}>
                  see everything »
                </Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {nearGrad.map((l) => (<HomeFeedCard key={l.address} launch={l} tag="grad" />))}
              </div>
            </div>
          </div>
        </section>

        {/* =====================================================================
            HOW IT WORKS — 3 tight steps
            ===================================================================== */}
        <section className="pb-10">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <span className="uru-h1" style={{ fontSize: 24, lineHeight: 1 }}>how it works</span>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 18, color: 'var(--anchor-soft)' }}>
              流れ
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StepCard n="01" title="pick a base" body="erc-20 · 721a · 1155" tape="pink" />
            <StepCard n="02" title="drag modules" body="audited fragments in ur cart" tape="mint" />
            <StepCard n="03" title="launch" body="one tx · address on etherscan" tape="mizuiro" />
          </div>
        </section>

        {/* =====================================================================
            THE FLYWHEEL — economic story (right after how-it-works)
            ===================================================================== */}
        <section className="pb-10">
          <div className="uru-shell" style={{ padding: 20, background: 'var(--cream-deep)' }}>
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>✿ the flywheel</div>
            <h2 className="uru-h1" style={{ fontSize: 24, lineHeight: 1.2 }}>
              value routes back to <span style={{ color: 'var(--pink-hot)' }}>URU</span> + <span style={{ color: 'var(--pink-hot)' }}>urufu gemu NFT</span> holders
              <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 16, marginLeft: 8 }}>
                循環
              </span>
            </h2>
            <p style={{ marginTop: 10, lineHeight: 1.6, fontSize: 14 }}>
              every launch fee + curve trade + post-graduation swap feeds a <b>FeeSplitter</b>{' '}
              that routes ETH three ways. hold URU or an urufu gemu NFT, get paid every time
              somebody launches ~~
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <FlowStop tag="URU buyback" jp="買戻" pct="40%" note="ETH → URU → urufu gemu NFT holders" bg="var(--pink-warm)" />
              <FlowStop tag="NFT revenue" jp="配当" pct="35%" note="direct ETH to urufu gemu NFT holders" bg="var(--mint)" />
              <FlowStop tag="Treasury" jp="金庫" pct="25%" note="platform + infra + audits" bg="var(--cream-deep)" />
            </div>

            <div style={{ marginTop: 16, padding: 12, background: 'var(--yolk)', border: '1.5px solid var(--anchor)' }}>
              <div className="uru-eyebrow" style={{ marginBottom: 4 }}>❀ launch-fee discount tiers</div>
              <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
                <li>hold ≥ 1 urufu gemu NFT → <b>20% off</b> every launch fee</li>
                <li>hold ≥ 100,000 URU → <b>40% off</b></li>
                <li>hold both → <b>50% off</b> (capped)</li>
              </ul>
            </div>

            <p style={{ marginTop: 12, fontSize: 11, color: 'var(--anchor-soft)', fontStyle: 'italic' }}>
              creators earn on their tokens post-graduation via v4 hooks (real market cap
              threshold gates it). splits are timelock-gated (2-day cooldown) and
              multisig-controlled post-launch ~
            </p>
          </div>
        </section>

        {/* =====================================================================
            SHOPKEEPER
            ===================================================================== */}
        <section className="pb-10">
          <div className="uru-shell" style={{ padding: 20, maxWidth: 640, margin: '0 auto' }}>
            <div className="flex items-center gap-4">
              <Mascot size={56} mood="happy" />
              <div className="uru-bubble" style={{ fontSize: 15 }}>
                every launchpad hardcodes one shape. urufu doesn't. ~~
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 10,
                    color: 'var(--anchor-soft)',
                  }}
                >
                  — urufu &lt;3
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =====================================================================
            CURRENTLY + FRIENDS
            ===================================================================== */}
        <section className="pb-12 grid gap-4 sm:grid-cols-2">
          <div className="uru-shell" style={{ padding: 14 }}>
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ currently</div>
            <ul className="uru-list-flower" style={{ fontSize: 12, lineHeight: 1.7 }}>
              <li>testing — sepolia</li>
              <li>listening — Perfume · Polyrhythm</li>
              <li>mood — 好き 好き 大好き</li>
            </ul>
          </div>
          <div className="uru-shell" style={{ padding: 14 }}>
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❀ friends</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <span className="uru-88 uru-88-pink"><strong>urufu</strong>labs</span>
              <span className="uru-88 uru-88-mint">chibi-<strong>wolf</strong></span>
              <span className="uru-88 uru-88-mizuiro">solady<strong>.gg</strong></span>
              <span className="uru-88">forge<strong>&hearts;</strong></span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

// ============================================================================
// small components
// ============================================================================

function NumberChip({ n, label, jp }: { n: string; label: string; jp: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '4px 10px',
        background: 'var(--cream-deep)',
        border: '1.5px solid var(--anchor)',
        borderRadius: 999,
        boxShadow: '2px 2px 0 var(--anchor)',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 12,
      }}
    >
      <b style={{ color: 'var(--pink-hot)', fontSize: 14 }}>{n}</b>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 12 }}>
        {jp}
      </span>
    </span>
  );
}

function FlowStop({ tag, jp, pct, note, bg }: { tag: string; jp: string; pct: string; note: string; bg: string }) {
  return (
    <div
      style={{
        padding: 12,
        background: bg,
        border: '1.5px solid var(--anchor)',
        boxShadow: '2px 2px 0 var(--anchor)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span className="uru-h2" style={{ fontSize: 14, lineHeight: 1 }}>{tag}</span>
        <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>{jp}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 22, fontWeight: 700, color: 'var(--pink-hot)', lineHeight: 1 }}>
        {pct}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--anchor-soft)', lineHeight: 1.35 }}>
        {note}
      </div>
    </div>
  );
}

function HomeFeedCard({ launch, tag }: { launch: MockLaunch; tag: 'new' | 'grad' }) {
  const progress = mockProgressPct(launch);
  const mcap = mockMarketCapEth(launch);
  return (
    <Link
      href={`/trade/${launch.address}`}
      className="uru-shell relative"
      style={{
        padding: 12,
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span
        className={`uru-stamp ${tag === 'new' ? 'uru-stamp-mint' : 'uru-stamp-mizuiro'}`}
        style={{ position: 'absolute', top: -10, right: 12 }}
      >
        {tag === 'new' ? 'new' : `${progress.toFixed(0)}%`}
      </span>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            border: '1.5px solid var(--anchor)',
            boxShadow: '2px 2px 0 var(--anchor)',
            background: launch.logoBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          {launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {launch.name}
            </div>
            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
              ${launch.ticker}
            </div>
          </div>
          <div style={{ marginTop: 3, height: 6, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: launch.graduated ? 'var(--mint)' : 'var(--pink-hot)' }} />
          </div>
          <div style={{ marginTop: 3, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)' }}>
            <span>mcap {Number(formatEther(mcap)).toFixed(2)} ETH</span>
            <span>{launch.trades.length} trades</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function FeedEmpty({
  tag,
  mood,
  headline,
  body,
  cta,
}: {
  tag: 'new' | 'top';
  mood: 'sleepy' | 'confused' | 'happy';
  headline: string;
  body: string;
  cta: { href: string; text: string };
}) {
  return (
    <div className="uru-shell relative" style={{ padding: 22, textAlign: 'center' }}>
      <span
        className={`uru-stamp ${tag === 'new' ? 'uru-stamp-mint' : 'uru-stamp-mizuiro'}`}
        style={{ position: 'absolute', top: -10, left: 16 }}
      >
        {tag}
      </span>
      <Mascot size={54} mood={mood} className="uru-idle-bob" />
      <div className="uru-h2" style={{ fontSize: 14, marginTop: 8 }}>
        {headline}
      </div>
      <p
        style={{
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 12,
          color: 'var(--anchor-soft)',
          marginTop: 4,
          lineHeight: 1.45,
        }}
      >
        {body}
      </p>
      <Link
        href={cta.href}
        style={{
          display: 'inline-block',
          marginTop: 12,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 11,
          color: 'var(--link-blue)',
          textDecoration: 'underline',
        }}
      >
        {cta.text}
      </Link>
    </div>
  );
}

function StepCard({
  n,
  title,
  body,
  tape,
}: {
  n: string;
  title: string;
  body: string;
  tape: 'pink' | 'mint' | 'mizuiro';
}) {
  const tapeClass = tape === 'mint' ? 'uru-tape-mint' : tape === 'mizuiro' ? 'uru-tape-mizuiro' : '';
  return (
    <div className="uru-shell relative" style={{ padding: 20, textAlign: 'center' }}>
      <span
        className={`uru-tape ${tapeClass}`}
        style={{ width: 68, height: 14, top: -6, left: '50%', marginLeft: -34 }}
      />
      <div className="uru-h1" style={{ fontSize: 38, color: 'var(--pink-hot)', lineHeight: 1 }}>
        {n}
      </div>
      <div className="uru-h2" style={{ fontSize: 14, marginTop: 8 }}>
        {title}
      </div>
      <div
        style={{
          marginTop: 4,
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 12,
          color: 'var(--anchor-soft)',
        }}
      >
        {body}
      </div>
    </div>
  );
}
