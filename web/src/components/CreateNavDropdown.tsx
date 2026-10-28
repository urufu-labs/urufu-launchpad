'use client';

/// Header "Launch" menu: token (/create), NFT collection (/create/nft) and
/// DN404 (/create/dn404) and Fair launch (/create/fair). Opens on hover or click.
/// NFT, DN404 and Fair show "soon" when their launch flags are off for the active chain.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NFT_LAUNCHES_ENABLED, DN404_LAUNCHES_ENABLED, FAIR_LAUNCHES_ENABLED, SWARM_LAUNCHES_ENABLED } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { Menu } from '@/components/ui/Menu';
import { IconChevron } from '@/components/shell/icons';
import styles from '@/components/shell/shell.module.css';

const ITEMS = [
  { href: '/create', title: 'Token', desc: 'A coin on a bonding curve', flag: null },
  { href: '/create/nft', title: 'NFT collection', desc: 'Art people mint at your price', flag: 'nft' },
  { href: '/create/dn404', title: 'DN404', desc: 'A coin and NFTs in one', flag: 'dn404' },
  { href: '/create/fair', title: 'Fair launch', desc: 'No sniper or bundle edge', flag: 'fair' },
  { href: '/swarms', title: 'Swarm launch', desc: 'Pool ETH to back a coin together', flag: 'swarm' },
] as const;

export function CreateNavDropdown() {
  const pathname = usePathname();
  const activeChain = useActiveChain();
  const enabled = {
    nft: NFT_LAUNCHES_ENABLED[activeChain] === true,
    dn404: DN404_LAUNCHES_ENABLED[activeChain] === true,
    fair: FAIR_LAUNCHES_ENABLED[activeChain] === true,
    swarm: SWARM_LAUNCHES_ENABLED[activeChain] === true,
  };
  const inCreate = pathname === '/create' || pathname.startsWith('/create/');

  return (
    <Menu
      label="Launch"
      align="start"
      width={250}
      openOnHover
      trigger={(open) => (
        <button
          type="button"
          className={styles.navLink}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-current={inCreate ? 'page' : undefined}
        >
          Launch <IconChevron />
        </button>
      )}
    >
      {(close) =>
        ITEMS.map((item) => {
          const on = item.flag === null || enabled[item.flag];
          return on ? (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              className="ui-menu-item"
              data-active={pathname === item.href ? 'true' : undefined}
              onClick={close}
            >
              <span className="ui-menu-desc">
                {item.title}
                <span>{item.desc}</span>
              </span>
            </Link>
          ) : (
            <span key={item.href} role="menuitem" aria-disabled="true" className="ui-menu-item">
              <span className="ui-menu-desc">
                {item.title}
                <span>{item.desc}</span>
              </span>
              <small>soon</small>
            </span>
          );
        })
      }
    </Menu>
  );
}
