import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'secondary' | 'primary' | 'ink' | 'ghost' | 'buy' | 'sell';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /// Shows a spinner and blocks clicks. The label stays so the button keeps its width.
  loading?: boolean;
  icon?: ReactNode;
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/// v2 button. Presentational only: pass the same onClick / disabled / type you
/// passed to the old `uru-btn` element.
export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  loading,
  icon,
  className,
  disabled,
  children,
  type = 'button',
  ...rest
}: Common & ComponentProps<'button'>) {
  return (
    <button
      type={type}
      className={cx('ui-btn', className)}
      data-variant={variant}
      data-size={size}
      data-block={block ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/// Same look as Button, rendered as a Next.js Link (or a plain <a> for external URLs).
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  block,
  icon,
  className,
  children,
  href,
  external,
  ...rest
}: Omit<Common, 'loading'> & Omit<ComponentProps<'a'>, 'href'> & { href: string; external?: boolean }) {
  const props = {
    className: cx('ui-btn', className),
    'data-variant': variant,
    'data-size': size,
    'data-block': block ? 'true' : undefined,
    ...rest,
  };
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...props}>
      {icon}
      {children}
    </Link>
  );
}

/// Square icon-only button. `label` is required so screen readers get a name.
export function IconButton({
  label,
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: { label: string; size?: 'sm' | 'md' } & ComponentProps<'button'>) {
  return (
    <button type={type} className={cx('ui-icon-btn', className)} data-size={size} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
