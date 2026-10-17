'use client';

import { useEffect, useState } from 'react';

/// Light/dark theme toggle. Persists in localStorage under `urufu-theme` and applies the
/// value as a `data-theme` attribute on <html>. Light is the default; the OS
/// `prefers-color-scheme` is ignored (see public/theme-bootstrap.js).
///
/// The initial paint happens via the inline <ThemeBootstrapScript /> in layout.tsx so
/// there's no FOUC between server-rendered HTML and the client theme.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'urufu-theme';

export function currentAppliedTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', t);
  try {
    window.localStorage.setItem(STORAGE_KEY, t);
  } catch {}
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTheme(currentAppliedTheme());
  }, []);

  const handleClick = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  if (!mounted) {
    // Keep the first client render byte-for-byte with the server markup. React 19
    // reports a hydration attribute mismatch if this placeholder adds `disabled`
    // before the interactive render lands.
    return (
      <button type="button" aria-label="Toggle theme" className="ui-icon-btn">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      </button>
    );
  }

  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="ui-icon-btn"
      data-sfx="none"
    >
      {isDark ? <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg> : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
    </button>
  );
}

// The inline bootstrap that used to live here has moved to `web/public/theme-bootstrap.js`
// so the root layout can reference it via <script src>. Next 16 flags every <script> node
// rendered from a component (dangerouslySetInnerHTML included), so keeping it as an
// external static asset sidesteps the warning entirely. STORAGE_KEY above stays the source
// of truth for the storage slot; update both if you ever rename it.
