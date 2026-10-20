'use client';

/// Launcher-only "Customize your page" panel on /collection/[address], for
/// both the NFT lane and the DN404 lane.
///
///   1. Look + About (banner, cover image, accent color, background preset,
///      description, socials). Stored off-chain by compile-service
///      (`/collection/:chainId/:address/metadata`). Free: the launcher signs a
///      message, no transaction. The server only accepts the indexer's
///      launchedBy wallet when it is also the on-chain owner. Edits preview
///      live on the page (only for the launcher) until saved.
///   2. Advanced, collapsed: on-chain setContractURI (what marketplaces show
///      for the collection) and setBaseURI (where every NFT's art + metadata
///      lives). NFT lane: called on the ERC-721 collection. DN404 lane: called
///      on the BASE ERC-20 (the mirror has no setters). Both are Solady
///      onlyOwner; confirmed by eth_call against live RH collections on
///      2026-10-19 (owner succeeds, any other wallet reverts Unauthorized()).
///
/// The caller decides visibility. This component also re-checks that the
/// connected wallet is the on-chain owner and renders nothing otherwise.

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useReadContracts,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import type { Address } from 'viem';

import { readFileAsDataUrl } from '@/lib/metadata';
import { uploadImageToIpfs } from '@/lib/ipfs';
import { saveCollectionMetadata, type RemoteCollectionMetadata } from '@/lib/socialApi';
import type { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import {
  ACCENT_PRESETS,
  cssUrl,
  hardToReadOn,
  isHexColor,
  type BackgroundStyle,
} from './collectionTheme';
import styles from './collection.module.css';

/// Shared by ERC721ATemplate and Dn404Template.
const uriAdminAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'baseURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'setBaseURI',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newBaseURI', type: 'string' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setContractURI',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newContractURI', type: 'string' }],
    outputs: [],
  },
] as const;

function isLinkUri(v: string): boolean {
  const t = v.trim();
  return t.startsWith('ipfs://') || t.startsWith('ar://') || t.startsWith('https://');
}

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

const BACKGROUND_OPTIONS: { value: BackgroundStyle; label: string }[] = [
  { value: 'default', label: 'Plain' },
  { value: 'tint', label: 'Soft tint' },
  { value: 'banner', label: 'From banner' },
];

/// What the page should show while the launcher edits. Image fields may hold
/// a local data: URL for a picked file that has not been uploaded yet.
export interface PageDraft {
  imageUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  backgroundStyle: BackgroundStyle | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
}

/// An image the launcher can upload, paste a link for, or remove.
interface ImageValue { url: string; dataUrl: string | null }

