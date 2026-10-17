'use client';

import { useEffect, useState, type ReactNode } from 'react';
import styles from '@/styles/guide.module.css';

/// Sticky "on this page" rail for the guide pages. Highlights the section
/// currently in view. Becomes a horizontal chip row on phones (CSS only).
export function GuideToc({
  label = 'On this page',
  items,
  actions,
}: {
  label?: string;
  items: Array<{ id: string; label: string }>;
  actions?: ReactNode;
}) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  const idsKey = items.map((i) => i.id).join(',');

  useEffect(() => {
    const els = idsKey.split(',').map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
        let best = '';
        let bestTop = Infinity;
        for (const [id, top] of visible) {
          if (top !== Infinity && Math.abs(top) < Math.abs(bestTop)) {
            best = id;
            bestTop = top;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: '-80px 0px -55% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [idsKey]);

  return (
    <aside className={styles.toc} aria-label={label}>
      <p className={styles.tocLabel}>{label}</p>
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`} data-active={active === item.id ? 'true' : undefined}>
          {item.label}
        </a>
      ))}
      {actions && <div className={styles.tocActions}>{actions}</div>}
    </aside>
  );
}
