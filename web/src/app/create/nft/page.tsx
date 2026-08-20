'use client';

/// NFT launch studio (phase-0 scaffolding).
///
/// Kawaii two-column workbench: form on the left, sticky preview ticket on
/// the right — mirrors the ERC-20 launcher's studio idiom so the two flows
/// feel like the same product. Contract-side plumbing not yet in place;
/// submit stays disabled until the NftMintModule ships. UI ships first so
/// we can iterate on the form + wire the chibi-studio deep-link.
///
/// Deep-link contract (studio.urufulabs.xyz → here):
///   /create/nft?baseUri=ipfs://...&name=...&ticker=...&maxSupply=...
/// All params optional; any subset prefills the form.

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { NFT_LAUNCHES_ENABLED, isNftDeployReady } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { readFileAsDataUrl } from '@/lib/metadata';
import styles from './nft-studio.module.css';

type MintMode = 'fixed' | 'linear';

/// Discount tier kinds.
///   `walletList` — deployer pastes wallet addresses; we merkleize server-side
///                   at launch time. All wallets in the list get the same
///                   fixed discount. "merkle" only lives in code, never UI.
///   `externalNft` — scales with holdings of an external NFT (any chain we can
///                   RPC). discount = min(held, cap) * bpsPerNft. Verified at
///                   mint by a signed attestation from the compile-service.
type TierKind = 'walletList' | 'externalNft';

const EXTERNAL_NFT_CHAINS = [
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'base', label: 'Base' },
  { id: 'robinhood', label: 'Robinhood' },
] as const;
type ExternalNftChain = (typeof EXTERNAL_NFT_CHAINS)[number]['id'];

interface DiscountTier {
  key: string;
  kind: TierKind;
  label: string;
  // wallet-list tier fields (percent stored as a plain string, e.g. "20"
  // for 20%. Converted to bps × 100 at submit time.)
  walletList: string;
  walletPercent: string;
  // external-nft tier fields (percent per NFT owned, e.g. "5" for 5%/NFT;
  // cap = max NFTs that count toward the discount)
  extNftChain: ExternalNftChain;
  extNftAddress: string;
  extNftPercentPerNft: string;
  extNftCap: string;
}

function newDiscountTier(): DiscountTier {
  return {
    key: Math.random().toString(36).slice(2, 10),
    kind: 'walletList',
    label: '',
    walletList: '',
    walletPercent: '',
    extNftChain: 'ethereum',
    extNftAddress: '',
    extNftPercentPerNft: '',
    extNftCap: '10',
  };
}

function countValidWallets(text: string): number {
  if (!text.trim()) return 0;
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s)).length;
}