export function CreatorTools({
  collection,
  ownerTarget,
  chainId,
  pageMeta,
  onPageMetaSaved,
  onPreview,
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
}) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();

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

  async function ensureChain(): Promise<boolean> {
    if (walletChainId === chainId) return true;
    try {
      await switchChainAsync({ chainId });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ page draft
  const [cover, setCover] = useState<ImageValue>({ url: '', dataUrl: null });
  const [banner, setBanner] = useState<ImageValue>({ url: '', dataUrl: null });
  const [accent, setAccent] = useState('');
  const [background, setBackground] = useState<BackgroundStyle>('default');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [discord, setDiscord] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { signMessageAsync } = useSignMessage();

  function loadFrom(meta: RemoteCollectionMetadata | null) {
    setCover({ url: meta?.imageUrl ?? '', dataUrl: null });
    setBanner({ url: meta?.bannerUrl ?? '', dataUrl: null });
    setAccent(meta?.accentColor ?? '');
    setBackground((meta?.backgroundStyle as BackgroundStyle | null) ?? 'default');
    setDescription(meta?.description ?? '');
    setWebsite(meta?.website ?? '');
    setTwitter(meta?.twitter ?? '');
    setTelegram(meta?.telegram ?? '');
    setDiscord(meta?.discord ?? '');
  }

  // Prefill from what is saved now, once it loads.
  useEffect(() => { loadFrom(pageMeta); }, [pageMeta]);

  const draft: PageDraft = useMemo(() => ({
    imageUrl: cover.dataUrl ?? emptyToNull(cover.url),
    bannerUrl: banner.dataUrl ?? emptyToNull(banner.url),
    accentColor: isHexColor(accent) ? accent.toLowerCase() : null,
    backgroundStyle: background === 'default' ? null : background,
    description: emptyToNull(description),
    website: emptyToNull(website),
    twitter: emptyToNull(twitter),
    telegram: emptyToNull(telegram),
    discord: emptyToNull(discord),
  }), [cover, banner, accent, background, description, website, twitter, telegram, discord]);

  const dirty =
    draft.imageUrl !== (pageMeta?.imageUrl ?? null) ||
    draft.bannerUrl !== (pageMeta?.bannerUrl ?? null) ||
    draft.accentColor !== (pageMeta?.accentColor ?? null) ||
    draft.backgroundStyle !== ((pageMeta?.backgroundStyle === 'default' ? null : pageMeta?.backgroundStyle) ?? null) ||
    draft.description !== (pageMeta?.description ?? null) ||
    draft.website !== (pageMeta?.website ?? null) ||
    draft.twitter !== (pageMeta?.twitter ?? null) ||
    draft.telegram !== (pageMeta?.telegram ?? null) ||
    draft.discord !== (pageMeta?.discord ?? null);

  useEffect(() => {
    onPreview(isOwner && dirty ? draft : null);
  }, [isOwner, dirty, draft, onPreview]);
  // Drop the preview if the panel goes away (wallet disconnects etc).
  useEffect(() => () => onPreview(null), [onPreview]);

  const coverOk = cover.dataUrl !== null || cover.url.trim() === '' || isHttpUrl(cover.url);
  const bannerOk = banner.dataUrl !== null || banner.url.trim() === '' || isHttpUrl(banner.url);
  const websiteOk = website.trim() === '' || isHttpUrl(website);
  const accentWarn = isHexColor(accent) ? hardToReadOn(accent) : [];

  async function upload(v: ImageValue): Promise<string | null | 'failed'> {
    if (!v.dataUrl) return emptyToNull(v.url);
    const pinned = await uploadImageToIpfs(v.dataUrl);
    return pinned ? pinned.gatewayUrl : 'failed';
  }

  async function savePage() {
    if (!wallet) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const [imageUrl, bannerUrl] = await Promise.all([upload(cover), upload(banner)]);
      if (imageUrl === 'failed' || bannerUrl === 'failed') {
        setSaveError('Could not upload an image. Try again, or paste an image link instead.');
        return;
      }
      const payload = {
        chainId,
        collectionAddress: collection.toLowerCase() as Address,
        imageUrl,
        bannerUrl,
        accentColor: draft.accentColor,
        backgroundStyle: draft.backgroundStyle,
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

  // ------------------------------------------------------------ contractURI
  const [contractUriDraft, setContractUriDraft] = useState('');
  const {
    writeContract: writeContractUri,
    data: contractUriTx,
    isPending: contractUriPending,
    error: contractUriError,
  } = useWriteContract();
  const { isLoading: contractUriWaiting, isSuccess: contractUriDone } =
    useWaitForTransactionReceipt({ hash: contractUriTx, chainId });
  const suggestedContractUri = currentBaseUri ? `${currentBaseUri}collection.json` : '';

  async function doSetContractUri() {
    if (!isOwner || !isLinkUri(contractUriDraft)) return;
    if (!(await ensureChain())) return;
    writeContractUri({
      address: ownerTarget,
      abi: uriAdminAbi,
      functionName: 'setContractURI',
      args: [contractUriDraft.trim()],
      chainId,
    });
  }

  // ------------------------------------------------------------ baseURI
  const [baseUriDraft, setBaseUriDraft] = useState('');
  const [baseUriConfirmed, setBaseUriConfirmed] = useState(false);
  const {
    writeContract: writeBaseUri,
    data: baseUriTx,
    isPending: baseUriPending,
    error: baseUriError,
  } = useWriteContract();
  const { isLoading: baseUriWaiting, isSuccess: baseUriDone } =
    useWaitForTransactionReceipt({ hash: baseUriTx, chainId });
  // tokenURI(id) = baseURI + id + ".json" on both templates, so the link
  // must end in a slash or every NFT points at a broken file.
  const baseUriDraftOk = isLinkUri(baseUriDraft) && baseUriDraft.trim().endsWith('/');

  async function doSetBaseUri() {
    if (!isOwner || !baseUriDraftOk || !baseUriConfirmed) return;
    if (!(await ensureChain())) return;
    writeBaseUri({
      address: ownerTarget,
      abi: uriAdminAbi,
      functionName: 'setBaseURI',
      args: [baseUriDraft.trim()],
      chainId,
    });
  }

  useEffect(() => {
    if (contractUriDone || baseUriDone) void refetch();
  }, [contractUriDone, baseUriDone, refetch]);

  if (!isOwner) return null;

  const touch = () => { setSaved(false); setSaveError(null); };

  return (
    <section className="ui-panel" id="customize">
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Customize your page</h2>
        <span className="ui-badge" data-tone="info">Only you</span>
      </div>
      <div className={`ui-panel-body ${styles.launcherBody}`}>
        <p className={styles.note}>
          Edits show on the page as you make them. Visitors see them once you save. Saving is
          free, you just sign a message.
        </p>

        {/* ---------------- Look ---------------- */}
        <div className={styles.sectionLabel}>Look</div>

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
          <div className={styles.swatchRow}>
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.swatch}
                style={{ background: c }}
                data-selected={accent.toLowerCase() === c ? 'true' : undefined}
                aria-label={`Use color ${c}`}
                onClick={() => { setAccent(c); touch(); }}
              />
            ))}
            <label className={styles.swatchCustom} title="Pick any color">
              <input
                type="color"
                value={isHexColor(accent) ? accent : '#cc1e56'}
                onChange={(e) => { setAccent(e.target.value); touch(); }}
                aria-label="Pick any color"
              />
              <span>Custom</span>
            </label>
          </div>
          <span className="ui-hint">
            Buttons, links and highlights.{' '}
            {accent ? (
              <button type="button" className={styles.linkBtn} onClick={() => { setAccent(''); touch(); }}>
                Use the site color
              </button>
            ) : 'Using the site color.'}
          </span>
          {accentWarn.length > 0 && (
            <span className="ui-hint">
              Hard to read in {accentWarn.join(' and ')} mode. Try a {accentWarn[0] === 'light' ? 'darker' : 'lighter'} shade.
            </span>
          )}
        </div>

        <div className="ui-field">
          <span className="ui-field-label">Background</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Background">
            {BACKGROUND_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={background === o.value}
                data-selected={background === o.value ? 'true' : undefined}
                disabled={o.value === 'banner' && !draft.bannerUrl}
                onClick={() => { setBackground(o.value); touch(); }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {!draft.bannerUrl && (
            <span className="ui-hint">Add a banner to use it as the background.</span>
          )}
        </div>

        <hr className={styles.toolsDivider} />

        {/* ---------------- About ---------------- */}
        <div className={styles.sectionLabel}>About</div>

        <label className="ui-field">
          <span className="ui-field-label">Description</span>
          <textarea
            className="ui-input"
            rows={4}
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
          <input
            className="ui-input"
            maxLength={80}
            value={twitter}
            onChange={(e) => { setTwitter(e.target.value); touch(); }}
            placeholder="@handle or https://x.com/..."
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Telegram</span>
          <input
            className="ui-input"
            maxLength={80}
            value={telegram}
            onChange={(e) => { setTelegram(e.target.value); touch(); }}
            placeholder="https://t.me/..."
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Discord</span>
          <input
            className="ui-input"
            maxLength={80}
            value={discord}
            onChange={(e) => { setDiscord(e.target.value); touch(); }}
            placeholder="https://discord.gg/..."
          />
        </label>

        <div className={styles.launcherActions}>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={saving || !dirty || !coverOk || !bannerOk || !websiteOk}
            onClick={() => void savePage()}
          >
            {saving ? 'Saving…' : saved && !dirty ? 'Saved ✓' : 'Save page'}
          </button>
          {dirty && !saving && (
            <button
              type="button"
              className="ui-btn"
              data-variant="ghost"
              onClick={() => { loadFrom(pageMeta); touch(); }}
            >
              Undo changes
            </button>
          )}
        </div>
        {saveError && <p className="ui-error">{saveError}</p>}

        <hr className={styles.toolsDivider} />

        {/* ---------------- Advanced: on-chain links ---------------- */}
        <details className={styles.advanced}>
          <summary>Advanced: on-chain links</summary>
          <div className={styles.launcherBody}>
            <p className={styles.note}>
              Stored on-chain, so each change is a transaction with a small gas fee. Most
              creators never touch these.
            </p>

            <div className={styles.sectionLabel}>Marketplace info</div>
            <p className={styles.note}>
              The file OpenSea and other marketplaces read for this collection&apos;s name, banner
              and description.
            </p>
            <p className={styles.note}>
              {currentContractUri
                ? <>Now: <span className={`ui-num ${styles.breakAll}`}>{currentContractUri}</span></>
                : <>Not set yet. Marketplaces show no banner or description until it is.</>}
            </p>
            <input
              type="text"
              className="ui-input"
              data-mono="true"
              value={contractUriDraft}
              onChange={(e) => setContractUriDraft(e.target.value)}
              placeholder={suggestedContractUri || 'ipfs://.../collection.json'}
              aria-label="Marketplace info link"
            />
            <div className={styles.launcherActions}>
              {suggestedContractUri && contractUriDraft !== suggestedContractUri && (
                <button
                  type="button"
                  className="ui-btn"
                  data-size="sm"
                  data-variant="ghost"
                  onClick={() => setContractUriDraft(suggestedContractUri)}
                  title="The studio publishes collection.json next to the NFT files"
                >
                  Use collection.json from the art folder
                </button>
              )}
              <button
                type="button"
                className="ui-btn"
                data-size="sm"
                data-variant="primary"
                disabled={!isLinkUri(contractUriDraft) || contractUriPending || contractUriWaiting || isSwitching}
                onClick={() => void doSetContractUri()}
              >
                {contractUriDone
                  ? 'Saved ✓'
                  : contractUriWaiting
                    ? 'Waiting for receipt…'
                    : contractUriPending
                      ? 'Confirm in your wallet…'
                      : 'Save marketplace info'}
              </button>
            </div>
            {contractUriDraft && !isLinkUri(contractUriDraft) && (
              <p className="ui-error">Links must start with ipfs://, ar:// or https://</p>
            )}
            {contractUriError && <p className="ui-error">{contractUriError.message.split('\n')[0]}</p>}

            <div className={styles.sectionLabel}>Art and metadata folder</div>
            <p className={styles.toolsWarn}>
              <b>This changes every NFT in the collection.</b> Each NFT&apos;s picture and traits are
              read from this folder, so a wrong link breaks the art for every holder until you fix it.
            </p>
            <p className={styles.note}>
              {currentBaseUri
                ? <>Now: <span className={`ui-num ${styles.breakAll}`}>{currentBaseUri}</span></>
                : <>Not set.</>}
            </p>
            <input
              type="text"
              className="ui-input"
              data-mono="true"
              value={baseUriDraft}
              onChange={(e) => { setBaseUriDraft(e.target.value); setBaseUriConfirmed(false); }}
              placeholder="ipfs://.../"
              aria-label="Art and metadata folder link"
            />
            {baseUriDraft && !baseUriDraftOk && (
              <p className="ui-error">
                The link must start with ipfs://, ar:// or https:// and end with a slash (/).
              </p>
            )}
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={baseUriConfirmed}
                onChange={(e) => setBaseUriConfirmed(e.target.checked)}
                disabled={!baseUriDraftOk}
              />
              <span>
                I understand this changes the art and traits of every NFT in this collection,
                including ones people already hold.
              </span>
            </label>
            <div className={styles.launcherActions}>
              <button
                type="button"
                className="ui-btn"
                data-size="sm"
                data-variant="ink"
                disabled={!baseUriDraftOk || !baseUriConfirmed || baseUriPending || baseUriWaiting || isSwitching}
                onClick={() => void doSetBaseUri()}
              >
                {baseUriDone
                  ? 'Saved ✓'
                  : baseUriWaiting
                    ? 'Waiting for receipt…'
                    : baseUriPending
                      ? 'Confirm in your wallet…'
                      : 'Change art folder'}
              </button>
            </div>
            {baseUriError && <p className="ui-error">{baseUriError.message.split('\n')[0]}</p>}
          </div>
        </details>
      </div>
    </section>
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
