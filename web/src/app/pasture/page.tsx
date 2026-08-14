import Link from 'next/link';

const GAME_URL = '/pasture-game/index.html?world=proc';

export default function PasturePage() {
  return (
    <main className="pasture-shell">
      <header className="pasture-bar">
        <Link href="/">← urufu labs</Link>
        <p><b>wolves &amp; wool</b> / pasture found</p>
        <a href={GAME_URL} target="_blank" rel="noreferrer">open game ↗</a>
      </header>
      <iframe
        className="pasture-game-frame"
        src={GAME_URL}
        title="Wolves & Wool"
        allowFullScreen
      />
    </main>
  );
}
