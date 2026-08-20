'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AudioToggle } from '@/components/AudioToggle';
import { ChainSwitcher } from '@/components/ChainSwitcher';
import { PriceUnitToggle } from '@/components/PriceUnitToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import styles from './MobileNavigation.module.css';

const primaryLinks = [
  { href: '/create', label: '✦ launch token', primary: true },
  { href: '/create/nft', label: '❁ launch nft', primary: true },
  { href: '/discover', label: '❁ launches' },
  { href: '/trade', label: '✦ trade' },
  { href: '/feed', label: '☆ feed' },
  { href: '/profile', label: '♡ profile' },
];

const utilityLinks = [
  { href: '/catalog', label: '❀ modules' },
  { href: '/docs', label: '❉ docs' },
  { href: '/recover', label: '✿ recover eth' },
];

const communityLinks = [
  { href: 'https://studio.urufulabs.xyz/', label: '✿ chibi studio ↗' },
  { href: 'https://www.urufu.xyz', label: '❋ urufu gemu ↗' },
  { href: 'https://x.com/urugemu', label: '✧ twitter ↗' },
  { href: 'https://t.me/urugemu', label: '✧ telegram ↗' },
];

export function MobileNavigation() {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef(true);
  const pathname = usePathname();
  // Match root strictly, but treat everything else as "this section is active"
  // when the pathname starts with the href. So /trade/0xabc… highlights the
  // /trade link, /profile/xyz highlights /profile, etc.
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');

  const closeMenu = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setIsOpen(false);
  };

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const closeAtDesktop = () => {
      if (query.matches) {
        restoreFocusRef.current = false;
        setIsOpen(false);
      }
    };

    query.addEventListener('change', closeAtDesktop);
    closeAtDesktop();
    return () => query.removeEventListener('change', closeAtDesktop);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    const focusFirst = window.requestAnimationFrame(() => focusable()[0]?.focus());
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }

      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (restoreFocusRef.current) trigger?.focus();
    };
  }, [isOpen]);

  return (
    <div className={styles.mobileNavigation}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.menuButton}
        aria-label={isOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={isOpen}
        aria-controls="mobile-navigation-drawer"
        onClick={() => (isOpen ? closeMenu() : setIsOpen(true))}
      >
        <span className={styles.menuGlyph} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.menuLabel}>menu</span>
      </button>

      {isOpen && (
        <div className={styles.drawerLayer}>
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Close navigation"
            onClick={() => closeMenu()}
          />
          <aside
            ref={panelRef}
            id="mobile-navigation-drawer"
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-navigation-title"
          >
            <header className={styles.drawerHeader}>
              <div>
                <span className={styles.kicker}>urufu labs</span>
                <h2 id="mobile-navigation-title">navigation</h2>
              </div>
              <button type="button" className={styles.closeButton} onClick={() => closeMenu()}>
                close <span aria-hidden="true">×</span>
              </button>
            </header>

            <nav className={styles.primaryLinks} aria-label="Mobile primary navigation">
              {primaryLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={link.primary ? styles.primaryLink : styles.primaryLinkSecondary}
                  data-active={isActive(link.href) || undefined}
                  aria-current={isActive(link.href) ? 'page' : undefined}
                  onClick={() => closeMenu(false)}
                >
                  {link.label}
                </Link>
              ))}
            </nav>

            <section className={styles.controlSection} aria-labelledby="mobile-account-title">
              <h3 id="mobile-account-title">chain</h3>
              <ChainSwitcher />
            </section>

            <section className={styles.controlSection} aria-labelledby="mobile-preferences-title">
              <h3 id="mobile-preferences-title">preferences</h3>
              <div className={styles.preferences}>
                <PriceUnitToggle />
                <ThemeToggle />
                <AudioToggle />
              </div>
            </section>

            <section className={styles.linkSection} aria-labelledby="mobile-tools-title">
              <h3 id="mobile-tools-title">tools</h3>
              <nav aria-label="Mobile utility navigation">
                {utilityLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    data-active={isActive(link.href) || undefined}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    onClick={() => closeMenu(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </section>

            <section className={styles.linkSection} aria-labelledby="mobile-community-title">
              <h3 id="mobile-community-title">elsewhere</h3>
              <nav aria-label="Urufu community links">
                {communityLinks.map((link) => (
                  <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                ))}
              </nav>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
