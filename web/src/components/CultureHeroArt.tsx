'use client';

import { useEffect, useRef, useState } from 'react';

type Theme = 'light' | 'dark';

const VIDEO_BY_THEME: Record<Theme, string | null> = {
  light: '/urufu-altar-light-loop-v1.mp4',
  dark: '/urufu-altar-ring-braid-loop-v1.mp4',
};

function appliedTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function CultureHeroArt() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const [videoReady, setVideoReady] = useState(false);
  const videoSource = VIDEO_BY_THEME[theme];

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
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setVideoReady(false);
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
  }, [videoSource]);

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
