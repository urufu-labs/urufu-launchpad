/// Launcher-chosen look for a collection page: banner, accent color, one-click
/// theme, fonts and wallpaper. Saved off-chain from "Customize your page";
/// applied as CSS variables on a wrapper around the page so every ui-*
/// primitive inside (buttons, badges, meters, links) follows automatically.
///
/// The site header and the mint box's structure are never touched: a creator
/// changes colors, fonts and backgrounds, not what the controls say or do.

import type { CSSProperties } from 'react';

import { FONTS, isFontId, type FontId } from './collectionFonts';

export const WALLPAPER_TYPES = ['default', 'tint', 'banner', 'color', 'gradient', 'image'] as const;
export type WallpaperType = (typeof WALLPAPER_TYPES)[number];

export const THEME_IDS = ['custom', 'site', 'night', 'paper', 'pixel', 'poster', 'sketch', 'mono'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface Wallpaper {
  type: WallpaperType;
  color?: string | null;
  color2?: string | null;
  imageUrl?: string | null;
  /// px, 0-40. Image wallpaper only.
  blur?: number;
}

export interface PageDesign {
  theme?: ThemeId;
  titleFont?: FontId;
  bodyFont?: FontId;
  wallpaper?: Wallpaper;
}

export interface PageLink {
  id: string;
  title: string;
  url: string;
  style: 'classic' | 'featured';
  thumbnailUrl?: string | null;
}

/// Everything the page needs to draw the creator's look.
export interface PageLook {
  bannerUrl: string | null;
  accentColor: string | null;
  design: PageDesign | null;
}

/// Fallback when no colors can be read from the creator's own art.
export const ACCENT_PRESETS = ['#111111', '#a8361b', '#d9a441', '#2f7d4f', '#2346b8', '#7a2e8c'];

/// One-click looks. Each sets accent + fonts + background together; the
/// creator can change any piece afterwards (the theme then reads "custom").
export const THEMES: { id: Exclude<ThemeId, 'custom'>; label: string; accent: string | null; design: PageDesign }[] = [
  { id: 'site', label: 'Site', accent: null,
    design: { titleFont: 'default', bodyFont: 'default', wallpaper: { type: 'default' } } },
  { id: 'night', label: 'Night', accent: '#d9a441',
    design: { titleFont: 'bodoni', bodyFont: 'default', wallpaper: { type: 'color', color: '#111214' } } },
  { id: 'paper', label: 'Paper', accent: '#a8361b',
    design: { titleFont: 'caslon', bodyFont: 'default', wallpaper: { type: 'color', color: '#f1ebdf' } } },
  { id: 'pixel', label: 'Pixel', accent: '#3fbf5a',
    design: { titleFont: 'silkscreen', bodyFont: 'plex-mono', wallpaper: { type: 'color', color: '#0a0b0a' } } },
  { id: 'poster', label: 'Poster', accent: '#d42a1e',
    design: { titleFont: 'anton', bodyFont: 'default', wallpaper: { type: 'color', color: '#ece6d6' } } },
  { id: 'sketch', label: 'Sketch', accent: '#2346b8',
    design: { titleFont: 'marker', bodyFont: 'default', wallpaper: { type: 'color', color: '#fbfaf6' } } },
  { id: 'mono', label: 'Mono', accent: '#111111',
    design: { titleFont: 'plex-mono', bodyFont: 'plex-mono', wallpaper: { type: 'color', color: '#ffffff' } } },
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

/// Which modes an accent is hard to read in, as text or a button, given the
/// page's own background (a forced mode, or both site modes).
export function hardToReadOn(hex: string, mode: 'light' | 'dark' | null, wallColor?: string | null): ('light' | 'dark')[] {
  const out: ('light' | 'dark')[] = [];
  if (wallColor && isHexColor(wallColor)) {
    if (contrast(hex, wallColor) < 2.5) out.push(mode ?? 'light');
    return out;
  }
  if (mode !== 'dark' && contrast(hex, SITE_BG_LIGHT) < 2.5) out.push('light');
  if (mode !== 'light' && contrast(hex, SITE_BG_DARK) < 2.5) out.push('dark');
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

/// A solid or gradient wallpaper pins the page to light or dark so text stays
/// readable on it for every visitor, whatever their site theme.
export function forcedMode(design: PageDesign | null): 'light' | 'dark' | null {
  const w = design?.wallpaper;
  if (!w) return null;
  if (w.type === 'color' && isHexColor(w.color)) return luminance(w.color) > 0.35 ? 'light' : 'dark';
  if (w.type === 'gradient' && isHexColor(w.color) && isHexColor(w.color2)) {
    return (luminance(w.color) + luminance(w.color2)) / 2 > 0.35 ? 'light' : 'dark';
  }
  return null;
}

/// Inline style for the page wrapper. Unset fields leave the site default.
export function themeStyle(look: PageLook): CSSProperties {
  const style: Record<string, string> = {};
  const accent = isHexColor(look.accentColor) ? look.accentColor : null;
  if (accent) {
    style['--accent'] = accent;
    style['--accent-hover'] = `color-mix(in srgb, ${accent} 82%, #000)`;
    style['--accent-soft'] = `color-mix(in srgb, ${accent} 12%, transparent)`;
    style['--accent-fg'] = luminance(accent) > 0.4 ? '#111110' : '#ffffff';
  }
  const d = look.design;
  const title = isFontId(d?.titleFont) ? FONTS[d.titleFont].family : null;
  const body = isFontId(d?.bodyFont) ? FONTS[d.bodyFont].family : null;
  if (title) style['--font-display'] = title;
  if (body) style['--font-sans'] = body;

  const w = d?.wallpaper;
  if (w?.type === 'tint') {
    style.background = `color-mix(in srgb, ${accent ?? 'var(--accent)'} 6%, var(--bg))`;
  } else if (w?.type === 'color' && isHexColor(w.color)) {
    style.background = w.color;
  } else if (w?.type === 'gradient' && isHexColor(w.color) && isHexColor(w.color2)) {
    style.background = `linear-gradient(170deg, ${w.color}, ${w.color2})`;
  }
  // 'banner' and 'image' are drawn by the page as a backdrop layer.
  return style as CSSProperties;
}

/// Turns any http(s) link into "example.com" for display under a link.
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
