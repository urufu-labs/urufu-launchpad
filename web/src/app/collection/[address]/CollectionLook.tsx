'use client';

/// The creator's saved look, shared by every page that shows a collection:
/// /collection/[address] (with live preview while the launcher edits) and
/// /market/[address]. Wrap the page in <LookShell>, then place <LookBanner>
/// and <CreatorLinks> where they belong in that page's layout.

import { useEffect, useState, type ReactNode } from 'react';

import { toGatewayUrl } from '@/lib/ipfsFetch';
import { fetchCollectionMetadata, type RemoteCollectionMetadata } from '@/lib/socialApi';
import { draftFromMeta, type PageDraft } from './CreatorTools';
import { cssUrl, forcedMode, linkHost, safeImageUrl, themeStyle } from './collectionTheme';
import styles from './collection.module.css';

/// Saved page details for a collection; null until loaded or when none.
export function useCollectionMeta(chainId: number, collection: string): [
  RemoteCollectionMetadata | null,
  (next: RemoteCollectionMetadata) => void,
] {
  const [meta, setMeta] = useState<RemoteCollectionMetadata | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const row = await fetchCollectionMetadata(chainId, collection as `0x${string}`);
      if (!cancelled) setMeta(row);
    })();
    return () => { cancelled = true; };
  }, [chainId, collection]);
  return [meta, setMeta];
}

export function lookFrom(meta: RemoteCollectionMetadata | null, preview: PageDraft | null = null): PageDraft {
  return preview ?? draftFromMeta(meta);
}

/// CSS url() for a look image. data: URLs only in the launcher's own preview.
export function lookImageCss(u: string | null | undefined, preview: boolean): string | null {
  const safe = safeImageUrl(u, preview);
  if (!safe) return null;
  return cssUrl(safe.startsWith('data:') ? safe : (toGatewayUrl(safe) ?? safe));
}

/// Collection image as a plain URL (for <img> / existing art components).
export function lookImageUrl(look: PageDraft, preview: boolean): string | null {
  const safe = safeImageUrl(look.imageUrl, preview);
  if (!safe) return null;
  return safe.startsWith('data:') ? safe : toGatewayUrl(safe);
}

/// Full-width wrapper: accent, fonts, background, and light/dark pinning.
export function LookShell({ look, preview = false, children }: { look: PageDraft; preview?: boolean; children: ReactNode }) {
  const wallpaper = look.design.wallpaper;
  const bannerCss = lookImageCss(look.bannerUrl, preview);
  const wallImageCss = wallpaper.type === 'image' ? lookImageCss(wallpaper.imageUrl, preview) : null;
  const mode = forcedMode(look.design);
  return (
    <div className={styles.themeShell} style={themeStyle(look)} data-force-theme={mode ?? undefined}>
      {bannerCss && wallpaper.type === 'banner' && (
        <div className={styles.backdrop} style={{ backgroundImage: bannerCss }} aria-hidden="true" />
      )}
      {wallImageCss && (
        <div
          className={styles.wallImage}
          style={{
            backgroundImage: wallImageCss,
            filter: wallpaper.blur ? `blur(${Math.min(40, Math.max(0, wallpaper.blur))}px)` : undefined,
          }}
          aria-hidden="true"
        />
      )}
      {children}
    </div>
  );
}

export function LookBanner({ look, preview = false, name }: { look: PageDraft; preview?: boolean; name?: string }) {
  const bannerCss = lookImageCss(look.bannerUrl, preview);
  if (!bannerCss) return null;
  return (
    <div
      className={styles.banner}
      role="img"
      aria-label={`${name ?? 'collection'} banner`}
      style={{ backgroundImage: bannerCss }}
    />
  );
}

/// The creator's own link buttons and cards. Every link opens in a new tab
/// and shows where it goes.
export function CreatorLinks({ look, preview = false }: { look: PageDraft; preview?: boolean }) {
  const links = look.links.filter((l) => l.title && /^https?:\/\/\S+$/i.test(l.url));
  if (links.length === 0) return null;
  return (
    <section className={styles.creatorLinks} aria-label="Links from the creator">
      {links.map((l) => {
        const thumb = lookImageCss(l.thumbnailUrl, preview);
        return l.style === 'featured' ? (
          <a key={l.id} className={styles.linkCard} href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">
            <span className={styles.linkCardImage} style={thumb ? { backgroundImage: thumb } : undefined} aria-hidden="true" />
            <span className={styles.linkCardText}>
              <span className={styles.linkTitle}>{l.title}</span>
              <span className={styles.linkHost}>{linkHost(l.url)}</span>
            </span>
          </a>
        ) : (
          <a key={l.id} className={styles.linkButton} href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">
            {thumb && <span className={styles.linkIcon} style={{ backgroundImage: thumb }} aria-hidden="true" />}
            <span className={styles.linkTitle}>{l.title}</span>
            <span className={styles.linkHost}>{linkHost(l.url)}</span>
          </a>
        );
      })}
    </section>
  );
}
