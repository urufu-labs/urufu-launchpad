'use client';

/// Launcher-only "Customize your page" panel on /collection/[address], for
/// both the NFT lane and the DN404 lane. Four tabs:
///
///   Look      one-click themes, banner, collection image, accent color,
///             title + text fonts, wallpaper (site / tint / banner / color /
///             gradient / image).
///   Links     the creator's own link buttons (Linktree-style): a compact
///             button or a big card with a picture, reorderable, up to 12.
///   About     description + socials.
///   Advanced  on-chain contractURI / baseURI (OnChainLinks.tsx).
///
/// Look / Links / About are stored off-chain by compile-service
/// (`/collection/:chainId/:address/metadata`) behind one signed message; the
/// server only accepts the indexer's launchedBy wallet when it is also the
/// on-chain owner. Every edit previews live on the page for the launcher only.
///
/// The caller decides visibility. This component also re-checks that the
/// connected wallet is the on-chain owner and renders nothing otherwise.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContracts, useSignMessage } from 'wagmi';
import type { Address } from 'viem';

import { readFileAsDataUrl } from '@/lib/metadata';
import { uploadImageToIpfs } from '@/lib/ipfs';
import { saveCollectionMetadata, type RemoteCollectionMetadata } from '@/lib/socialApi';
import type { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { FONT_IDS, FONTS, type FontId } from './collectionFonts';
import {
  ACCENT_PRESETS,
  THEMES,
  cssUrl,
  forcedMode,
  hardToReadOn,
  isHexColor,
  type PageDesign,
  type PageLink,
  type ThemeId,
  type Wallpaper,
  type WallpaperType,
} from './collectionTheme';
import { OnChainLinks, uriAdminAbi } from './OnChainLinks';
import { artPalette } from './artPalette';
import { toGatewayUrl } from '@/lib/ipfsFetch';
import styles from './collection.module.css';

function isHttpUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v.trim());
}

function emptyToNull(v: string): string | null {
  const t = v.trim();
  return t.length > 0 ? t : null;
}

const SAVE_ERRORS: Record<string, string> = {
  NOT_LAUNCHER: 'Only the wallet that launched this collection can edit its page.',
  NOT_OWNER: 'This wallet no longer owns the collection contract, so it cannot edit the page.',
  INDEXER_PENDING: 'This collection is still being picked up by the site. Try again in a minute.',
  OWNER_LOOKUP_FAILED: 'Could not check the owner on-chain right now. Try again in a moment.',
  UNAUTHORIZED: 'The signature did not check out. Try saving again.',
  BAD_BODY: 'Something in the form is not valid. Check the links and try again.',
};

const WALLPAPER_OPTIONS: { value: WallpaperType; label: string }[] = [
  { value: 'default', label: 'Site' },
  { value: 'tint', label: 'Tint' },
  { value: 'banner', label: 'Banner' },
  { value: 'color', label: 'Color' },
  { value: 'gradient', label: 'Gradient' },
  { value: 'image', label: 'Image' },
];

const MAX_LINKS = 12;

type Tab = 'look' | 'links' | 'about' | 'advanced';

/// What the page should show while the launcher edits. Image fields may hold
/// a local data: URL for a picked file that has not been uploaded yet.
export interface PageDraft {
  imageUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  design: Required<Pick<PageDesign, 'theme' | 'titleFont' | 'bodyFont'>> & { wallpaper: Wallpaper };
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  links: PageLink[];
}

/// An image the launcher can upload, paste a link for, or remove.
interface ImageValue { url: string; dataUrl: string | null }

interface LinkDraft {
  id: string;
  title: string;
  url: string;
  style: 'classic' | 'featured';
  thumb: ImageValue;
}

function img(url: string | null | undefined): ImageValue {
  return { url: url ?? '', dataUrl: null };
}

function imgValue(v: ImageValue): string | null {
  return v.dataUrl ?? emptyToNull(v.url);
}