function sanitizeTicker(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

export default function CreateNftPage() {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return (
    <Suspense fallback={null}>
      <CreateNftForm />
    </Suspense>
  );
}

function CreateNftForm() {
  const activeChain = useActiveChain();
  const chainEnabled = NFT_LAUNCHES_ENABLED[activeChain] === true;
  const deployReady = isNftDeployReady(activeChain);

  const search = useSearchParams();
  const [name, setName] = useState(search.get('name') ?? '');
  const [ticker, setTicker] = useState(sanitizeTicker(search.get('ticker') ?? ''));
  const [baseUri, setBaseUri] = useState(search.get('baseUri') ?? '');
  const [maxSupply, setMaxSupply] = useState(search.get('maxSupply') ?? '');
  const [mintMode, setMintMode] = useState<MintMode>('fixed');
  const [basePriceEth, setBasePriceEth] = useState('');
  const [priceStepEth, setPriceStepEth] = useState('');
  /// Whitelist has two "flavors" the deployer picks between:
  ///   - `off`         — no WL, public mint from block 0.
  ///   - `holders`     — anyone holding N of a given NFT/ERC-20 can mint WL.
  ///                     Deployer pastes contract addr + chain; we do the
  ///                     balanceOf check at mint time (compile-service
  ///                     attestation for cross-chain, direct read for RH).
  ///   - `walletList`  — deployer pastes a list of wallet addresses; we
  ///                     compute the merkle root under the hood at launch
  ///                     time so the deployer never sees the word "merkle".
  type WlFlavor = 'off' | 'holders' | 'walletList';
  const [wlFlavor, setWlFlavor] = useState<WlFlavor>('off');
  const [wlHoldersChain, setWlHoldersChain] = useState<ExternalNftChain>('robinhood');
  const [wlHoldersAddress, setWlHoldersAddress] = useState('');
  const [wlHoldersMin, setWlHoldersMin] = useState('1');
  const [wlWalletList, setWlWalletList] = useState('');
  // Stored in MINUTES for UX; multiplied by 60 at launch time before writing
  // to the on-chain seconds field.
  const [wlOpenWindowMin, setWlOpenWindowMin] = useState('60');
  const wlWalletCount = useMemo(() => countValidWallets(wlWalletList), [wlWalletList]);
  const [discountTiers, setDiscountTiers] = useState<DiscountTier[]>([]);
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const onPickCover = async (file: File | undefined) => {
    if (!file) return;
    setCoverError(null);
    try {
      const result = await readFileAsDataUrl(file);
      setCoverDataUrl(result.dataUrl);
    } catch (e) {
      setCoverError(e instanceof Error ? e.message : 'upload failed');
    }
  };

  // Re-hydrate when the studio deep-links after mount (back/forward or a
  // fresh generate that re-navigates).
  useEffect(() => {
    const n = search.get('name'); if (n !== null) setName(n);
    const t = search.get('ticker'); if (t !== null) setTicker(sanitizeTicker(t));
    const b = search.get('baseUri'); if (b !== null) setBaseUri(b);
    const m = search.get('maxSupply'); if (m !== null) setMaxSupply(m);
  }, [search]);

  const nameOk = name.trim().length >= 2 && name.trim().length <= 40;
  const tickerOk = ticker.length >= 2 && ticker.length <= 10;
  const baseUriOk =
    baseUri.startsWith('ipfs://') ||
    baseUri.startsWith('ar://') ||
    baseUri.startsWith('https://');
  const maxSupplyOk = /^\d+$/.test(maxSupply) && Number(maxSupply) > 0 && Number(maxSupply) <= 100_000;
  const basePriceOk = mintMode === 'fixed'
    ? /^\d*\.?\d+$/.test(basePriceEth) && Number(basePriceEth) >= 0
    : /^\d*\.?\d+$/.test(basePriceEth) && /^\d*\.?\d+$/.test(priceStepEth);

  const canSubmit = nameOk && tickerOk && baseUriOk && maxSupplyOk && basePriceOk && deployReady;

  const disabledReason = useMemo(() => {
    if (!chainEnabled) return `nft launches aren't live on this chain yet`;
    if (!deployReady) return `contracts pending. this form ships first so the flow can settle. submit unlocks once NftMintModule broadcasts.`;
    if (!nameOk) return 'name must be 2 to 40 characters';
    if (!tickerOk) return 'ticker must be 2 to 10 chars, A-Z / 0-9';
    if (!baseUriOk) return 'baseURI must start with ipfs:// ar:// or https://';
    if (!maxSupplyOk) return 'max supply must be a positive integer up to 100,000';
    if (!basePriceOk) return 'enter a valid mint price (and step for linear mode)';
    return null;
  }, [chainEnabled, deployReady, nameOk, tickerOk, baseUriOk, maxSupplyOk, basePriceOk]);

  const previewTitle = name.trim() || 'your collection';
  const previewTicker = ticker || '???';
  const previewPrice = basePriceEth || '—';
  const previewSupply = maxSupply || '—';
  const priceLabel = mintMode === 'fixed'
    ? `${previewPrice} ETH`
    : priceStepEth
      ? `${previewPrice} ETH + ${priceStepEth}/mint`
      : `${previewPrice} ETH (linear)`;

  return (
    <div className={styles.studio}>
      <header className={styles.hero}>
        <div className={styles.heroTitle}>
          <Mascot size={48} mood="happy" />
          <h1 className={styles.uruH1}>❁ launch an nft collection</h1>
          <span className="uru-stamp uru-stamp-mint" style={{ transform: 'rotate(-4deg)' }}>
            phase-0
          </span>
        </div>
        <p className={styles.heroSub}>
          got your own baseURI? paste it. or build one in{' '}
          <a href="https://studio.urufulabs.xyz/" target="_blank" rel="noopener noreferrer">
            chibi studio ↗
          </a>.
        </p>
      </header>

      {!chainEnabled && (
        <div className={styles.warnPane} style={{ marginBottom: 14 }}>
          <b>not live on {activeChain}.</b> switch to robinhood to preview the flow.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          {/* Basics */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❀ basics</span>
              <span className={styles.sectionEye}>name · ticker · art · supply</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="nft-name">collection name</label>
              <input
                id="nft-name"
                type="text"
                className="uru-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my chibi collection"
                maxLength={40}
              />
            </div>

            <div className={styles.rowInputsShort}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="nft-ticker">ticker</label>
                <input
                  id="nft-ticker"
                  type="text"
                  className="uru-input"
                  value={ticker}
                  onChange={(e) => setTicker(sanitizeTicker(e.target.value))}
                  placeholder="CHIBI"
                  maxLength={10}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="nft-supply">max supply</label>
                <input
                  id="nft-supply"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={maxSupply}
                  onChange={(e) => setMaxSupply(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="1000"
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="nft-baseuri">baseURI</label>
              <input
                id="nft-baseuri"
                type="text"
                className="uru-input"
                value={baseUri}
                onChange={(e) => setBaseUri(e.target.value)}
                placeholder="ipfs://bafy.../"
              />
              <span className={styles.fieldHint}>
                trailing slash recommended. tokenURI = baseURI + tokenId.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>cover image</label>
              <div className={styles.coverActionsRow}>
                <label
                  className="uru-btn uru-btn-mint"
                  style={{ cursor: 'pointer', display: 'inline-flex' }}
                >
                  {coverDataUrl ? 'change cover' : '✿ upload cover'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => onPickCover(e.target.files?.[0])}
                    style={{ display: 'none' }}
                  />
                </label>
                {coverDataUrl && (
                  <button
                    type="button"
                    className={styles.coverRemove}
                    onClick={() => { setCoverDataUrl(null); setCoverError(null); }}
                  >
                    remove
                  </button>
                )}
                {coverError && (
                  <span className={styles.fieldHint} style={{ color: 'var(--pink-hot)' }}>
                    {coverError}
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* Mint mechanic */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✦ mint mechanic</span>
              <span className={styles.sectionEye}>how each mint is priced</span>
            </div>

            <div className={styles.modeRow}>
              <button
                type="button"
                className={styles.modeChip}
                data-active={mintMode === 'fixed'}
                onClick={() => setMintMode('fixed')}
              >
                fixed price
              </button>
              <button
                type="button"
                className={styles.modeChip}
                data-active={mintMode === 'linear'}
                onClick={() => setMintMode('linear')}
              >
                linear step
              </button>
            </div>

            <div className={mintMode === 'linear' ? styles.rowInputsShort : styles.field}>
              <div className={mintMode === 'linear' ? styles.field : `${styles.field} ${styles.shortField}`}>
                <label className={styles.fieldLabel} htmlFor="nft-price">
                  {mintMode === 'fixed' ? 'mint price (ETH)' : 'starting price (ETH)'}
                </label>
                <input
                  id="nft-price"
                  type="text"
                  inputMode="decimal"
                  className="uru-input"
                  value={basePriceEth}
                  onChange={(e) => setBasePriceEth(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder="0.005"
                />
              </div>
              {mintMode === 'linear' && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="nft-step">step per mint (ETH)</label>
                  <input
                    id="nft-step"
                    type="text"
                    inputMode="decimal"
                    className="uru-input"
                    value={priceStepEth}
                    onChange={(e) => setPriceStepEth(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0.0001"
                  />
                </div>
              )}
            </div>
          </section>

          {/* Whitelist */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">♡ whitelist (optional)</span>
              <span className={styles.sectionEye}>early window for certain wallets</span>
            </div>

            <div className={styles.modeRow}>
              <button
                type="button"
                className={styles.modeChip}
                data-active={wlFlavor === 'off'}
                onClick={() => setWlFlavor('off')}
              >
                no whitelist
              </button>
              <button
                type="button"
                className={styles.modeChip}
                data-active={wlFlavor === 'holders'}
                onClick={() => setWlFlavor('holders')}
              >
                token / nft holders
              </button>
              <button
                type="button"
                className={styles.modeChip}
                data-active={wlFlavor === 'walletList'}
                onClick={() => setWlFlavor('walletList')}
              >
                wallet list
              </button>
            </div>

            {wlFlavor === 'off' && (
              <p className={styles.fieldHint}>
                public mint from block 0. anyone can mint at the base price.
              </p>
            )}

            {wlFlavor === 'holders' && (
              <>
                <div className={styles.rowInputsShort}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="nft-wl-chain">chain</label>
                    <select
                      id="nft-wl-chain"
                      className="uru-input"
                      value={wlHoldersChain}
                      onChange={(e) => setWlHoldersChain(e.target.value as ExternalNftChain)}
                    >
                      {EXTERNAL_NFT_CHAINS.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="nft-wl-min">
                      minimum held
                    </label>
                    <input
                      id="nft-wl-min"
                      type="text"
                      inputMode="numeric"
                      className="uru-input"
                      value={wlHoldersMin}
                      onChange={(e) => setWlHoldersMin(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="1"
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="nft-wl-addr">
                    token or nft contract
                  </label>
                  <input
                    id="nft-wl-addr"
                    type="text"
                    className="uru-input"
                    value={wlHoldersAddress}
                    onChange={(e) => setWlHoldersAddress(e.target.value.trim())}
                    placeholder="0x…"
                  />
                  <span className={styles.fieldHint}>
                    any wallet holding {wlHoldersMin || 'N'}+ of this contract on{' '}
                    {chainLabel(wlHoldersChain)} can mint during the WL window.
                  </span>
                </div>
              </>
            )}

            {wlFlavor === 'walletList' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="nft-wl-list">
                  wallet addresses
                </label>
                <textarea
                  id="nft-wl-list"
                  className="uru-input"
                  value={wlWalletList}
                  onChange={(e) => setWlWalletList(e.target.value)}
                  placeholder={'0xabc…\n0xdef…\n0x123…'}
                  rows={6}
                  style={{ resize: 'vertical', fontFamily: 'var(--font-pixel), monospace' }}
                />
                <span className={styles.fieldHint}>
                  paste one address per line (or comma-separated). we handle the
                  behind-the-scenes cryptography so mint proofs work.{' '}
                  <b>{wlWalletCount}</b> valid address{wlWalletCount === 1 ? '' : 'es'} detected.
                </span>
              </div>
            )}

            {wlFlavor !== 'off' && (
              <div className={`${styles.field} ${styles.tinyField}`}>
                <label className={styles.fieldLabel} htmlFor="nft-wlwin">
                  WL-only window (minutes)
                </label>
                <input
                  id="nft-wlwin"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={wlOpenWindowMin}
                  onChange={(e) => setWlOpenWindowMin(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="60"
                />
                <span className={styles.fieldHint}>
                  after the window closes, public wallets can mint too.
                </span>
              </div>
            )}
          </section>

          {/* Discount tiers */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❉ discount tiers (optional)</span>
              <span className={styles.sectionEye}>merkle list or per-nft scale</span>
            </div>

            <p className={styles.fieldHint} style={{ marginBottom: 12 }}>
              give a discount to specific wallets, or to anyone who holds another
              nft (the more they hold, the bigger the discount).
            </p>

            {discountTiers.map((tier, i) => {
              const update = (patch: Partial<DiscountTier>) => {
                const next = [...discountTiers];
                next[i] = { ...tier, ...patch };
                setDiscountTiers(next);
              };
              return (
                <div key={tier.key} className={styles.tierCard}>
                  <div className={styles.tierHead}>
                    <input
                      type="text"
                      className="uru-input"
                      placeholder="tier label (e.g. gemu holders)"
                      value={tier.label}
                      onChange={(e) => update({ label: e.target.value })}
                      style={{ flex: '1 1 200px', minWidth: 0 }}
                    />
                    <div className={styles.tierKindRow} role="tablist" aria-label="Tier kind">
                      <button
                        type="button"
                        className={styles.modeChip}
                        data-active={tier.kind === 'walletList'}
                        onClick={() => update({ kind: 'walletList' })}
                        style={{ fontSize: 11, padding: '4px 10px' }}
                      >
                        wallet list
                      </button>
                      <button
                        type="button"
                        className={styles.modeChip}
                        data-active={tier.kind === 'externalNft'}
                        onClick={() => update({ kind: 'externalNft' })}
                        style={{ fontSize: 11, padding: '4px 10px' }}
                      >
                        holders of another nft
                      </button>
                    </div>
                    <button
                      type="button"
                      className={styles.addTierBtn}
                      onClick={() => setDiscountTiers(discountTiers.filter((_, j) => j !== i))}
                      style={{ padding: '4px 8px', fontSize: 11 }}
                    >
                      remove
                    </button>
                  </div>

                  {tier.kind === 'walletList' ? (
                    <div className={styles.tierBody}>
                      <textarea
                        className="uru-input"
                        placeholder={'paste wallet addresses, one per line\n0xabc…\n0xdef…'}
                        value={tier.walletList}
                        onChange={(e) => update({ walletList: e.target.value })}
                        rows={4}
                        style={{
                          resize: 'vertical',
                          fontFamily: 'var(--font-pixel), monospace',
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="uru-input"
                          placeholder="20"
                          value={tier.walletPercent}
                          onChange={(e) => update({ walletPercent: e.target.value.replace(/[^\d]/g, '') })}
                          style={{ maxWidth: 80 }}
                        />
                        <span style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
                          % off
                        </span>
                      </div>
                      <span className={styles.fieldHint}>
                        <b>{countValidWallets(tier.walletList)}</b> valid address
                        {countValidWallets(tier.walletList) === 1 ? '' : 'es'} detected ·
                        paste one per line, we handle the rest.
                      </span>
                    </div>
                  ) : (
                    <div className={styles.tierBody}>
                      <div className={styles.tierFieldRow}>
                        <select
                          className={`uru-input ${styles.chainSelect}`}
                          value={tier.extNftChain}
                          onChange={(e) => update({ extNftChain: e.target.value as ExternalNftChain })}
                        >
                          {EXTERNAL_NFT_CHAINS.map((c) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          className="uru-input"
                          placeholder="external NFT contract (0x…)"
                          value={tier.extNftAddress}
                          onChange={(e) => update({ extNftAddress: e.target.value.trim() })}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="text"
                            inputMode="numeric"
                            className="uru-input"
                            placeholder="5"
                            value={tier.extNftPercentPerNft}
                            onChange={(e) => update({ extNftPercentPerNft: e.target.value.replace(/[^\d]/g, '') })}
                            style={{ maxWidth: 80 }}
                          />
                          <span style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
                            % off per nft they own
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
                            up to
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            className="uru-input"
                            placeholder="10"
                            value={tier.extNftCap}
                            onChange={(e) => update({ extNftCap: e.target.value.replace(/[^\d]/g, '') })}
                            style={{ maxWidth: 80 }}
                          />
                          <span style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
                            nfts
                          </span>
                        </div>
                      </div>
                      <span className={styles.fieldHint}>
                        example: {tier.extNftPercentPerNft || 5}% × {tier.extNftCap || 10} nfts owned ={' '}
                        <b>{Number(tier.extNftPercentPerNft || 5) * Number(tier.extNftCap || 10)}% off max</b>.
                        we check their wallet on {chainLabel(tier.extNftChain)} when they mint.
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              className={styles.addTierBtn}
              onClick={() => setDiscountTiers([...discountTiers, newDiscountTier()])}
            >
              ✿ add tier
            </button>
          </section>
        </div>

        {/* Right rail — preview + CTA */}
        <aside className={styles.launchRail}>
          <div className={styles.preview}>
            <div className={styles.previewTopline}>
              <span>preview</span>
              <b>chibi × urufu</b>
            </div>
            <div
              className={styles.previewArt}
              style={coverDataUrl ? { backgroundImage: `url(${coverDataUrl})` } : undefined}
            >
              {!coverDataUrl && <span>{previewTitle}</span>}
            </div>
            <div className={styles.previewTicket}>
              <b>❁ {previewTicker}</b>
              <dl>
                <dt>chain</dt><dd>{activeChain}</dd>
                <dt>mode</dt><dd>{mintMode === 'fixed' ? 'fixed price' : 'linear step'}</dd>
                <dt>price</dt><dd>{priceLabel}</dd>
                <dt>supply</dt><dd>{previewSupply}</dd>
                {wlFlavor === 'holders' && (
                  <>
                    <dt>wl</dt>
                    <dd>{wlHoldersMin || 1}+ on {chainLabel(wlHoldersChain)}</dd>
                    <dt>window</dt>
                    <dd>{wlOpenWindowMin || 60} min</dd>
                  </>
                )}
                {wlFlavor === 'walletList' && (
                  <>
                    <dt>wl</dt>
                    <dd>{wlWalletCount} wallets</dd>
                    <dt>window</dt>
                    <dd>{wlOpenWindowMin || 60} min</dd>
                  </>
                )}
                {discountTiers.length > 0 && (
                  <><dt>tiers</dt><dd>{discountTiers.length}</dd></>
                )}
              </dl>
            </div>
          </div>

          <div className={styles.launchCta}>
            <button
              type="button"
              className={`uru-btn ${canSubmit ? 'uru-btn-primary' : ''}`}
              disabled={!canSubmit}
              onClick={() => {
                // Submit path lands once NftMintModule ships. Until then this
                // is a no-op so we don't broadcast against zero addresses.
              }}
            >
              {canSubmit ? '✿ launch collection' : '❁ launch collection'}
            </button>
            {disabledReason && (
              <p className={styles.reasonNote}>{disabledReason}</p>
            )}
            <Link
              href="/create"
              className="uru-eyebrow"
              style={{ textAlign: 'center', textDecoration: 'underline' }}
            >
              or launch an ERC-20 token
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function chainLabel(id: ExternalNftChain): string {
  return EXTERNAL_NFT_CHAINS.find((c) => c.id === id)?.label ?? id;
}
