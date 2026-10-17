'use client';

import { useEffect, useState } from 'react';

import { isAudioEnabled, playSfx, setAudioEnabled } from '@/lib/audio/sfx';

/**
 * On/off toggle for procedural SFX. Persists in localStorage; defaults
 * off. Plays a friendly two-tone chime the first time you turn it on so the
 * permission grant feels meaningful.
 */
export function AudioToggle() {
  const [on, setOn] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setOn(isAudioEnabled());
    const handler = () => setOn(isAudioEnabled());
    window.addEventListener('urufu-audio-toggle', handler);
    return () => window.removeEventListener('urufu-audio-toggle', handler);
  }, []);

  const handleClick = () => {
    const next = !on;
    setAudioEnabled(next);
    setOn(next);
    if (next) {
      playSfx('coin');
      setTimeout(() => playSfx('pop'), 220);
    }
  };

  // SSR-safe: render an inert placeholder until mounted. Do not add a `disabled`
  // attribute here; the server/client boundary can otherwise disagree during
  // hydration before the interactive render lands.
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle audio"
        className="ui-icon-btn"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={on ? 'Mute audio' : 'Enable audio'}
      title={on ? 'Mute sound effects' : 'Turn on sound effects'}
      className="ui-icon-btn"
      // Skip the doc-level click delegation so toggling doesn't fire a stray click sfx.
      data-sfx="none"
    >
      {on ? <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg> : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>}
    </button>
  );
}