/// One canonical shape for a wallpaper, so saved and edited values compare
/// equal when they mean the same thing.
function normWallpaper(w: Wallpaper | undefined | null): Wallpaper {
  switch (w?.type) {
    case 'tint':
    case 'banner':
      return { type: w.type };
    case 'color':
      return { type: 'color', color: w.color ?? '#111111' };
    case 'gradient':
      return { type: 'gradient', color: w.color ?? '#111214', color2: w.color2 ?? '#2b2f36' };
    case 'image':
      return { type: 'image', imageUrl: w.imageUrl ?? null, blur: w.blur ?? 0 };
    default:
      return { type: 'default' };
  }
}

/// Rows saved before 2026-10-24 have design / links stored as a JSON string
/// inside the jsonb column, so the API hands them back as text. Accept both.
function parseJsonField<T>(v: T | string | null | undefined): T | null {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export function draftFromMeta(meta: RemoteCollectionMetadata | null): PageDraft {
  const d = parseJsonField(meta?.design);
  const savedLinks = parseJsonField(meta?.links);
  return {
    imageUrl: meta?.imageUrl ?? null,
    bannerUrl: meta?.bannerUrl ?? null,
    accentColor: meta?.accentColor ?? null,
    design: {
      theme: d?.theme ?? 'site',
      titleFont: d?.titleFont ?? 'default',
      bodyFont: d?.bodyFont ?? 'default',
      wallpaper: normWallpaper(d?.wallpaper),
    },
    description: meta?.description ?? null,
    website: meta?.website ?? null,
    twitter: meta?.twitter ?? null,
    telegram: meta?.telegram ?? null,
    discord: meta?.discord ?? null,
    links: (Array.isArray(savedLinks) ? savedLinks : []).map((l) => ({
      id: l.id, title: l.title, url: l.url, style: l.style, thumbnailUrl: l.thumbnailUrl ?? null,
    })),
  };
}

let linkSeq = 0;
function newLinkId(): string {
  linkSeq += 1;
  return `l${Date.now().toString(36)}${linkSeq}`.slice(0, 24);
}

export function CreatorTools({
  collection,
  ownerTarget,
  chainId,
  pageMeta,
  onPageMetaSaved,
  onPreview,
  collectionName,
  artImage,
}: {
  /// The ERC-721 the page lives at (the DN404 mirror on that lane).
  collection: Address;
  /// Contract holding owner() + the URI setters: the collection on the NFT
  /// lane, the base ERC-20 on the DN404 lane.
  ownerTarget: Address;
  chainId: (typeof CHAIN_KEY_TO_ID)[keyof typeof CHAIN_KEY_TO_ID];
  pageMeta: RemoteCollectionMetadata | null;
  onPageMetaSaved: (next: RemoteCollectionMetadata) => void;
  /// Live preview of unsaved edits; null when nothing differs from saved.
  onPreview: (draft: PageDraft | null) => void;
  /// For the theme previews.
  collectionName?: string;
  /// The art the page shows now (cover or first NFT), for theme previews and
  /// for pulling accent colors when no collection image is set.
  artImage?: string | null;
}) {
  const { address: wallet } = useAccount();

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { address: ownerTarget, abi: uriAdminAbi, functionName: 'owner', chainId },
      { address: ownerTarget, abi: uriAdminAbi, functionName: 'baseURI', chainId },
      { address: ownerTarget, abi: uriAdminAbi, functionName: 'contractURI', chainId },
    ],
    query: { staleTime: 10_000 },
  });
  const owner = reads?.[0]?.result as Address | undefined;
  const currentBaseUri = (reads?.[1]?.result as string | undefined) ?? '';
  const currentContractUri = (reads?.[2]?.result as string | undefined) ?? '';
  const isOwner = !!wallet && !!owner && wallet.toLowerCase() === owner.toLowerCase();

  // ------------------------------------------------------------ draft state
  const [tab, setTab] = useState<Tab>('look');
  const [cover, setCover] = useState<ImageValue>(img(null));
  const [banner, setBanner] = useState<ImageValue>(img(null));
  const [accent, setAccent] = useState('');
  const [theme, setTheme] = useState<ThemeId>('site');
  const [titleFont, setTitleFont] = useState<FontId>('default');
  const [bodyFont, setBodyFont] = useState<FontId>('default');
  const [wallType, setWallType] = useState<WallpaperType>('default');
  const [wallColor, setWallColor] = useState('#111111');
  const [wallColor2, setWallColor2] = useState('#2b2f36');
  const [wallImage, setWallImage] = useState<ImageValue>(img(null));
  const [wallBlur, setWallBlur] = useState(0);
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [discord, setDiscord] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { signMessageAsync } = useSignMessage();

  const savedDraft = useMemo(() => draftFromMeta(pageMeta), [pageMeta]);

  const loadFrom = useCallback((d: PageDraft) => {
    setCover(img(d.imageUrl));
    setBanner(img(d.bannerUrl));
    setAccent(d.accentColor ?? '');
    setTheme(d.design.theme);
    setTitleFont(d.design.titleFont);
    setBodyFont(d.design.bodyFont);
    const w = d.design.wallpaper;
    setWallType(w.type);
    if (w.color) setWallColor(w.color);
    if (w.color2) setWallColor2(w.color2);
    setWallImage(img(w.imageUrl));
    setWallBlur(w.blur ?? 0);
    setLinks(d.links.map((l) => ({ id: l.id, title: l.title, url: l.url, style: l.style, thumb: img(l.thumbnailUrl) })));
    setDescription(d.description ?? '');
    setWebsite(d.website ?? '');
    setTwitter(d.twitter ?? '');
    setTelegram(d.telegram ?? '');
    setDiscord(d.discord ?? '');
  }, []);

  // Prefill from what is saved now, once it loads.
  useEffect(() => { loadFrom(savedDraft); }, [savedDraft, loadFrom]);

  const draft: PageDraft = useMemo(() => ({
    imageUrl: imgValue(cover),
    bannerUrl: imgValue(banner),
    accentColor: isHexColor(accent) ? accent.toLowerCase() : null,
    design: {
      theme,
      titleFont,
      bodyFont,
      wallpaper: normWallpaper({
        type: wallType, color: wallColor, color2: wallColor2, imageUrl: imgValue(wallImage), blur: wallBlur,
      }),
    },
    description: emptyToNull(description),
    website: emptyToNull(website),
    twitter: emptyToNull(twitter),
    telegram: emptyToNull(telegram),
    discord: emptyToNull(discord),
    links: links.map((l) => ({
      id: l.id, title: l.title.trim(), url: l.url.trim(), style: l.style, thumbnailUrl: imgValue(l.thumb),
    })),
  }), [cover, banner, accent, theme, titleFont, bodyFont, wallType, wallColor, wallColor2, wallImage, wallBlur,
    description, website, twitter, telegram, discord, links]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

  // Accent suggestions from the creator's own banner + art. Same-origin
  // (/api/ipfs) and data: images can be read; others are skipped.
  const asSrc = (v: string | null) => (v && !v.startsWith('data:') ? toGatewayUrl(v) : v);
  const tileArt = asSrc(draft.imageUrl) ?? artImage ?? null;
  const paletteSrcs = [asSrc(draft.bannerUrl), tileArt];
  const paletteKey = paletteSrcs.map((x) => (x ?? '').slice(0, 200)).join('|');
  const [palette, setPalette] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void artPalette(paletteSrcs, 6).then((p) => { if (!cancelled) setPalette(p); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey]);

  useEffect(() => {
    onPreview(isOwner && dirty ? draft : null);
  }, [isOwner, dirty, draft, onPreview]);
  // Drop the preview if the panel goes away (wallet disconnects etc).
  useEffect(() => () => onPreview(null), [onPreview]);

  const imageOk = (v: ImageValue) => v.dataUrl !== null || v.url.trim() === '' || isHttpUrl(v.url);
  const coverOk = imageOk(cover);
  const bannerOk = imageOk(banner);
  const wallImageOk = wallType !== 'image' || imageOk(wallImage);
  const websiteOk = website.trim() === '' || isHttpUrl(website);
  const badLinks = links.filter((l) => !l.title.trim() || !isHttpUrl(l.url) || !imageOk(l.thumb));
  const formOk = coverOk && bannerOk && wallImageOk && websiteOk && badLinks.length === 0;
  const mode = forcedMode(draft.design);
  const accentWarn = isHexColor(accent)
    ? hardToReadOn(accent, mode, wallType === 'color' ? wallColor : null)
    : [];

  const touch = () => { setSaved(false); setSaveError(null); };
  /// Any manual look change means the page no longer matches a preset.
  const custom = () => { setTheme('custom'); touch(); };

  function applyTheme(id: (typeof THEMES)[number]['id']) {
    const t = THEMES.find((x) => x.id === id);
    if (!t) return;
    setTheme(t.id);
    setAccent(t.accent ?? '');
    setTitleFont(t.design.titleFont ?? 'default');
    setBodyFont(t.design.bodyFont ?? 'default');
    const w = normWallpaper(t.design.wallpaper);
    setWallType(w.type);
    if (w.color) setWallColor(w.color);
    if (w.color2) setWallColor2(w.color2);
    touch();
  }

  function updateLink(id: string, patch: Partial<LinkDraft>) {
    setLinks((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    touch();
  }
  function moveLink(id: string, dir: -1 | 1) {
    setLinks((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    touch();
  }

  async function upload(v: string | null): Promise<string | null | 'failed'> {
    if (!v || !v.startsWith('data:')) return v;
    const pinned = await uploadImageToIpfs(v);
    return pinned ? pinned.gatewayUrl : 'failed';
  }

  async function savePage() {
    if (!wallet || !formOk) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const w = draft.design.wallpaper;
      const [imageUrl, bannerUrl, wallUrl, ...thumbs] = await Promise.all([
        upload(draft.imageUrl),
        upload(draft.bannerUrl),
        upload(w.type === 'image' ? w.imageUrl ?? null : null),
        ...draft.links.map((l) => upload(l.thumbnailUrl ?? null)),
      ]);
      if ([imageUrl, bannerUrl, wallUrl, ...thumbs].includes('failed')) {
        setSaveError('Could not upload an image. Try again, or paste an image link instead.');
        return;
      }
      const wallpaper: Wallpaper = w.type === 'image' ? { ...w, imageUrl: wallUrl as string | null } : w;
      const design: PageDesign = { ...draft.design, wallpaper };
      const isDefaultDesign = JSON.stringify(design) === JSON.stringify(draftFromMeta(null).design);
      const savedLinks: PageLink[] = draft.links.map((l, i) => ({ ...l, thumbnailUrl: thumbs[i] as string | null }));
      const payload = {
        chainId,
        collectionAddress: collection.toLowerCase() as Address,
        imageUrl: imageUrl as string | null,
        bannerUrl: bannerUrl as string | null,
        accentColor: draft.accentColor,
        design: isDefaultDesign ? null : design,
        links: savedLinks.length > 0 ? savedLinks : null,
        description: draft.description,
        website: draft.website,
        twitter: draft.twitter,
        telegram: draft.telegram,
        discord: draft.discord,
      };
      const res = await saveCollectionMetadata(wallet, payload, ({ message }) => signMessageAsync({ message }));
      if (!res.ok) {
        setSaveError(SAVE_ERRORS[res.error] ?? `Save failed (${res.error}).`);
        return;
      }
      setSaved(true);
      onPageMetaSaved({ ...payload, updatedAt: new Date().toISOString(), owner: wallet });
    } catch {
      setSaveError('Save cancelled.');
    } finally {
      setSaving(false);
    }
  }

  if (!isOwner) return null;

  return (
    <section className="ui-panel" id="customize">
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Customize your page</h2>
        <span className="ui-badge" data-tone="info">Only you</span>
      </div>
      <div className={`ui-panel-body ${styles.launcherBody}`}>
        <div className={styles.toolTabs} role="tablist" aria-label="Customize sections">
          {(['look', 'links', 'about', 'advanced'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-selected={tab === t ? 'true' : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'look' ? 'Look' : t === 'links' ? `Links${links.length ? ` (${links.length})` : ''}` : t === 'about' ? 'About' : 'Advanced'}
            </button>
          ))}
        </div>

        {tab === 'look' && (
          <>
            <div className="ui-field">
              <span className="ui-field-label">Theme</span>
              <div className={styles.themeGrid}>
                {THEMES.map((t) => {
                  const w = normWallpaper(t.design.wallpaper);
                  const bg = w.type === 'color' && w.color ? w.color : 'var(--bg)';
                  const mode = forcedMode(t.design);
                  // A tiny version of this page in the theme: the
                  // collection's own name and art, a mint-style button.
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={styles.themeTile}
                      data-selected={theme === t.id ? 'true' : undefined}
                      onClick={() => applyTheme(t.id)}
                      aria-label={`${t.label} theme`}
                    >
                      <span
                        className={styles.themeMini}
                        data-force-theme={mode ?? undefined}
                        style={{ background: bg }}
                      >
                        <span
                          className={styles.themeMiniArt}
                          style={tileArt ? { backgroundImage: cssUrl(tileArt) } : undefined}
                        />
                        <span
                          className={styles.themeMiniTitle}
                          style={{ fontFamily: FONTS[t.design.titleFont ?? 'default'].family ?? 'var(--font-display)' }}
                        >
                          {collectionName || 'Untitled'}
                        </span>
                        <span className={styles.themeMiniButton} style={{ background: t.accent ?? 'var(--accent)' }} />
                      </span>
                      <span className={styles.themeLabel}>{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <span className="ui-hint">
                {theme === 'custom' ? 'Custom look. Pick a theme to start over.' : 'A starting point. Change anything below.'}
              </span>
            </div>

            <ImagePicker
              label="Banner"
              wide
              hint="Runs across the top of the page. Around 1500 x 400."
              value={banner}
              onChange={(v) => { setBanner(v); touch(); }}
              onError={setSaveError}
            />
            {!bannerOk && <p className="ui-error">Image links must start with https://</p>}

            <ImagePicker
              label="Collection image"
              hint="Square works best."
              value={cover}
              onChange={(v) => { setCover(v); touch(); }}
              onError={setSaveError}
            />
            {!coverOk && <p className="ui-error">Image links must start with https://</p>}

            <div className="ui-field">
              <span className="ui-field-label">Accent color</span>
              {palette.length > 0 && <span className="ui-hint">From your art</span>}
              <div className={styles.swatchRow}>
                {(palette.length > 0 ? palette : ACCENT_PRESETS).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={styles.swatch}
                    style={{ background: c }}
                    data-selected={accent.toLowerCase() === c ? 'true' : undefined}
                    aria-label={`Use color ${c}`}
                    onClick={() => { setAccent(c); custom(); }}
                  />
                ))}
                <label className={styles.swatchCustom} title="Pick any color">
                  <input
                    type="color"
                    value={isHexColor(accent) ? accent : '#cc1e56'}
                    onChange={(e) => { setAccent(e.target.value); custom(); }}
                    aria-label="Pick any accent color"
                  />
                  <span>Custom</span>
                </label>
              </div>
              <span className="ui-hint">
                Buttons, links and highlights.{' '}
                {accent ? (
                  <button type="button" className={styles.linkBtn} onClick={() => { setAccent(''); custom(); }}>
                    Use the site color
                  </button>
                ) : 'Using the site color.'}
              </span>
              {accentWarn.length > 0 && (
                <span className="ui-hint">
                  Hard to read on this background. Try a {accentWarn[0] === 'light' ? 'darker' : 'lighter'} shade.
                </span>
              )}
            </div>

            <FontPicker label="Title font" value={titleFont} onChange={(f) => { setTitleFont(f); custom(); }} sample={'Wolves of the North'} />
            <FontPicker label="Text font" value={bodyFont} onChange={(f) => { setBodyFont(f); custom(); }} sample="Hold one, get one. 1,000 hand drawn pieces." />

            <div className="ui-field">
              <span className="ui-field-label">Background</span>
              <div className={styles.segmented} data-wrap="true" role="radiogroup" aria-label="Background">
                {WALLPAPER_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={wallType === o.value}
                    data-selected={wallType === o.value ? 'true' : undefined}
                    disabled={o.value === 'banner' && !draft.bannerUrl}
                    title={o.value === 'banner' && !draft.bannerUrl ? 'Add a banner first' : undefined}
                    onClick={() => { setWallType(o.value); custom(); }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {wallType === 'default' && <span className="ui-hint">The site&apos;s own background, light or dark per visitor.</span>}
              {wallType === 'tint' && <span className="ui-hint">A light wash of your accent color.</span>}
              {wallType === 'banner' && <span className="ui-hint">A soft, blurred copy of your banner behind the top of the page.</span>}
              {(wallType === 'color' || wallType === 'gradient') && (
                <div className={styles.colorRow}>
                  <label className={styles.colorInput}>
                    <input type="color" value={wallColor} onChange={(e) => { setWallColor(e.target.value); custom(); }} aria-label="Background color" />
                    <span className="ui-num">{wallColor}</span>
                  </label>
                  {wallType === 'gradient' && (
                    <label className={styles.colorInput}>
                      <input type="color" value={wallColor2} onChange={(e) => { setWallColor2(e.target.value); custom(); }} aria-label="Second background color" />
                      <span className="ui-num">{wallColor2}</span>
                    </label>
                  )}
                </div>
              )}
              {(wallType === 'color' || wallType === 'gradient') && (
                <span className="ui-hint">
                  The page switches to {mode === 'dark' ? 'light text' : 'dark text'} on this background for every visitor.
                </span>
              )}
            </div>
            {wallType === 'image' && (
              <>
                <ImagePicker
                  label="Background image"
                  wide
                  hint="Covers the whole page, behind everything. It is dimmed so text stays readable."
                  value={wallImage}
                  onChange={(v) => { setWallImage(v); custom(); }}
                  onError={setSaveError}
                />
                {!wallImageOk && <p className="ui-error">Image links must start with https://</p>}
                <label className="ui-field">
                  <span className="ui-field-label">Blur <span className="ui-num">{wallBlur}px</span></span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={2}
                    value={wallBlur}
                    onChange={(e) => { setWallBlur(Number(e.target.value)); custom(); }}
                  />
                </label>
              </>
            )}
          </>
        )}

        {tab === 'links' && (
          <>
            <p className={styles.note}>
              Add your own buttons: a roadmap, merch, a mint calendar, anything. A card shows a
              big picture, a button stays compact.
            </p>
            {links.map((l, i) => {
              const urlBad = l.url.trim() !== '' && !isHttpUrl(l.url);
              return (
                <div key={l.id} className={styles.linkEditor}>
                  <div className={styles.linkEditorHead}>
                    <span className="ui-num">{i + 1}</span>
                    <div className={styles.segmented} role="radiogroup" aria-label="Link style">
                      {(['classic', 'featured'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="radio"
                          aria-checked={l.style === s}
                          data-selected={l.style === s ? 'true' : undefined}
                          onClick={() => updateLink(l.id, { style: s })}
                        >
                          {s === 'classic' ? 'Button' : 'Card'}
                        </button>
                      ))}
                    </div>
                    <span className={styles.linkEditorTools}>
                      <button type="button" className="ui-icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => moveLink(l.id, -1)}>↑</button>
                      <button type="button" className="ui-icon-btn" aria-label="Move down" disabled={i === links.length - 1} onClick={() => moveLink(l.id, 1)}>↓</button>
                      <button type="button" className="ui-icon-btn" aria-label="Remove link" onClick={() => { setLinks((ls) => ls.filter((x) => x.id !== l.id)); touch(); }}>×</button>
                    </span>
                  </div>
                  <input
                    className="ui-input"
                    maxLength={60}
                    value={l.title}
                    onChange={(e) => updateLink(l.id, { title: e.target.value })}
                    placeholder="Title, e.g. Roadmap"
                    aria-label={`Link ${i + 1} title`}
                  />
                  <input
                    type="url"
                    className="ui-input"
                    value={l.url}
                    onChange={(e) => updateLink(l.id, { url: e.target.value })}
                    placeholder="https://..."
                    aria-label={`Link ${i + 1} address`}
                  />
                  {urlBad && <p className="ui-error">Links must start with https://</p>}
                  <ImagePicker
                    label={l.style === 'featured' ? 'Card picture' : 'Icon (optional)'}
                    wide={l.style === 'featured'}
                    hint={l.style === 'featured' ? 'Wide works best, around 1200 x 675.' : 'Shows small, next to the title.'}
                    value={l.thumb}
                    onChange={(v) => updateLink(l.id, { thumb: v })}
                    onError={setSaveError}
                  />
                </div>
              );
            })}
            {links.length < MAX_LINKS ? (
              <button
                type="button"
                className="ui-btn"
                data-size="sm"
                onClick={() => {
                  setLinks((ls) => [...ls, { id: newLinkId(), title: '', url: '', style: 'classic', thumb: img(null) }]);
                  touch();
                }}
              >
                + Add link
              </button>
            ) : (
              <span className="ui-hint">That&apos;s the most links a page can have ({MAX_LINKS}).</span>
            )}
            {badLinks.length > 0 && (
              <span className="ui-hint">Every link needs a title and an https:// address before you can save.</span>
            )}
          </>
        )}

        {tab === 'about' && (
          <>
            <label className="ui-field">
              <span className="ui-field-label">Description</span>
              <textarea
                className="ui-input"
                rows={5}
                maxLength={1000}
                value={description}
                onChange={(e) => { setDescription(e.target.value); touch(); }}
                placeholder="Tell people what this collection is about."
              />
              <span className="ui-hint">{description.length}/1000</span>
            </label>
            <label className="ui-field">
              <span className="ui-field-label">Website</span>
              <input
                type="url"
                className="ui-input"
                value={website}
                onChange={(e) => { setWebsite(e.target.value); touch(); }}
                placeholder="https://..."
              />
            </label>
            {!websiteOk && <p className="ui-error">The website must start with https://</p>}
            <label className="ui-field">
              <span className="ui-field-label">X</span>
              <input className="ui-input" maxLength={80} value={twitter}
                onChange={(e) => { setTwitter(e.target.value); touch(); }} placeholder="@handle or https://x.com/..." />
            </label>
            <label className="ui-field">
              <span className="ui-field-label">Telegram</span>
              <input className="ui-input" maxLength={80} value={telegram}
                onChange={(e) => { setTelegram(e.target.value); touch(); }} placeholder="https://t.me/..." />
            </label>
            <label className="ui-field">
              <span className="ui-field-label">Discord</span>
              <input className="ui-input" maxLength={80} value={discord}
                onChange={(e) => { setDiscord(e.target.value); touch(); }} placeholder="https://discord.gg/..." />
            </label>
          </>
        )}

        {tab === 'advanced' && (
          <OnChainLinks
            ownerTarget={ownerTarget}
            chainId={chainId}
            currentBaseUri={currentBaseUri}
            currentContractUri={currentContractUri}
            onChanged={() => void refetch()}
          />
        )}

        {tab !== 'advanced' && (
          <div className={styles.saveBar}>
            <p className={styles.note}>
              {dirty ? 'Only you see these edits until you save. Saving is free, you just sign a message.' : 'Everything is saved.'}
            </p>
            <div className={styles.launcherActions}>
              <button
                type="button"
                className="ui-btn"
                data-variant="primary"
                disabled={saving || !dirty || !formOk}
                onClick={() => void savePage()}
              >
                {saving ? 'Saving…' : saved && !dirty ? 'Saved' : 'Save page'}
              </button>
              {dirty && !saving && (
                <button type="button" className="ui-btn" data-variant="ghost" onClick={() => { loadFrom(savedDraft); touch(); }}>
                  Undo changes
                </button>
              )}
            </div>
            {saveError && <p className="ui-error">{saveError}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function FontPicker({
  label,
  value,
  onChange,
  sample,
}: {
  label: string;
  value: FontId;
  onChange: (f: FontId) => void;
  sample: string;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      <select className="ui-input" value={value} onChange={(e) => onChange(e.target.value as FontId)}>
        {FONT_IDS.map((f) => (
          <option key={f} value={f}>{FONTS[f].label}</option>
        ))}
      </select>
      <span
        className={styles.fontSample}
        style={{ fontFamily: FONTS[value].family ?? (label === 'Title font' ? 'var(--font-display)' : 'var(--font-sans)') }}
      >
        {sample}
      </span>
    </label>
  );
}

/// Upload a file, paste a link, or remove. A picked file stays local (data:
/// URL, preview only) until the page is saved.
function ImagePicker({
  label,
  hint,
  wide = false,
  value,
  onChange,
  onError,
}: {
  label: string;
  /// Banner-shaped thumbnail instead of a square one.
  wide?: boolean;
  hint: string;
  value: ImageValue;
  onChange: (v: ImageValue) => void;
  onError: (msg: string | null) => void;
}) {
  async function pick(file: File | null) {
    onError(null);
    if (!file) return;
    try {
      const res = await readFileAsDataUrl(file);
      onChange({ url: value.url, dataUrl: res.dataUrl });
    } catch {
      onError('That image could not be used. Pick a PNG, JPEG, WebP or SVG under 10MB.');
    }
  }
  const hasImage = !!value.dataUrl || value.url.trim() !== '';
  const thumb = value.dataUrl ?? (isHttpUrl(value.url) ? value.url.trim() : null);
  return (
    <div className="ui-field">
      <span className="ui-field-label">{label}</span>
      <div className={styles.pickerRow}>
        <span
          className={styles.pickerThumb}
          data-wide={wide ? 'true' : undefined}
          style={thumb ? { backgroundImage: cssUrl(thumb) } : undefined}
          aria-hidden="true"
        />
        <label className="ui-btn" data-size="sm">
          {hasImage ? 'Replace' : 'Upload'}
          <input
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/avif,image/gif"
            onChange={(e) => { void pick(e.target.files?.[0] ?? null); e.target.value = ''; }}
          />
        </label>
        {hasImage && (
          <button
            type="button"
            className="ui-btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => onChange({ url: '', dataUrl: null })}
          >
            Remove
          </button>
        )}
      </div>
      {value.dataUrl ? (
        <span className="ui-hint">New image picked. It uploads when you save.</span>
      ) : (
        <input
          type="url"
          className="ui-input"
          value={value.url}
          onChange={(e) => onChange({ url: e.target.value, dataUrl: null })}
          placeholder="or paste an image link (https://...)"
          aria-label={`${label} link`}
        />
      )}
      <span className="ui-hint">{hint}</span>
    </div>
  );
}
