'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { gsap, reducedMotion, ease } from './motion';

/// Click-to-open popover menu. Closes on outside click, Escape and route change.
/// `trigger` receives the open state so it can render a chevron or pressed style.
export function Menu({
  trigger,
  children,
  align = 'end',
  width = 220,
  label,
  openOnHover = false,
}: {
  trigger: (open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  width?: number;
  label: string;
  openOnHover?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    if (panel.current && !reducedMotion()) {
      gsap.fromTo(panel.current, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: 0.16, ease: ease.out });
    }
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hover = openOnHover
    ? {
        onMouseEnter: () => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
          setOpen(true);
        },
        onMouseLeave: () => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => setOpen(false), 140);
        },
      }
    : {};

  const close = () => setOpen(false);

  return (
    <div ref={wrap} className="ui-menu" {...hover}>
      <span
        className="ui-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setOpen(true);
        }}
      >
        {trigger(open)}
      </span>
      {open && (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          className="ui-menu-panel"
          data-align={align}
          style={{ width }}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
