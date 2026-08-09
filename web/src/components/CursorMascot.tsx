'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { Mascot } from './Mascot';

const SPARKLE_GLYPHS = ['✦', '✧', '♡', '★'] as const;

/// Mascot follows the cursor with a small lag. Auto-hides if user prefers reduced motion,
/// on touch, or when tab hidden.
export function CursorMascot() {
  const [enabled, setEnabled] = useState(false);
  const [sparkles, setSparkles] = useState<
    Array<{ id: number; glyph: string; x: number; y: number; driftX: number; driftY: number }>
  >([]);
  const ref = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: 0, y: 0 });
  const lastSparkleAt = useRef(0);
  const nextSparkleId = useRef(0);
  const sparkleTimers = useRef(new Set<number>());

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hoverable = matchMedia('(hover: hover)').matches;
    if (reduced || !hoverable) return;
    setEnabled(true);
    const timers = sparkleTimers.current;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      target.current.x = e.clientX;
      target.current.y = e.clientY;
      const now = performance.now();
      if (now - lastSparkleAt.current < 65) return;
      lastSparkleAt.current = now;
      const id = nextSparkleId.current++;
      const sparkle = {
        id,
        glyph: SPARKLE_GLYPHS[id % SPARKLE_GLYPHS.length]!,
        x: e.clientX,
        y: e.clientY,
        driftX: ((id % 5) - 2) * 7,
        driftY: -16 - (id % 3) * 8,
      };
      setSparkles((current) => [...current.slice(-14), sparkle]);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setSparkles((current) => current.filter((item) => item.id !== id));
      }, 620);
      timers.add(timer);
    };
    const tick = () => {
      pos.current.x += (target.current.x - pos.current.x) * 0.16;
      pos.current.y += (target.current.y - pos.current.y) * 0.16;
      if (ref.current) {
        ref.current.style.transform = `translate(${pos.current.x + 22}px, ${pos.current.y + 22}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  if (!enabled) return null;
  return (
    <>
      {sparkles.map((sparkle) => (
        <span
          key={sparkle.id}
          className="uru-cursor-sparkle"
          style={
            {
              left: sparkle.x,
              top: sparkle.y,
              '--sparkle-drift-x': `${sparkle.driftX}px`,
              '--sparkle-drift-y': `${sparkle.driftY}px`,
            } as CSSProperties
          }
        >
          {sparkle.glyph}
        </span>
      ))}
      <div
        ref={ref}
        className="uru-cursor"
        style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 9999 }}
        aria-hidden="true"
      >
        <div className="uru-cursor-mascot uru-idle-bob">
          <Mascot size={26} />
        </div>
      </div>
    </>
  );
}
