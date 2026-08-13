/// Dynamic OG image for /trade/:address. Next.js App Router recognizes this
/// file at build/request time and serves the returned image at the token's
/// canonical OG URL. Tools like Twitter, Discord, iMessage fetch it when
/// someone shares a token's trade page link.
///
/// Design: pixel-mascot on the left, big ticker + name on the right, warm
/// cream background matching the site aesthetic. Kept intentionally simple
/// so the image renders fast (edge runtime) and looks legible at every
/// preview-card crop.

import { ImageResponse } from 'next/og';

import { fetchLaunchesByTokens } from '@/lib/indexer';
import { fetchTokenMetadata } from '@/lib/socialApi';

// Standard OG dimensions — Twitter summary_large_image, Facebook, Discord.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Runtime hint. Node runtime (default) supports the external fetches we need
// (indexer + compile-service); edge would strip them. Explicit for clarity.
export const runtime = 'nodejs';

// Cream/anchor palette echoing globals.css. Hex only so ImageResponse's
// simplified CSS parser handles them without variable resolution.
const CREAM = '#f5ecda';
const CREAM_DEEP = '#fff5d6';
const ANCHOR = '#3a2c3a';
const ANCHOR_SOFT = '#6b4d6b';
const PINK_HOT = '#ff88b3';
const MINT_HOT = '#2fbf6a';

/// Data pulled per token: name + ticker from indexer, image from
/// compile-service metadata store. Each fetch has a short timeout because
/// social crawlers time out fast and we'd rather serve a partial card than
/// nothing. Any failure resolves to null and the OG template falls back to
/// generic branding.
/// Pre-fetch an external image and return it as a base64 data URI. Satori
/// (the engine behind next/og ImageResponse) has to load `<img src>` values
/// during render — if the src is an external HTTP URL, it does a background
/// fetch that can time out, get the wrong content-type, or hit CORS, and
/// when it fails the WHOLE ImageResponse throws HTTP 500. That silently
/// broke Twitter/Discord/Slack cards for every token with an uploaded
/// image (LUV was the visible casualty on 2026-08-13).
///
/// Pre-resolving to a data URI here in the Node runtime — with a short
/// timeout and content-type validation — means satori sees an inline blob
/// it can never fail to load. Any failure returns null so the OG template
/// falls back to the pixel-mascot placeholder.
const IMAGE_FETCH_TIMEOUT_MS = 3_500;
const IMAGE_MAX_BYTES = 2_000_000; // 2MB; satori chokes on big base64
async function resolveImageToDataUri(url: string): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    // Only rasters satori can decode. SVG can render but often breaks on
    // <foreignObject> or external font/image refs — safer to skip.
    if (!/^image\/(png|jpeg|jpg|webp|gif)/i.test(ct)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > IMAGE_MAX_BYTES) return null;
    const b64 = Buffer.from(buf).toString('base64');
    return `data:${ct.split(';')[0]};base64,${b64}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function loadTokenCard(address: string): Promise<{
  name: string;
  ticker: string;
  imageUrl: string | null;
}> {
  const addr = address.toLowerCase() as `0x${string}`;

  // Indexer read — name + ticker + launcher. We only need name + ticker for
  // the OG copy.
  let name = 'Launched Token';
  let ticker = '';
  try {
    const rows = await fetchLaunchesByTokens([addr]);
    const row = rows?.[0];
    if (row) {
      name = row.name || name;
      ticker = row.ticker || '';
    }
  } catch {}

  // Metadata read — image URL if the launcher uploaded one, converted to a
  // safe data URI. Chain is hardcoded to Robinhood since that's the only
  // live chain right now.
  let imageUrl: string | null = null;
  try {
    const meta = await fetchTokenMetadata(4663, addr);
    if (meta?.imageUrl) imageUrl = await resolveImageToDataUri(meta.imageUrl);
  } catch {}

  return { name, ticker, imageUrl };
}

// Next.js 16 route params are Promise-shaped — the old plain-object form
// resolved to `undefined` at runtime and `.toLowerCase()` inside
// loadTokenCard crashed the handler in ~7ms before hitting the indexer,
// which is exactly the 500 Discord's crawler was hitting on shared token
// links. Awaiting the params first restores the extractor.
export default async function OgImage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const { name, ticker, imageUrl } = await loadTokenCard(address);

  // Wrap the ImageResponse construction so a satori panic doesn't propagate
  // as HTTP 500 (crashes Twitter/Discord/Slack cards). On failure, fall back
  // to a minimal text-only image so the endpoint always returns a valid PNG.
  try {
    return renderCard({ name, ticker, imageUrl });
  } catch {
    return renderCard({ name, ticker, imageUrl: null });
  }
}

function renderCard({
  name,
  ticker,
  imageUrl,
}: {
  name: string;
  ticker: string;
  imageUrl: string | null;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          background: CREAM,
          padding: 60,
          fontFamily: 'sans-serif',
          color: ANCHOR,
        }}
      >
        {/* Left: token image (or brand mascot fallback) inside a chunky
            bordered square, matching the site's sticker-card aesthetic. */}
        <div
          style={{
            width: 380,
            height: 380,
            background: CREAM_DEEP,
            border: `4px solid ${ANCHOR}`,
            borderRadius: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 50,
            overflow: 'hidden',
            flexShrink: 0,
            // Soft outer shadow that matches the site's uru-stamp offset.
            boxShadow: `8px 8px 0 ${ANCHOR}`,
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              width={380}
              height={380}
              style={{ objectFit: 'cover' }}
            />
          ) : (
            // Fallback: giant emoji-ish mark so the card doesn't look broken
            // when the launcher hasn't uploaded a logo yet.
            <div style={{ fontSize: 220, lineHeight: 1 }}>✿</div>
          )}
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
              // Long token names get clipped rather than blowing out the
              // right edge of the card.
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
