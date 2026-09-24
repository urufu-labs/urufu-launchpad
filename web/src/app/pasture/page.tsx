import Link from 'next/link';

export default function PasturePage() {
  return (
    <main className="uru-pasture-shell">
      <section className="uru-pasture-frame" aria-labelledby="pasture-title">
        <p className="uru-pasture-kicker">urufu pasture / grazing ground</p>
        <h1 id="pasture-title" className="uru-pasture-title">
          the flock is <span>gathering</span> ~
        </h1>
        <p className="uru-pasture-copy">
          the wolf and sheep game is making its way through the gate. this is
          where the port will play when it is ready.
        </p>
        <div className="uru-pasture-actions">
          <Link href="/" className="uru-btn uru-btn-primary">
            back to the launchpad <span className="uru-arrow">→</span>
          </Link>
          <a
            href="https://www.urufu.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="uru-btn uru-btn-cream"
          >
            visit urufu gēmu <span className="uru-arrow">↗</span>
          </a>
        </div>
      </section>
    </main>
  );
}
