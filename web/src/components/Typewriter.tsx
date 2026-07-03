'use client';

import { useEffect, useState } from 'react';

interface Props {
  text: string;
  speed?: number;
  startDelay?: number;
  className?: string;
}

/// Reveals text one character at a time, then blinks a cursor until animation completes.
/// Inspired by the Mainframe hero pattern but stripped down to Next-friendly deps.
export function Typewriter({ text, speed = 38, startDelay = 600, className }: Props) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let index = 0;
    const start = setTimeout(() => {
      const interval = setInterval(() => {
        index += 1;
        setDisplayed(text.slice(0, index));
        if (index >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
      return () => clearInterval(interval);
    }, startDelay);
    return () => clearTimeout(start);
  }, [text, speed, startDelay]);

  return (
    <p className={className}>
      {displayed}
      {!done && (
        <span
          aria-hidden="true"
          className="ml-[2px] inline-block h-[1.1em] w-[2px] align-middle bg-current"
          style={{ animation: 'typewriter-blink 1s step-end infinite' }}
        />
      )}
      <style>{`
        @keyframes typewriter-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </p>
  );
}
