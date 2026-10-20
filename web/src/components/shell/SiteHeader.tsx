'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { CreateNavDropdown } from '@/components/CreateNavDropdown';
import { PriceUnitToggle } from '@/components/PriceUnitToggle';
import { ChainSwitcher } from '@/components/ChainSwitcher';
import { WalletButton } from '@/components/WalletButton';
import { UserSearchLauncher } from '@/components/UserSearchModal';
import { MobileNavigation } from '@/components/MobileNavigation';
import { SettingsMenu } from './SettingsMenu';
import styles from './shell.module.css';

const NAV = [
  { href: '/discover', label: 'Explore' },
  { href: '/trade', label: 'Trade' },
  { href: '/market', label: 'Market' },
  { href: '/feed', label: 'Feed' },
  { href: '/flywheel', label: 'Flywheel' },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
}

/// Sticky site header (docs/PLAN-ui-revamp.md, Phase 2). Primary routes on the
/// left, then search, price unit, chain, settings and wallet. Below 1020px the
/// route links move into the menu sheet and the mobile tab bar.
export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="urufu labs home">
        <Image src="/brand/logo-64.png" alt="" aria-hidden width={32} height={32} priority className={styles.brandLogo} />
        <span className={styles.brandName}>
          urufu<b>labs</b>
        </span>
      </Link>

      <nav className={styles.nav} aria-label="Primary">
        <Link href={NAV[0].href} className={styles.navLink} aria-current={isActivePath(pathname, NAV[0].href) ? 'page' : undefined}>
          {NAV[0].label}
        </Link>
        <Link href={NAV[1].href} className={styles.navLink} aria-current={isActivePath(pathname, NAV[1].href) ? 'page' : undefined}>
          {NAV[1].label}
        </Link>
        <CreateNavDropdown />
        {NAV.slice(2).map((item) => (
          <Link key={item.href} href={item.href} className={styles.navLink} aria-current={isActivePath(pathname, item.href) ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>

      <div className={styles.right}>
        <UserSearchLauncher />
        <span className={styles.hideMd}>
          <PriceUnitToggle />
        </span>
        <span className={styles.hideMd}>
          <ChainSwitcher />
        </span>
        <span className={styles.hideSm}>
          <SettingsMenu />
        </span>
        <WalletButton />
        <MobileNavigation />
      </div>
    </header>
  );
}
