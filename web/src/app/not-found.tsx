/// 404 page. Next.js App Router auto-mounts this at any URL that doesn't
/// resolve to a route. A small confused mascot plus plain wayfinding links,
/// so a lost visitor lands somewhere on-brand instead of the browser's
/// default "the requested page was not found on this server" prose.
///
/// Static — no client state, no data fetches. Renders identically for
/// every miss so we don't burn a serverless invocation per 404.

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';
import styles from './not-found.module.css';

export default function NotFound() {
  return (
    <div className={styles.page}>
      {/* Small confused mascot. Bobs gently like the header mascot for
          continuity. */}
      <Mascot size={56} mood="confused" className="uru-idle-bob" />

      <div className={styles.copy}>
        <p className={styles.eyebrow}>Page not found</p>
        <h1 className={styles.title}>We couldn&apos;t find that page</h1>
        <p className={styles.lede}>
          The page you&apos;re looking for doesn&apos;t exist, or it may have moved.
          Try one of these instead.
        </p>
      </div>

      {/* Wayfinding — the most useful destinations someone-who-got-lost
          might want. Kept to five so it stays scannable. */}
      <nav className={styles.nav} aria-label="Recovery links">
        <Link href="/" className="ui-btn" data-variant="primary" data-size="lg">Go to home</Link>
        <NavLink href="/create" label="Launch a token" />
        <NavLink href="/trade" label="Trade" />
        <NavLink href="/flywheel" label="Flywheel" />
        <NavLink href="/docs" label="Docs" />
      </nav>

      <p className={styles.foot}>urufu labs runs on Robinhood Chain (chain ID 4663).</p>
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="ui-btn" data-size="lg">
      {label}
    </Link>
  );
}
