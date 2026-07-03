'use client';

import { useEffect, useRef, useState } from 'react';

import { Mascot } from './Mascot';

/// Mascot follows the cursor with a small lag. Auto-hides if user prefers reduced motion,
/// on touch, or when tab hidden.
export function CursorMascot() {
  const [enabled, setEnabled] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hoverable = matchMedia('(hover: hover)').matches;
    if (reduced || !hoverable) return;
    setEnabled(true);
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      target.current.x = e.clientX;
      target.current.y = e.clientY;
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
    };
  }, []);

  if (!enabled) return null;
  return (
    <div
      ref={ref}
      className="uru-cursor uru-idle-bob"
      style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 9999 }}
    >
      <Mascot size={26} />
    </div>
  );
}
