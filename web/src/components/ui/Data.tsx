'use client';

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { gsap, reducedMotion, ease } from './motion';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export type Tone = 'neutral' | 'buy' | 'sell' | 'accent' | 'warn' | 'info';

export function Badge({ tone = 'neutral', dot, className, children, ...rest }: { tone?: Tone; dot?: boolean } & ComponentProps<'span'>) {
  return (
    <span className={cx('ui-badge', className)} data-tone={tone === 'neutral' ? undefined : tone} {...rest}>
      {dot && <span className="ui-badge-dot" aria-hidden />}
      {children}
    </span>
  );
}

/// Small uppercase label used above stats and in table headers.
export function Label({ className, ...rest }: ComponentProps<'span'>) {
  return <span className={cx('ui-label', className)} {...rest} />;
}

/// Signed percentage, green when up, red when down. `value` is a percent number.
export function Delta({ value, digits = 1, className }: { value: number | null | undefined; digits?: number; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={cx('ui-delta', className)} style={{ color: 'var(--fg-faint)' }}>–</span>;
  const tone = value > 0 ? 'ui-up' : value < 0 ? 'ui-down' : undefined;
  return (
    <span className={cx('ui-delta', tone, className)}>
      {value > 0 ? '+' : ''}
      {value.toFixed(digits)}%
    </span>
  );
}

/// Label over a mono value, with an optional delta next to it.
export function Stat({ label, value, delta, size, className }: { label: ReactNode; value: ReactNode; delta?: ReactNode; size?: 'md' | 'lg'; className?: string }) {
  return (
    <div className={cx('ui-stat', className)} data-size={size}>
      <Label>{label}</Label>
      <div className="ui-stat-row">
        <span className="ui-stat-value">{value}</span>
        {delta}
      </div>
    </div>
  );
}

/// One definition row ("Trading fee ........ 1%"). Wrap several in a <dl>.
export function Kv({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('ui-kv', className)}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/// Styled table. Use normal <thead>/<tbody>; set data-align="right" on numeric cells.
export function Table({ className, ...rest }: ComponentProps<'table'>) {
  return (
    <div className="ui-table-wrap">
      <table className={cx('ui-table', className)} {...rest} />
    </div>
  );
}

/// Progress bar (bonding curve, graduation). `value` is 0..100. Animates once on mount.
export function Meter({ value, tone, size, label }: { value: number; tone?: 'accent' | 'buy'; size?: 'md' | 'lg'; label?: string }) {
  const fill = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  useEffect(() => {
    const el = fill.current;
    if (!el) return;
    const to = clamped / 100;
    if (reducedMotion()) gsap.set(el, { scaleX: to });
    else if (first.current) gsap.fromTo(el, { scaleX: 0 }, { scaleX: to, duration: 1, ease: ease.out, delay: 0.1 });
    else gsap.to(el, { scaleX: to, duration: 0.5, ease: ease.out });
    first.current = false;
  }, [clamped]);
  return (
    <div className="ui-meter" data-tone={tone === 'buy' ? 'buy' : undefined} data-size={size} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} aria-label={label}>
      <span ref={fill} className="ui-meter-fill" style={{ transform: `scaleX(${clamped / 100})` }} />
    </div>
  );
}

/// Truncated 0x address with a copy button.
export function Address({ value, head = 6, tail = 4, href }: { value: string; head?: number; tail?: number; href?: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <span className="ui-address" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
          {short}
        </a>
      ) : (
        short
      )}
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy address'}>
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m5 12 5 5 9-10" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        )}
      </button>
    </span>
  );
}

export function Skeleton({ width = '100%', height = 14, radius, className }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return <span className={cx('ui-skeleton', className)} style={{ width, height, borderRadius: radius }} aria-hidden />;
}
