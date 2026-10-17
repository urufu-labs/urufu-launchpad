'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { useEffect, useState } from 'react';

import { IconExplore, IconFeed, IconPlus, IconTrade, IconUser } from './icons';
import { isActivePath } from './SiteHeader';
import styles from './shell.module.css';

/// Phone-only bottom tab bar (hidden above 760px by CSS).
export function MobileTabBar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const profileHref = mounted && isConnected && address ? `/profile/${address}` : '/profile';

  const tabs = [
    { href: '/discover', label: 'Explore', icon: <IconExplore />, match: '/discover' },
    { href: '/trade', label: 'Trade', icon: <IconTrade />, match: '/trade' },
    { href: '/create', label: 'Launch', icon: <IconPlus />, match: '/create' },
    { href: '/feed', label: 'Feed', icon: <IconFeed />, match: '/feed' },
    { href: profileHref, label: 'Profile', icon: <IconUser />, match: '/profile' },
  ];

  return (
    <nav className={styles.tabbar} aria-label="Primary">
      {tabs.map((t) => (
        <Link key={t.label} href={t.href} className={styles.tab} aria-current={isActivePath(pathname, t.match) ? 'page' : undefined}>
          {t.icon}
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
