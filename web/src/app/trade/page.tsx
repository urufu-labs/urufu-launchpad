'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAddress, formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { MOCK_LAUNCHES, mockProgressPct } from '@/lib/mockLaunches';

/// Trade index — landing/search page. There's no real indexer yet, so the discovery pattern
/// is: paste a launched token's address to jump into its trade page. Once Ponder is wired,
/// this page grows a live "trending / new / graduated" feed like pump.fun's front page.
export default function TradeIndex() {
  const [addr, setAddr] = useState('');
  const router = useRouter();
  const valid = isAddress(addr);

  return (
    <div className="mx-auto max-w-5xl px-3 sm:px-4 py-4">
      {/* ================================================================
          COMPACT HEADER — mascot + title on one row
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '12px 18px',
          marginBottom: 10,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Mascot size={44} mood="happy" className="uru-idle-bob" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="uru-eyebrow" style={{ marginBottom: 2 }}>✦ trading floor</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1 }}>find a token</h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              取引
            </span>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
              · paste an address or pick from below
            </span>
          </div>
        </div>
        <Link
          href="/discover"
          className="uru-btn"
          style={{ padding: '5px 12px', fontSize: 12 }}
        >
          browse all
        </Link>
      </section>

      {/* ================================================================
          ADDRESS INPUT — the paste bar
          ================================================================ */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) router.push(`/trade/${addr}`);
        }}
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 14,
          alignItems: 'stretch',
          flexWrap: 'wrap',
        }}
      >
        <input
          className="uru-input"
          value={addr}
          onChange={(e) => setAddr(e.target.value.trim())}
          placeholder="0x… paste a launched token address"
          style={{ flex: 1, minWidth: 260, fontFamily: 'var(--font-pixel), monospace', fontSize: 12 }}
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
            padding: '6px 18px',
          }}
        >
          open trade page <span className="uru-arrow">→</span>
        </button>
      </form>

      {/* ================================================================
          PREVIEW LAUNCHES — dense card grid
          ================================================================ */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="uru-h1" style={{ fontSize: 18 }}>preview launches</span>
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
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-4">
        {MOCK_LAUNCHES.slice(0, 6).map((l) => (
          <Link
            key={l.address}
            href={`/trade/${l.address}`}
            className="uru-shell-tight uru-launch-card"
            style={{
              padding: 10,
              display: 'flex',
              gap: 10,
              textDecoration: 'none',
              color: 'inherit',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                border: '1.5px solid var(--anchor)',
                background: l.logoBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                flexShrink: 0,
              }}
            >
              {l.logoEmoji}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {l.name}
                </div>
                <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                  ${l.ticker}
                </div>
              </div>
              <div
                style={{
                  marginTop: 3,
                  height: 6,
                  background: 'var(--cream-deep)',
                  border: '1.5px solid var(--anchor)',
                }}
              >
                <div
                  style={{
                    width: `${mockProgressPct(l)}%`,
                    height: '100%',
                    background: l.graduated ? 'var(--mint-hot)' : 'var(--pink-hot)',
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
                {Number(formatEther(l.ethReserve)).toFixed(3)} / {Number(formatEther(l.graduationTargetEth)).toFixed(1)} Ξ
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* ================================================================
          HOW IT WORKS — collapsed to a slim strip below the fold
          ================================================================ */}
      <details className="uru-shell-tight" style={{ padding: 12 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontWeight: 700,
            fontSize: 13,
            listStyle: 'none',
          }}
        >
          ❀ how trading works
        </summary>
        <ol style={{ margin: '8px 0 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.65 }}>
          <li>
            <b>launch a token</b> in the{' '}
            <Link href="/create" style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
              shop
            </Link>{' '}
            with any base + modules stack.
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
