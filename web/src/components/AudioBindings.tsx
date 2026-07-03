'use client';

import { useEffect } from 'react';

import { playSfx } from '@/lib/audio/sfx';

/**
 * Site-wide event delegation for ambient SFX. Listens once at the document
 * level and routes interactions to playSfx based on class/data attributes.
 * Ported from chibi-wolf's AudioBindings — same shape, launchpad classes.
 *
 * Routing:
 *  - uru-btn-primary (main CTA)  → 'stamp' (heavy thud)
 *  - uru-btn-mint (secondary)    → 'stamp'
 *  - uru-chip (quick amounts)    → 'pop'
 *  - uru-88 (webring badges)     → 'flip'
 *  - data-sfx="X"                → override to X
 *  - anything else button/link   → 'click'
 */
export function AudioBindings() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    function onClick(e: MouseEvent) {
      const target = (e.target as HTMLElement | null)?.closest(
        'button, a, [role="button"], .uru-chip, .uru-88',
      ) as HTMLElement | null;
      if (!target) return;

      // Explicit override via data-sfx="name" (or data-sfx="none" to suppress the click).
      const dataSfx = target.dataset.sfx;
      if (dataSfx === 'none') return;
      if (dataSfx) {
        playSfx(dataSfx as never);
        return;
      }

      // Classes routed by intent
      if (target.classList.contains('uru-btn-primary')) return playSfx('stamp');
      if (target.classList.contains('uru-btn-mint'))    return playSfx('stamp');
      if (target.classList.contains('uru-chip'))        return playSfx('pop');
      if (target.classList.contains('uru-88'))          return playSfx('flip');

      // Default: light click for any other button/link
      playSfx('click');
    }

    document.addEventListener('click', onClick, { passive: true });
    return () => document.removeEventListener('click', onClick);
  }, []);

  return null;
}
