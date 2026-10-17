'use client';

import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

/// Shared motion settings for the v2 UI (docs/PLAN-ui-revamp.md, "Motion").
/// Rules: nothing here may delay a transaction, block input, or animate the chart.
/// Every helper turns into a no-op under prefers-reduced-motion.

gsap.registerPlugin(useGSAP);

export { gsap, useGSAP };

export const ease = {
  out: 'power3.out',
  inOut: 'power3.inOut',
  soft: 'power2.out',
} as const;

export const dur = {
  fast: 0.18,
  base: 0.3,
  slow: 0.6,
} as const;

/// Media query that gates all motion. Use with gsap.matchMedia() inside useGSAP:
///   const mm = gsap.matchMedia();
///   mm.add(MOTION_OK, () => { gsap.from(...); });
export const MOTION_OK = '(prefers-reduced-motion: no-preference)';

export function reducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/// Tween a number in an element's text, e.g. stats on load. Writes the final
/// value straight away when motion is off, so the number is always correct.
export function countTo(
  el: HTMLElement,
  to: number,
  format: (v: number) => string,
  duration: number = 1.1,
): gsap.core.Tween | null {
  if (reducedMotion()) {
    el.textContent = format(to);
    return null;
  }
  const o = { v: 0 };
  return gsap.to(o, {
    v: to,
    duration,
    ease: ease.out,
    onUpdate: () => {
      el.textContent = format(o.v);
    },
  });
}

/// Short color flash on a value change (price ticks, new rows). Colors come from
/// CSS tokens so they follow the active theme.
export function flash(el: Element, tone: 'buy' | 'sell' | 'accent' = 'accent'): void {
  if (reducedMotion()) return;
  const from = getComputedStyle(document.documentElement).getPropertyValue(`--${tone}-soft`).trim();
  gsap.fromTo(el, { backgroundColor: from }, { backgroundColor: 'rgba(0,0,0,0)', duration: 0.9, ease: ease.soft, clearProps: 'backgroundColor' });
}
