import Image from 'next/image';
import Link from 'next/link';

import styles from './shell.module.css';

const COLUMNS: Array<{ title: string; links: Array<{ href: string; label: string; external?: boolean }> }> = [
  {
    title: 'Product',
    links: [
      { href: '/discover', label: 'Explore' },
      { href: '/trade', label: 'Trade' },
      { href: '/market', label: 'NFT market' },
      { href: '/create', label: 'Launch a token' },
      { href: '/flywheel', label: 'Flywheel' },
    ],
  },
  {
    title: 'Learn',
    links: [
      { href: '/docs', label: 'How it works' },
      { href: '/catalog', label: 'Launch options' },
      { href: '/recover', label: 'Recover ETH' },
    ],
  },
  {
    title: 'urufu',
    links: [
      { href: 'https://www.urufu.xyz', label: 'urufu gemu', external: true },
      { href: 'https://studio.urufulabs.xyz/', label: 'Chibi studio', external: true },
      { href: 'https://x.com/urugemu', label: 'X', external: true },
      { href: 'https://discord.gg/urufugemu', label: 'Discord', external: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Link href="/" className={styles.brand} aria-label="urufu labs home">
            <Image src="/brand/logo-64.png" alt="" aria-hidden width={28} height={28} className={styles.brandLogo} />
            <span className={styles.brandName}>
              urufu<b>labs</b>
            </span>
          </Link>
          <p>Launch a token on Robinhood Chain. When it fills its curve, liquidity moves to Uniswap v4 and locks forever.</p>
        </div>
        {COLUMNS.map((col) => (
          <nav key={col.title} className={styles.footerCol} aria-label={col.title}>
            <h3>{col.title}</h3>
            <ul>
              {col.links.map((l) => (
                <li key={l.href}>
                  {l.external ? (
                    <a href={l.href} target="_blank" rel="noopener noreferrer">
                      {l.label} ↗
                    </a>
                  ) : (
                    <Link href={l.href}>{l.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className={styles.footerBase}>
        <span>© {new Date().getFullYear()} urufu labs</span>
        <span>
          Built on{' '}
          <a href="https://docs.uniswap.org/contracts/v4/overview" target="_blank" rel="noopener noreferrer">
            Uniswap v4 hooks
          </a>
        </span>
      </div>
    </footer>
  );
}
