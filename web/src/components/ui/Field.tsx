'use client';

import { forwardRef, useId, type ComponentProps, type ReactNode } from 'react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/// Label + control + hint/error. Pass the control as children and give it the
/// same id you pass as `htmlFor` so the label is clickable.
export function Field({
  label,
  aside,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  aside?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {aside != null && <span className="ui-field-aside">{aside}</span>}
      </label>
      {children}
      {error ? <span className="ui-error" role="alert">{error}</span> : hint ? <span className="ui-hint">{hint}</span> : null}
    </div>
  );
}

type InputExtras = { mono?: boolean; invalid?: boolean };

export const Input = forwardRef<HTMLInputElement, InputExtras & ComponentProps<'input'>>(function Input(
  { mono, invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx('ui-input', className)}
      data-mono={mono ? 'true' : undefined}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, { invalid?: boolean } & ComponentProps<'textarea'>>(function Textarea(
  { invalid, className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('ui-input', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx('ui-input', className)} {...rest} />;
});

/// The big "you pay / you receive" box from the trade panel. Controlled by the
/// caller: value + onChange are passed straight to the <input>.
export function AmountInput({
  label,
  balance,
  asset,
  sub,
  readOnlyValue,
  inputProps,
}: {
  label: ReactNode;
  /// Right side of the top row, e.g. "Balance 1.28 ETH".
  balance?: ReactNode;
  /// Asset pill on the right, e.g. <><img/>ETH</>.
  asset?: ReactNode;
  /// Under the number, e.g. the USD value.
  sub?: ReactNode;
  /// When set, renders this text instead of an input (for "you receive").
  readOnlyValue?: ReactNode;
  inputProps?: ComponentProps<'input'>;
}) {
  const id = useId();
  return (
    <div className="ui-amount">
      <div className="ui-amount-top">
        <label htmlFor={readOnlyValue == null ? id : undefined}>{label}</label>
        {balance != null && <span className="ui-num">{balance}</span>}
      </div>
      <div className="ui-amount-row">
        {readOnlyValue != null ? (
          <span className="ui-num" style={{ flex: 1, minWidth: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {readOnlyValue}
          </span>
        ) : (
          <input id={id} inputMode="decimal" autoComplete="off" placeholder="0.00" {...inputProps} />
        )}
        {asset != null && <span className="ui-asset">{asset}</span>}
      </div>
      {sub != null && <div className="ui-amount-sub ui-num">{sub}</div>}
    </div>
  );
}
