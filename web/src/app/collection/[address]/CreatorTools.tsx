'use client';

/// Launcher-only "Creator tools" panel on /collection/[address], for both the
/// NFT lane and the DN404 lane.
///
/// Two kinds of edits:
///   1. Page details (description, cover image, socials). Stored off-chain by
///      compile-service (`/collection/:chainId/:address/metadata`). Free: the
///      launcher signs a message, no transaction. The server only accepts the
///      indexer's launchedBy wallet when it is also the on-chain owner.
///   2. On-chain links: setContractURI (what marketplaces show for the
///      collection) and setBaseURI (where every NFT's art + metadata lives).
///      NFT lane: called on the ERC-721 collection. DN404 lane: called on the
///      BASE ERC-20 (the mirror has no setters). Both are Solady onlyOwner;
///      confirmed by eth_call against live RH collections on 2026-10-19 (owner
///      succeeds, any other wallet reverts Unauthorized()).
///
/// The caller decides visibility. This component also re-checks that the
/// connected wallet is the on-chain owner and renders nothing otherwise.

import { useEffect, useState } from 'react';
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

export function CreatorTools({
  collection,
  ownerTarget,
  chainId,
  pageMeta,
  onPageMetaSaved,
}: {
  /// The ERC-721 the page lives at (the DN404 mirror on that lane).
  collection: Address;
  /// Contract holding owner() + the URI setters: the collection on the NFT
  /// lane, the base ERC-20 on the DN404 lane.
  ownerTarget: Address;
  chainId: (typeof CHAIN_KEY_TO_ID)[keyof typeof CHAIN_KEY_TO_ID];
  pageMeta: RemoteCollectionMetadata | null;
  onPageMetaSaved: (next: RemoteCollectionMetadata) => void;
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

  // ------------------------------------------------------------ page details
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [discord, setDiscord] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { signMessageAsync } = useSignMessage();

  // Prefill from what is saved now, once it loads.
  useEffect(() => {
    if (!pageMeta) return;
    setDescription(pageMeta.description ?? '');
    setImageUrl(pageMeta.imageUrl ?? '');
    setWebsite(pageMeta.website ?? '');
    setTwitter(pageMeta.twitter ?? '');
    setTelegram(pageMeta.telegram ?? '');
    setDiscord(pageMeta.discord ?? '');
  }, [pageMeta]);

  async function pickImage(file: File | null) {
    setSaveError(null);
    setSaved(false);
    if (!file) { setImageDataUrl(null); return; }
    try {
      const res = await readFileAsDataUrl(file);
      setImageDataUrl(res.dataUrl);
    } catch {
      setImageDataUrl(null);
      setSaveError('That image could not be used. Pick a PNG, JPEG, WebP or SVG under 10MB.');
    }
  }

  const imageUrlOk = imageUrl.trim() === '' || isHttpUrl(imageUrl);
  const websiteOk = website.trim() === '' || isHttpUrl(website);

  async function savePageDetails() {
    if (!wallet) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      let finalImage = emptyToNull(imageUrl);
      if (imageDataUrl) {
        const pinned = await uploadImageToIpfs(imageDataUrl);
        if (!pinned) {
          setSaveError('Could not upload the image. Try again, or paste an image link instead.');
          return;
        }
        finalImage = pinned.gatewayUrl;
      }
      const payload = {
        chainId,
        collectionAddress: collection.toLowerCase() as Address,
        imageUrl: finalImage,
        description: emptyToNull(description),
        website: emptyToNull(website),
        twitter: emptyToNull(twitter),
        telegram: emptyToNull(telegram),
        discord: emptyToNull(discord),
      };
      const res = await saveCollectionMetadata(wallet, payload, ({ message }) => signMessageAsync({ message }));
      if (!res.ok) {
        setSaveError(SAVE_ERRORS[res.error] ?? `Save failed (${res.error}).`);
        return;
      }
      setImageDataUrl(null);
      setImageUrl(finalImage ?? '');
      setSaved(true);
      onPageMetaSaved({
        ...payload,
        updatedAt: new Date().toISOString(),
        owner: wallet,
      });
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

  return (
    <section className="ui-panel">
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Creator tools</h2>
        <span className="ui-badge" data-tone="info">Only you</span>
      </div>
      <div className={`ui-panel-body ${styles.launcherBody}`}>
        {/* ---------------- Page details (off-chain, free) ---------------- */}
        <div className={styles.sectionLabel}>Page details</div>
        <p className={styles.note}>
          What people see on this page. Saving is free, your wallet just asks you to sign a message.
        </p>

        <label className="ui-field">
          <span className="ui-field-label">Description</span>
          <textarea
            className="ui-input"
            rows={4}
            maxLength={1000}
            value={description}
            onChange={(e) => { setDescription(e.target.value); setSaved(false); }}
            placeholder="Tell people what this collection is about."
          />
          <span className="ui-hint">{description.length}/1000</span>
        </label>

        <label className="ui-field">
          <span className="ui-field-label">Cover image</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/avif"
            onChange={(e) => void pickImage(e.target.files?.[0] ?? null)}
          />
          <span className="ui-hint">
            {imageDataUrl ? 'New image picked. It uploads when you save.' : 'Upload an image, or paste a link below.'}
          </span>
        </label>
        {!imageDataUrl && (
          <input
            type="url"
            className="ui-input"
            value={imageUrl}
            onChange={(e) => { setImageUrl(e.target.value); setSaved(false); }}
            placeholder="https://..."
            aria-label="Cover image link"
          />
        )}
        {!imageUrlOk && <p className="ui-error">Image links must start with https://</p>}

        <label className="ui-field">
          <span className="ui-field-label">Website</span>
          <input
            type="url"
            className="ui-input"
            value={website}
            onChange={(e) => { setWebsite(e.target.value); setSaved(false); }}
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
            onChange={(e) => { setTwitter(e.target.value); setSaved(false); }}
            placeholder="@handle or https://x.com/..."
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Telegram</span>
          <input
            className="ui-input"
            maxLength={80}
            value={telegram}
            onChange={(e) => { setTelegram(e.target.value); setSaved(false); }}
            placeholder="https://t.me/..."
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Discord</span>
          <input
            className="ui-input"
            maxLength={80}
            value={discord}
            onChange={(e) => { setDiscord(e.target.value); setSaved(false); }}
            placeholder="https://discord.gg/..."
          />
        </label>

        <div className={styles.launcherActions}>
          <button
            type="button"
            className="ui-btn"
            data-size="sm"
            data-variant="primary"
            disabled={saving || !imageUrlOk || !websiteOk}
            onClick={() => void savePageDetails()}
          >
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save page details'}
          </button>
        </div>
        {saveError && <p className="ui-error">{saveError}</p>}

        <hr className={styles.toolsDivider} />

        {/* ---------------- contractURI (on-chain) ---------------- */}
        <div className={styles.sectionLabel}>Marketplace info</div>
        <p className={styles.note}>
          The file OpenSea and other marketplaces read for this collection&apos;s name, banner and
          description. This is an on-chain change and costs a small gas fee.
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

        <hr className={styles.toolsDivider} />

        {/* ---------------- baseURI (on-chain, high impact) ---------------- */}
        <div className={styles.sectionLabel}>Art and metadata folder</div>
        <p className={styles.toolsWarn}>
          <b>This changes every NFT in the collection.</b> Each NFT&apos;s picture and traits are
          read from this folder, so a wrong link breaks the art for every holder until you fix it.
          This is an on-chain change and costs a small gas fee.
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
    </section>
  );
}
