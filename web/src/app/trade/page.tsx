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
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div style={{ textAlign: 'center' }}>
        <Mascot size={80} mood="happy" className="uru-idle-bob" />
        <div className="uru-eyebrow" style={{ marginTop: 8 }}>the trading floor</div>
        <h1 className="uru-h1" style={{ fontSize: 40, lineHeight: 1.1 }}>
          find a token
          <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 22, marginLeft: 8 }}>
            取引
          </span>
        </h1>
        <p style={{ marginTop: 8, color: 'var(--anchor-soft)', maxWidth: 480, margin: '8px auto 0', fontFamily: 'var(--font-round), Klee One, cursive' }}>
          paste an urufu-launched token address to trade against its bonding curve ✿ each
          curve auto-graduates to uniswap v4 when it hits its ETH target
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) router.push(`/trade/${addr}`);
        }}
        style={{ marginTop: 32, display: 'grid', gap: 8 }}
      >
        <label style={{ display: 'block' }}>
          <span className="uru-eyebrow">token address</span>
          <input
            className="uru-input"
            value={addr}
            onChange={(e) => setAddr(e.target.value.trim())}
            placeholder="0x…"
            style={{ marginTop: 4, fontFamily: 'var(--font-pixel), monospace' }}
            autoFocus
          />
        </label>
        <button
          type="submit"
          disabled={!valid}
          className="uru-btn uru-btn-primary"
          style={{ justifyContent: 'center', opacity: valid ? 1 : 0.5, cursor: valid ? 'pointer' : 'not-allowed' }}
        >
          ✿ open trade page →
        </button>
      </form>

      <div className="uru-shell" style={{ padding: 16, marginTop: 32 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❀ how it works</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
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
            <b>graduate:</b> once the curve hits its ETH target, it auto-graduates.{' '}
            <span style={{ color: 'var(--anchor-soft)' }}>v4 pool creation ships in phase 3~</span>
          </li>
        </ol>
      </div>

      <div style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="uru-eyebrow">✿ preview launches</div>
          <Link href="/discover" style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--link-blue)', textDecoration: 'underline' }}>
            all launches »
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {MOCK_LAUNCHES.slice(0, 6).map((l) => (
            <Link
              key={l.address}
              href={`/trade/${l.address}`}
              className="uru-shell"
              style={{ padding: 10, display: 'flex', gap: 10, textDecoration: 'none', color: 'inherit', alignItems: 'center' }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  border: '1.5px solid var(--anchor)',
                  boxShadow: '2px 2px 0 var(--anchor)',
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
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.1 }}>{l.name}</div>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>${l.ticker}</div>
                </div>
                <div style={{ marginTop: 3, height: 6, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)' }}>
                  <div style={{ width: `${mockProgressPct(l)}%`, height: '100%', background: l.graduated ? 'var(--mint)' : 'var(--pink-hot)' }} />
                </div>
                <div style={{ marginTop: 3, fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)' }}>
                  {Number(formatEther(l.ethReserve)).toFixed(3)} / {Number(formatEther(l.graduationTargetEth)).toFixed(1)} ETH
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
