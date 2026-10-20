/// Pulls a handful of usable accent colors out of the creator's own images
/// (banner + collection image), so the color picker starts from their art.
///
/// Runs in the browser on a 32x32 downscale. Images on other hosts without
/// CORS headers can't be read (the canvas is tainted); those are skipped and
/// the picker falls back to its presets.

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function hsl(r: number, g: number, b: number): { s: number; l: number } {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

function loadPixels(src: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, size, size);
        resolve(ctx.getImageData(0, 0, size, size).data);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/// Up to `max` distinct colors, most common first, skipping near-greys and
/// colors too light or dark to work as a button.
export async function artPalette(srcs: (string | null | undefined)[], max = 6): Promise<string[]> {
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (const src of srcs) {
    if (!src) continue;
    const px = await loadPixels(src);
    if (!px) continue;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3]! < 200) continue;
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      const { s, l } = hsl(r, g, b);
      if (s < 0.22 || l < 0.18 || l > 0.82) continue;
      // 4 bits per channel: groups near-identical shades together.
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n += 1; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n);
  const out: [number, number, number][] = [];
  for (const e of ranked) {
    const c: [number, number, number] = [e.r / e.n, e.g / e.n, e.b / e.n];
    // Keep picks visibly different from each other.
    if (out.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 60)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out.map(([r, g, b]) => toHex(r, g, b));
}
