/// Fonts a creator can pick for their collection page. Each id maps to a font
/// this app loads itself (next/font, self-hosted), so a saved page can never
/// pull a font from an arbitrary URL. preload: false keeps them off every
/// other page; the browser fetches a face only when a page actually uses it.
///
/// Picked for distinct personalities (book, fashion, poster, pixel,
/// typewriter, marker) rather than the usual startup grotesks.

import {
  Anton,
  Bodoni_Moda,
  IBM_Plex_Mono,
  Libre_Caslon_Display,
  Permanent_Marker,
  Silkscreen,
} from 'next/font/google';

const caslon = Libre_Caslon_Display({ subsets: ['latin'], weight: '400', preload: false, display: 'swap' });
const bodoni = Bodoni_Moda({ subsets: ['latin'], preload: false, display: 'swap' });
const anton = Anton({ subsets: ['latin'], weight: '400', preload: false, display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '600'], preload: false, display: 'swap' });
const silkscreen = Silkscreen({ subsets: ['latin'], weight: ['400', '700'], preload: false, display: 'swap' });
const marker = Permanent_Marker({ subsets: ['latin'], weight: '400', preload: false, display: 'swap' });

export const FONT_IDS = ['default', 'caslon', 'bodoni', 'anton', 'plex-mono', 'silkscreen', 'marker'] as const;
export type FontId = (typeof FONT_IDS)[number];

export const FONTS: Record<FontId, { label: string; family: string | null }> = {
  // null = keep the site's own font for that role.
  default: { label: 'Site default', family: null },
  caslon: { label: 'Caslon (book serif)', family: caslon.style.fontFamily },
  bodoni: { label: 'Bodoni (fashion serif)', family: bodoni.style.fontFamily },
  anton: { label: 'Anton (poster)', family: anton.style.fontFamily },
  'plex-mono': { label: 'Plex Mono (typewriter)', family: plexMono.style.fontFamily },
  silkscreen: { label: 'Silkscreen (pixel)', family: silkscreen.style.fontFamily },
  marker: { label: 'Marker (hand drawn)', family: marker.style.fontFamily },
};

export function isFontId(v: unknown): v is FontId {
  return typeof v === 'string' && (FONT_IDS as readonly string[]).includes(v);
}
