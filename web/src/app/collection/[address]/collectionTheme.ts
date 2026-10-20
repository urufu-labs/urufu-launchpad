/// Launcher-chosen look for a collection page: banner image, accent color,
/// background preset. Saved off-chain from Creator tools; applied as CSS
/// variables on a wrapper around the page so every ui-* primitive inside
/// (buttons, badges, meters, links) picks up the accent automatically.

import type { CSSProperties } from 'react';

export const BACKGROUND_STYLES = ['default', 'tint', 'banner'] as const;
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number];

export interface CollectionTheme {
  bannerUrl: string | null;
  accentColor: string | null;
  backgroundStyle: BackgroundStyle | null;
}

export const EMPTY_THEME: CollectionTheme = { bannerUrl: null, accentColor: null, backgroundStyle: null };

export const ACCENT_PRESETS = [
  '#cc1e56', '#e8590c', '#e0a800', '#2b9348',
  '#0f9fb5', '#3a6ff7', '#7b4ff0', '#d63fb8',
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: string | null | undefined): v is string {
  return !!v && HEX.test(v);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/// Site backgrounds from styles/tokens.css (light, dark).
const SITE_BG_LIGHT = '#f3f3f0';
const SITE_BG_DARK = '#0b0b0c';

/// Which site themes an accent is hard to read on (as text or a button).
export function hardToReadOn(hex: string): ('light' | 'dark')[] {
  const out: ('light' | 'dark')[] = [];
  if (contrast(hex, SITE_BG_LIGHT) < 2.5) out.push('light');
  if (contrast(hex, SITE_BG_DARK) < 2.5) out.push('dark');
  return out;
}

/// Only http(s) for saved values; `allowData` lets the launcher's own live
/// preview show a just-picked file before it is uploaded.
export function safeImageUrl(v: string | null | undefined, allowData = false): string | null {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (allowData && v.startsWith('data:image/')) return v;
  return null;
}

/// CSS url("...") value that a stored string cannot break out of.
export function cssUrl(u: string): string {
  return `url("${encodeURI(u).replace(/"/g, '%22')}")`;
}

/// Inline style for the page wrapper. Unset fields leave the site default.
export function themeStyle(theme: CollectionTheme): CSSProperties {
  const style: Record<string, string> = {};
  const accent = isHexColor(theme.accentColor) ? theme.accentColor : null;
  if (accent) {
    style['--accent'] = accent;
    style['--accent-hover'] = `color-mix(in srgb, ${accent} 82%, #000)`;
    style['--accent-soft'] = `color-mix(in srgb, ${accent} 12%, transparent)`;
    style['--accent-fg'] = luminance(accent) > 0.4 ? '#111110' : '#ffffff';
  }
  // 'tint' washes the page in the accent (site accent if none picked).
  // 'banner' is drawn by the page itself (a blurred copy of the banner).
  if (theme.backgroundStyle === 'tint') {
    style.background = `color-mix(in srgb, ${accent ?? 'var(--accent)'} 6%, var(--bg))`;
  }
  return style as CSSProperties;
}
