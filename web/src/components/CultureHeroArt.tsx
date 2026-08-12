'use client';

import { useEffect, useRef, useState } from 'react';

type Theme = 'light' | 'dark';

const VIDEO_BY_THEME: Record<Theme, string | null> = {
  light: '/urufu-altar-light-release-seal-loop-v2.mp4',
  dark: '/urufu-altar-ring-braid-loop-v1.mp4',
};

function appliedTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function CultureHeroArt() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const [videoReady, setVideoReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const videoSource = VIDEO_BY_THEME[theme];

  // Track prefers-reduced-motion at runtime, not just on mount. A user who
  // enables "reduce motion" in system settings after the page loads should
  // see the autoplaying video pause + revert to the static poster art,
  // without having to reload. matchMedia has both a .matches read for the
  // initial value and a 'change' event for live toggles.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setTheme(appliedTheme());
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    setVideoReady(false);
    // reducedMotion is now state-tracked (see the matchMedia effect above),
    // so this effect re-runs when the user toggles the OS setting and pauses
    // an already-playing video via the cleanup below.
    if (!video || !videoSource || reducedMotion) return;

    let cancelled = false;
    const startPlayback = () => {
      const revealWhenPlaying = async () => {
        try {
          await video.play();
          if (!cancelled) setVideoReady(true);
        } catch {
          // Keep the theme's static hero art visible when autoplay is unavailable.
        }
      };

      video.addEventListener('canplay', revealWhenPlaying, { once: true });
      video.src = videoSource;
      video.load();
    };

    const idle = window.setTimeout(startPlayback, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(idle);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [videoSource, reducedMotion]);

  return (
    <div
      className="uru-home-hero-art"
      data-video-ready={videoReady}
      role="img"
      aria-label="An Urufu creator tending a glowing token-launch altar"
    >
      {videoSource && (
        <video
          ref={videoRef}
          className="uru-home-hero-video"
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
        />
      )}
      <span className="uru-home-art-label">
        <b>❋ urufu gēmu</b> / soft + cruel
      </span>
    </div>
  );
}
