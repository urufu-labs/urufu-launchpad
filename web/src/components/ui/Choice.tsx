'use client';

import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { gsap, reducedMotion, ease } from './motion';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export type Option<V extends string> = {
  value: V;
  label: ReactNode;
  /// Colors the selected label, e.g. buy/sell.
  tone?: 'buy' | 'sell';
  disabled?: boolean;
};

/// Segmented control (USD/ETH, Buy/Sell, timeframes). Controlled.
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  block,
  size,
  className,
}: {
  options: ReadonlyArray<Option<V>>;
  value: V;
  onChange: (v: V) => void;
  /// Accessible name for the group.
  label: string;
  block?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx('ui-seg', className)} data-block={block ? 'true' : undefined} data-size={size}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          data-tone={o.tone}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/// Underlined tabs with a sliding indicator. Controlled; render the panel yourself.
export function Tabs<V extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<Option<V> & { count?: ReactNode }>;
  value: V;
  onChange: (v: V) => void;
  label: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    const ink = inkRef.current;
    if (!list || !ink) return;
    const place = (animate: boolean) => {
      const btn = list.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!btn) return;
      const props = { x: btn.offsetLeft, width: btn.offsetWidth };
      if (animate && !reducedMotion()) gsap.to(ink, { ...props, duration: 0.28, ease: ease.out });
      else gsap.set(ink, props);
    };
    place(placed.current);
    placed.current = true;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(list);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cx('ui-tabs', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count != null && <span className="ui-tabs-count">{o.count}</span>}
        </button>
      ))}
      <span ref={inkRef} className="ui-tabs-ink" aria-hidden />
    </div>
  );
}

/// Pill toggle for filters and quick amounts. Pass `pressed` for toggle behavior.
export function Chip({ pressed, className, type = 'button', ...rest }: { pressed?: boolean } & ComponentProps<'button'>) {
  return <button type={type} className={cx('ui-chip', className)} aria-pressed={pressed} {...rest} />;
}
