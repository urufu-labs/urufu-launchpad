import type { ComponentProps, ReactNode } from 'react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/// Flat v2 surface: hairline border, 12px radius. Replaces uru-shell / uru-shell-inner.
/// Renders a <section>; use the `ui-panel` class directly when you need another element.
export function Panel({ className, ...rest }: ComponentProps<'section'>) {
  return <section className={cx('ui-panel', className)} {...rest} />;
}

/// Header row with a title on the left and optional actions on the right.
export function PanelHeader({
  title,
  actions,
  className,
  children,
  ...rest
}: { title?: ReactNode; actions?: ReactNode } & ComponentProps<'div'>) {
  return (
    <div className={cx('ui-panel-head', className)} {...rest}>
      {title != null && <h2 className="ui-panel-title">{title}</h2>}
      {children}
      {actions != null && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>}
    </div>
  );
}

export function PanelBody({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cx('ui-panel-body', className)} {...rest} />;
}
