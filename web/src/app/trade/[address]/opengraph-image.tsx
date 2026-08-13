/// Dynamic OG image for /trade/:address. Next.js App Router recognizes this
/// file at build/request time and serves the returned image at the token's
/// canonical OG URL. Tools like Twitter, Discord, iMessage fetch it when
/// someone shares a token's trade page link.
///
/// Design: giant ticker + name on a warm cream background with the site
/// signature ✿. Deliberately text-only — every earlier revision tried to
/// embed the launcher's uploaded image and satori (the engine behind
/// ImageResponse) crashed HTTP 500 on ~any real-world image URL (IPFS
/// timeouts, wrong content-types, CORS, malformed bytes). A try/catch
/// around ImageResponse doesn't catch these because satori streams the
/// image asynchronously AFTER the handler returns. The only reliable fix
/// is to never embed an external image at all. Card is still legible and
/// on-brand without it — the ticker size does most of the visual work.

import { ImageResponse } from 'next/og';

import { fetchLaunchesByTokens } from '@/lib/indexer';

// Standard OG dimensions — Twitter summary_large_image, Facebook, Discord.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Node runtime for the indexer fetch (build v2). No external image loading paths
// remain, so nothing here can fail from network flakiness.
export const runtime = 'nodejs';

// Cream/anchor palette echoing globals.css. Hex only so satori's
// simplified CSS parser handles them without variable resolution.
const CREAM = '#f5ecda';
const CREAM_DEEP = '#fff5d6';
const ANCHOR = '#3a2c3a';
const ANCHOR_SOFT = '#6b4d6b';
const PINK_HOT = '#ff88b3';
const MINT_HOT = '#2fbf6a';

interface TokenCard {
  name: string;
  ticker: string;
}

async function loadTokenCard(address: string): Promise<TokenCard> {
  const addr = address.toLowerCase() as `0x${string}`;
  let name = 'Launched Token';
  let ticker = '';
  try {
    const rows = await fetchLaunchesByTokens([addr]);
    const row = rows?.[0];
    if (row) {
      name = row.name || name;
      ticker = row.ticker || '';
    }
  } catch {
    // Indexer unreachable is fine — we render the generic branded card.
  }
  return { name, ticker };
}

// Next.js 16 route params are Promise-shaped.
export default async function OgImage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  // TEMPORARILY skipping the indexer fetch to isolate whether an unhandled
  // async error inside fetchLaunchesByTokens or downstream JSON parsing is
  // what crashes LUV's OG endpoint (but not V3TC's). Render a generic card
  // with the address suffix so the endpoint always returns a valid PNG.
  // Once verified working, we restore the indexer call gated on address so
  // one bad response can't take down the entire route.
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const name = 'urufu labs token';
  const ticker = short.toUpperCase();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: CREAM,
          padding: 60,
          fontFamily: 'sans-serif',
          color: ANCHOR,
        }}
      >
        {/* Signature mark — big pixel-style ✿ on the left as brand anchor. */}
        <div
          style={{
            width: 340,
            height: 340,
            background: CREAM_DEEP,
            border: `4px solid ${ANCHOR}`,
            borderRadius: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 50,
            flexShrink: 0,
            boxShadow: `8px 8px 0 ${ANCHOR}`,
          }}
        >
          <div style={{ fontSize: 220, lineHeight: 1 }}>✿</div>
        </div>

        {/* Right column: ticker + name + attribution */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div
            style={{
              fontSize: 32,
              color: ANCHOR_SOFT,
              marginBottom: 8,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            urufu labs launchpad
          </div>
          {ticker && (
            <div
              style={{
                fontSize: 96,
                lineHeight: 1,
                color: PINK_HOT,
                fontWeight: 800,
                marginBottom: 12,
              }}
            >
              ${ticker}
            </div>
          )}
          <div
            style={{
              fontSize: 56,
              lineHeight: 1.1,
              fontWeight: 600,
              color: ANCHOR,
              marginBottom: 24,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 640,
            }}
          >
            {name}
          </div>
          <div
            style={{
              fontSize: 28,
              color: MINT_HOT,
              fontWeight: 600,
            }}
          >
            ✿ trade + track on urufulabs.xyz
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
