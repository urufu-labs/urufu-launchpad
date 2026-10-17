'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { gsap, reducedMotion, ease } from './motion';
import { IconButton } from './Button';

const CloseIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
);

/// Modal dialog. Closes on Esc and backdrop click, locks body scroll, returns
/// focus to the opener. On phones it can slide up as a bottom sheet (`sheet`).
export function Modal({
  open,
  onClose,
  title,
  width = 480,
  sheet = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  width?: number;
  sheet?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    if (!reducedMotion()) {
      gsap.fromTo(overlayRef.current, { opacity: 0 }, { opacity: 1, duration: 0.18 });
      gsap.fromTo(dialogRef.current, { opacity: 0, y: 12, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.26, ease: ease.out });
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;
  return createPortal(
    <div
      ref={overlayRef}
      className="ui-overlay"
      data-sheet={sheet ? 'true' : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        style={{ ['--ui-dialog-w' as string]: `${width}px`, outline: 'none' }}
      >
        <div className="ui-dialog-head">
          {title != null ? <h2 className="ui-dialog-title">{title}</h2> : <span />}
          <IconButton label="Close" size="sm" onClick={onClose}>
            {CloseIcon}
          </IconButton>
        </div>
        <div className="ui-dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/// Hover/focus tooltip. Keep the text short; it is not read on touch devices.
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <span className="ui-tip">
      {children}
      <span className="ui-tip-bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- toasts

export type ToastInput = { title: ReactNode; description?: ReactNode; tone?: 'neutral' | 'buy' | 'sell' | 'accent'; durationMs?: number };
type ToastItem = ToastInput & { id: number };

const ToastCtx = createContext<(t: ToastInput) => void>(() => {});

/// Mount once near the root. Then `const toast = useToast(); toast({ title: 'Bought 5M UPEPE' })`.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.durationMs ?? 5000);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="ui-toasts" aria-live="polite">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reducedMotion()) gsap.from(ref.current, { opacity: 0, y: 10, duration: 0.25, ease: ease.out });
  }, []);
  return (
    <div ref={ref} className="ui-toast" data-tone={item.tone && item.tone !== 'neutral' ? item.tone : undefined} role="status">
      <span className="ui-toast-bar" aria-hidden />
      <div style={{ minWidth: 0 }}>
        <div className="ui-toast-title">{item.title}</div>
        {item.description != null && <div className="ui-toast-desc">{item.description}</div>}
      </div>
      <IconButton label="Dismiss" size="sm" onClick={onClose} style={{ border: 0 }}>
        {CloseIcon}
      </IconButton>
    </div>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
