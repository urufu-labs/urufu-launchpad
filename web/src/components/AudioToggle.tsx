'use client';

import { useEffect, useState } from 'react';

import { isAudioEnabled, playSfx, setAudioEnabled } from '@/lib/audio/sfx';

/**
 * ♪ on/off toggle for procedural SFX. Persists in localStorage; defaults
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

  // SSR-safe: render a disabled placeholder until mounted so hydration matches.
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle audio"
        disabled
        style={audioToggleStyle(false)}
      >
        ♪
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={on ? 'Mute audio' : 'Enable audio'}
      title={on ? 'mute all sfx' : 'turn on sfx (clicks + trades + chimes)'}
      style={audioToggleStyle(on)}
      // Skip the doc-level click delegation so toggling doesn't fire a stray click sfx.
      data-sfx="none"
    >
      {on ? '♪' : '♪̸'}
    </button>
  );
}

function audioToggleStyle(on: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    background: on ? 'var(--mint)' : 'var(--cream)',
    color: 'var(--anchor)',
    border: '1.5px solid var(--anchor)',
    boxShadow: '2px 2px 0 var(--anchor)',
    fontFamily: 'var(--font-pixel), monospace',
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
    letterSpacing: '-0.05em',
  };
}
