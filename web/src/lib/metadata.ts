import type { Address } from 'viem';

/// Client-side token metadata. Pump.fun-style: every launched token gets logo + description +
/// socials. Stored in localStorage for MVP, with IPFS + the metadata API supplying the shared path.
export interface TokenMetadata {
  /// data:image/... URL. Kept inline as a local fallback; ceiling ~256KB per token.
  logoDataUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  tiktok?: string;
  /// Set when the metadata has been uploaded to IPFS. `gatewayUrl` is the CDN read path.
  cid?: string;
  gatewayUrl?: string;
  /// IPFS CID of the pinned whitelist holder list, when the token launched with a
  /// community whitelist. Trade page reads this to fetch the list + build proofs
  /// for WL-eligible buyers via /wl/proof. Absent on non-WL launches.
  wlListCid?: string;
  savedAt: number;
}

const LOCAL_STORAGE_PREFIX = 'vm:metadata:';

// The logo is kept locally as a base64 data URL until the pin + metadata save finish.
// Keep the generated file conservative so several launches cannot exhaust browser storage.
export const MAX_LOGO_BYTES = 256 * 1024;
const MAX_LOGO_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_LOGO_DIMENSION = 1024;
const MIN_LOGO_DIMENSION = 256;
const WEBP_QUALITIES = [0.92, 0.84, 0.74, 0.64, 0.54] as const;

export interface LogoUploadResult {
  dataUrl: string;
  originalBytes: number;
  outputBytes: number;
  optimized: boolean;
}

export function keyFor(chainId: number | string, tokenAddress: Address): string {
  return `${LOCAL_STORAGE_PREFIX}${chainId}:${tokenAddress.toLowerCase()}`;
}

/// Safely build a CSS `background` value for a user-supplied image URL. The metadata
/// API accepts arbitrary `imageUrl` strings passing zod's `.url()` check, which lets
/// characters like `);` through unescaped — interpolated raw into `url(${x})` they
/// close the CSS function and inject arbitrary declarations (positioned overlays,
/// hidden clickjack layers). Wrapping in single quotes + percent-encoding blocks
/// both the escape and quote-injection paths. Returns a full `background` value that
/// keeps the paper-cream fallback when the URL is falsy.
export function safeBackgroundImage(imageUrl: string | undefined | null, fallback = 'var(--cream-deep)'): string {
  if (!imageUrl) return fallback;
  // encodeURI leaves : / ? # &, all safe inside quotes. Backslash + quote get through
  // encodeURI (they're valid URL chars) but not through the quote wrapper, so also
  // strip any embedded single-quotes defensively.
  const clean = encodeURI(imageUrl).replace(/'/g, '%27');
  return `#fff url('${clean}') center/cover no-repeat`;
}

export function saveMetadata(
  chainId: number | string,
  tokenAddress: Address,
  data: Omit<TokenMetadata, 'savedAt'>,
): void {
  if (typeof window === 'undefined') return;
  const record: TokenMetadata = { ...data, savedAt: Date.now() };
  try {
    localStorage.setItem(keyFor(chainId, tokenAddress), JSON.stringify(record));
  } catch (err) {
    // Storage full or blocked — swallow. UI shows a "couldn't save" note if needed.
    console.warn('vm metadata save failed', err);
  }
}

export function loadMetadata(chainId: number | string, tokenAddress: Address): TokenMetadata | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(keyFor(chainId, tokenAddress));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenMetadata;
  } catch {
    return null;
  }
}

/// Persist metadata to BOTH IPFS (when enabled) and localStorage. IPFS is best-effort:
/// the local copy always wins for the immediate post-launch UI, and the CID gets stored
/// alongside once the pin returns so anyone opening the same token page later can
/// hydrate from the gateway. The Pinata JWT lives in NEXT_PUBLIC_PINATA_JWT — see ipfs.ts.
export async function persistMetadata(
  chainId: number | string,
  tokenAddress: Address,
  data: Omit<TokenMetadata, 'savedAt' | 'cid' | 'gatewayUrl'>,
): Promise<TokenMetadata> {
  // Lazy import so bundlers don't drag Pinata into every page.
  const { uploadMetadataToIpfs } = await import('./ipfs');
  const pin = await uploadMetadataToIpfs(data);
  const record: TokenMetadata = {
    ...data,
    ...(pin ? { cid: pin.cid, gatewayUrl: pin.gatewayUrl } : {}),
    savedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(keyFor(chainId, tokenAddress), JSON.stringify(record));
    } catch (err) {
      console.warn('vm metadata local save failed', err);
    }
  }
  return record;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolvePromise, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolvePromise(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this image. Try a PNG, JPEG, WebP, or SVG.'));
    };
    image.src = url;
  });
}

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolvePromise, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Could not optimize this image. Try a PNG, JPEG, WebP, or SVG.'));
          return;
        }
        if (blob.type !== 'image/webp') {
          reject(new Error('This browser cannot optimize images to WebP. Try a smaller image.'));
          return;
        }
        resolvePromise(blob);
      },
      'image/webp',
      quality,
    );
  });
}

async function optimizeLogo(file: File): Promise<Blob> {
  if (file.type === 'image/gif') {
    throw new Error(
      'Animated GIFs must be under 256KB. Use a static PNG, JPEG, WebP, or SVG for automatic optimization.',
    );
  }

  const image = await loadImage(file);
  if (image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error('Could not read this image. Try a PNG, JPEG, WebP, or SVG.');
  }

  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  let scale = Math.min(1, MAX_LOGO_DIMENSION / longestSide);

  while (true) {
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare this image for upload.');
    context.drawImage(image, 0, 0, width, height);

    for (const quality of WEBP_QUALITIES) {
      const blob = await canvasToWebp(canvas, quality);
      if (blob.size <= MAX_LOGO_BYTES) return blob;
    }

    if (Math.max(width, height) <= MIN_LOGO_DIMENSION) break;
    scale *= 0.72;
  }

  throw new Error('Could not shrink this image enough. Try a simpler image or an SVG.');
}

/// Read a logo as a data URL. Files already within the local fallback budget pass through
/// unchanged; larger raster uploads are resized and encoded as WebP in the browser.
export async function readFileAsDataUrl(file: File): Promise<LogoUploadResult> {
  if (!file.type.startsWith('image/')) throw new Error('Logo must be an image file');
  if (file.size > MAX_LOGO_SOURCE_BYTES) {
    throw new Error(
      `Logo is too large to optimize — choose an image under ${MAX_LOGO_SOURCE_BYTES / 1024 / 1024}MB.`,
    );
  }

  if (file.size <= MAX_LOGO_BYTES) {
    return {
      dataUrl: await readBlobAsDataUrl(file),
      originalBytes: file.size,
      outputBytes: file.size,
      optimized: false,
    };
  }

  const optimized = await optimizeLogo(file);
  return {
    dataUrl: await readBlobAsDataUrl(optimized),
    originalBytes: file.size,
    outputBytes: optimized.size,
    optimized: true,
  };
}
