'use client';

import { useEffect, useState } from 'react';

/// True when the primary pointer is coarse (touch phone/tablet). Used to disable
/// drag-and-drop affordances that don't translate to touch — mobile users should tap the
/// explicit "add to basket" button instead. Returns `false` on SSR + first paint so nothing
/// gates on it during hydration.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return coarse;
}
