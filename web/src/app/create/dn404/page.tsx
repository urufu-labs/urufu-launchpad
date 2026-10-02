'use client';

/// DN404 launch studio.
///
/// The DN404 lane is a paired ERC-20 + mirror ERC-721. The launcher picks a
/// `unit` (whole tokens per NFT: "hold N to hold one art piece") and a
/// `collectionSize` (how many NFTs exist). `totalSupply = collectionSize *
/// unit` is derived and shown as a live preview. There is no mint mechanic
/// selector, no per-mint price, and no whitelist: trading happens on the
/// bonding curve, and NFTs mint/burn on whole-unit balance transitions.
///
/// Layout mirrors /create/nft (hero, section cards, mode chips, sticky
/// preview + launch rail) so both collection lanes feel like one product.
/// The form takes plain percents and durations; conversion to the factory's
/// bps / L1-block units happens here, right before `launch()`.
///
/// Deep-link contract (studio → here):
///   /create/dn404?baseUri=ipfs://...&name=...&ticker=...&collectionSize=...&contractUri=...
///
/// Gate posture: form always renders when the feature flag is on, but the
/// submit button stays disabled until the DN404_LAUNCHES[chain] slot is
/// populated (isDn404DeployReady).

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { decodeEventLog, formatUnits, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import {
  DN404_LAUNCHES,
  DN404_LAUNCHES_ENABLED,
  DN404_TAX_MODES,
  ECOSYSTEM_TOKENS,
  activePairCurrencies,
  activeTaxDestinations,
  isDn404DeployReady,
} from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { MAX_DN404_COLLECTION_SIZE } from '@/lib/dn404Gas';
import { dn404LaunchFactoryAbi } from '@/lib/abis';
import { readFileAsDataUrl } from '@/lib/metadata';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import styles from '../nft/nft-studio.module.css';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/// Factory caps (Dn404LaunchFactory): founder premint <= 2000 bps and
/// <= 100 NFTs; tax <= 500 bps; total supply fits in uint96.
const MAX_FOUNDER_PERCENT = 20;
const MAX_PREMINT_NFT_COUNT = 100;
const MAX_TAX_PERCENT = 5;
const MAX_TOTAL_SUPPLY_WEI = (1n << 96n) - 1n;
/// MultiHookHost.MAX_BUYBACK_BPS = 2000.
const MAX_BURN_PERCENT = 20;

/// Post-graduation trading pause. The hook gate counts `block.number`,
/// which on Robinhood (Arbitrum stack) is the Ethereum L1 block, ~12 s.
/// Same conversion as the ERC-20 launcher's AntiSniper input.
const PAUSE_OPTIONS = [
  { blocks: 0, label: 'no pause', ticket: 'none' },
  { blocks: 1, label: 'about 12 seconds', ticket: '~12 sec' },
  { blocks: 5, label: 'about 1 minute', ticket: '~1 min' },
  { blocks: 25, label: 'about 5 minutes', ticket: '~5 min' },
] as const;

function sanitizeTicker(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d]/g, '');
}

/// Up to two decimals ("12.5", "0.25"). Percent inputs map to whole bps.
function percentInput(s: string): string {
  const cleaned = s.replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  if (rest.length === 0) return whole;
  return `${whole}.${rest.join('').slice(0, 2)}`;
}

function percentToBps(s: string): number {
  const n = Number(s || '0');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fmtWhole(n: bigint): string {
  return n.toLocaleString('en-US');
}

function fmtTokens(wei: bigint): string {
  const [whole, frac] = formatUnits(wei, 18).split('.');
  const w = BigInt(whole).toLocaleString('en-US');
  return frac ? `${w}.${frac.slice(0, 4)}` : w;
}

/// Chip copy: lowercase like the NFT studio, but keep URU in caps.
function chipText(s: string): string {
  return s.toLowerCase().replace(/\buru\b/g, 'URU').replace(/\beth\b/g, 'ETH');
}

/// Mode chips force lowercase via CSS; DN404 chips carry token names that
/// must stay upper case, so they opt out and lowercase in `chipText`.
const CHIP_STYLE = { textTransform: 'none' } as const;

export default function CreateDn404Page() {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return (
    <Suspense fallback={null}>
      <CreateDn404Form />
    </Suspense>
  );
}

function CreateDn404Form() {
  const activeChain = useActiveChain();
  const chainEnabled = DN404_LAUNCHES_ENABLED[activeChain] === true;
  const deployReady = isDn404DeployReady(activeChain);

  const search = useSearchParams();
  const [name, setName] = useState(search.get('name') ?? '');
  const [ticker, setTicker] = useState(sanitizeTicker(search.get('ticker') ?? ''));
  const [baseUri, setBaseUri] = useState(search.get('baseUri') ?? '');
  const [contractUri, setContractUri] = useState(search.get('contractUri') ?? '');
  const [collectionSize, setCollectionSize] = useState(search.get('collectionSize') ?? '');
  const [unit, setUnit] = useState('');
  const [founderPercent, setFounderPercent] = useState('0');
  const [antiSniperBlocks, setAntiSniperBlocks] = useState<number>(0);
  const [burnPercent, setBurnPercent] = useState('0');

  // Pair currency the DN404 trades against on the bonding curve.
  // ETH (address(0)) routes through V10 CurveFactory unchanged. Non-ETH
  // values route through Dn404CurveFactory and are gated by the on-chain
  // Dn404PairCurrencyAllowlist.
  const [pairCurrency, setPairCurrency] = useState<Address>(ZERO);
  const pairOptions = useMemo(() => activePairCurrencies(activeChain), [activeChain]);
  const pairLabel = pairOptions.find((o) => o.address === pairCurrency)?.label ?? 'ETH';

  // Tax: Off routes through the bare Dn404Template (cheaper transfers).
  // Any other mode routes through the tax template + keeper flow.
  const [taxMode, setTaxMode] = useState<number>(0);
  const [taxPercent, setTaxPercent] = useState<string>('1');
  const [taxTarget, setTaxTarget] = useState<Address>(ZERO);
  const taxModeOption = DN404_TAX_MODES.find((m) => m.value === taxMode) ?? DN404_TAX_MODES[0];
  const taxDestOptions = useMemo(() => activeTaxDestinations(activeChain), [activeChain]);
  const taxTargetLabel = taxDestOptions.find((o) => o.address === taxTarget)?.label;

  // Cover art. An uploaded file wins; otherwise we pull the image from the
  // collection JSON (contractURI) or token #1's metadata (baseURI + "1").
  // Preview only: marketplaces read the art from the links on-chain.
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

  const artKey = `${contractUri.trim()}|${baseUri.trim()}`;
  const [autoArt, setAutoArt] = useState<{ key: string; url: string | null; done: boolean }>({
    key: '',
    url: null,
    done: false,
  });
  useEffect(() => {
    const cu = contractUri.trim();
    const bu = baseUri.trim();
    if (!cu && !bu) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      let url: string | null = null;
      if (cu) {
        const meta = await fetchIpfsJson<{ image?: string }>(cu);
        url = toGatewayUrl(meta?.image);
      }
      if (!url && bu) {
        const first = `${bu.endsWith('/') ? bu : `${bu}/`}1`;
        const meta = await fetchIpfsJson<{ image?: string }>(first);
        url = toGatewayUrl(meta?.image);
      }
      if (!cancelled) setAutoArt({ key: `${cu}|${bu}`, url, done: true });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [baseUri, contractUri]);
  const autoCover = autoArt.key === artKey ? autoArt.url : null;
  const artLookupPending = artKey !== '|' && autoArt.key !== artKey;
  const coverUrl = coverDataUrl ?? autoCover;

  // Live derived values
  const collectionSizeBig = useMemo(() => {
    try { return BigInt(collectionSize || '0'); } catch { return 0n; }
  }, [collectionSize]);
  const unitBig = useMemo(() => {
    try { return BigInt(unit || '0'); } catch { return 0n; }
  }, [unit]);
  const founderBps = percentToBps(founderPercent);
  const taxBps = percentToBps(taxPercent);
  const burnBps = percentToBps(burnPercent);

  const totalSupplyWei = collectionSizeBig * unitBig * 10n ** 18n;
  const safeFounderBps = BigInt(Math.min(founderBps, MAX_FOUNDER_PERCENT * 100));
  const founderMintWei = (totalSupplyWei * safeFounderBps) / 10_000n;
  const premintNfts = (collectionSizeBig * safeFounderBps) / 10_000n;

  // Client-side validation mirrors the factory's on-chain gates so the
  // launcher sees the failure before they pay gas.
  const nameOk = name.trim().length > 0;
  const tickerOk = ticker.length > 0;
  // Robinhood caps each tx at 32M gas and every mirror NFT minted costs ~11.5k,
  // so huge collections (tiny units) make ordinary buys cross too many NFTs.
  // Never silently clamp a studio-prefilled value; show the error instead.
  const collectionSizeTooBig = collectionSizeBig > MAX_DN404_COLLECTION_SIZE;
  const collectionSizeOk = collectionSizeBig > 0n && !collectionSizeTooBig;
  const unitOk = unitBig > 0n;
  const supplyTooBig = totalSupplyWei > MAX_TOTAL_SUPPLY_WEI;
  const founderBpsOk = founderBps >= 0 && founderBps <= MAX_FOUNDER_PERCENT * 100;
  const premintNftsOk = premintNfts <= BigInt(MAX_PREMINT_NFT_COUNT);
  const taxBpsOk = taxMode === 0 || (taxBps > 0 && taxBps <= MAX_TAX_PERCENT * 100);
  const taxTargetOk = !taxModeOption.needsAllowlistedTarget || taxTarget !== ZERO;
  const burnBpsOk = burnBps >= 0 && burnBps <= MAX_BURN_PERCENT * 100;

  // ------------------------------------------------------------
  // On-chain wiring (only active when DN404_LAUNCHES[chain] is set).
  // ------------------------------------------------------------
  const { address: walletAddress } = useAccount();
  const dn404Set = DN404_LAUNCHES[activeChain];
  const factoryAddress = dn404Set?.LaunchFactory as Address | undefined;
  const ecosystem = ECOSYSTEM_TOKENS[activeChain];
  const uruTokenAddress = ecosystem?.uruToken as Address | undefined;

  // Live minUruFee quote: factory applies the launcher's LoyaltyOracle
  // discount server-side. Same read pattern as the NFT lane.
  const { data: minUruFeeQuote } = useReadContract({
    address: factoryAddress,
    abi: dn404LaunchFactoryAbi,
    functionName: 'minUruFeeFor',
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: !!factoryAddress && !!walletAddress, staleTime: 30_000 },
  });
  const requiredUruFee = (minUruFeeQuote as bigint | undefined) ?? 0n;

  // URU allowance check: launcher must have approved factory for
  // >= requiredUruFee before launch(). Approval is a separate tx.
  const { data: uruAllowance, refetch: refetchAllowance } = useReadContract({
    address: uruTokenAddress,
    abi: [
      {
        type: 'function',
        name: 'allowance',
        stateMutability: 'view',
        inputs: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }],
      },
    ] as const,
    functionName: 'allowance',
    args: walletAddress && factoryAddress ? [walletAddress, factoryAddress] : undefined,
    query: { enabled: !!uruTokenAddress && !!walletAddress && !!factoryAddress, staleTime: 15_000 },
  });
  const needsUruApprove = requiredUruFee > 0n && (uruAllowance ?? 0n) < requiredUruFee;

  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproving,
  } = useWriteContract();
  const { isLoading: isWaitingApprove, isSuccess: isApproved } =
    useWaitForTransactionReceipt({ hash: approveTxHash });

  useEffect(() => {
    if (isApproved) refetchAllowance();
  }, [isApproved, refetchAllowance]);

  // Re-hydrate when the studio deep-links after mount (back/forward or a
  // fresh generate that re-navigates). Mirrors /create/nft so a studio
  // session that regenerates art lands the new baseUri here too.
  useEffect(() => {
    const n = search.get('name'); if (n !== null) setName(n);
    const t = search.get('ticker'); if (t !== null) setTicker(sanitizeTicker(t));
    const b = search.get('baseUri'); if (b !== null) setBaseUri(b);
    const cu = search.get('contractUri'); if (cu !== null) setContractUri(cu);
    const c = search.get('collectionSize'); if (c !== null) setCollectionSize(c);
  }, [search]);

  const approveUru = () => {
    if (!uruTokenAddress || !factoryAddress) return;
    writeApprove({
      address: uruTokenAddress,
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ] as const,
      functionName: 'approve',
      args: [factoryAddress, requiredUruFee],
    });
  };

  const {
    writeContract,
    data: launchTxHash,
    isPending: isLaunching,
    error: launchError,
    reset: resetLaunch,
  } = useWriteContract();
  const { isLoading: isWaitingLaunch, isSuccess: isLaunched, data: receipt } =
    useWaitForTransactionReceipt({ hash: launchTxHash });

  // Pull the new token out of Dn404Launched so we can link (and redirect)
  // to its trade page. Null-safe: a missing log just skips the redirect.
  const router = useRouter();
  const launchedToken: Address | null = useMemo(() => {
    if (!receipt) return null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: dn404LaunchFactoryAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'Dn404Launched') {
          return (decoded.args as { base: Address }).base;
        }
      } catch { /* not our event; keep scanning */ }
    }
    return null;
  }, [receipt]);

  useEffect(() => {
    if (!isLaunched || !launchedToken) return;
    const t = setTimeout(() => router.push(`/trade/${launchedToken}`), 2000);
    return () => clearTimeout(t);
  }, [isLaunched, launchedToken, router]);

  const formOk =
    nameOk &&
    tickerOk &&
    collectionSizeOk &&
    unitOk &&
    !supplyTooBig &&
    founderBpsOk &&
    premintNftsOk &&
    taxBpsOk &&
    taxTargetOk &&
    burnBpsOk;

  const canSubmit =
    deployReady &&
    !!factoryAddress &&
    !!walletAddress &&
    !needsUruApprove &&
    formOk &&
    !isLaunching &&
    !isWaitingLaunch;

  const disabledReason = useMemo(() => {
    if (!chainEnabled) return `dn404 launches are not live on this chain yet`;
    if (!deployReady) return 'launch contracts are not set up on this chain yet';
    if (!walletAddress) return 'connect a wallet to launch';
    if (!nameOk) return 'add a name';
    if (!tickerOk) return 'add a ticker';
    if (!collectionSizeOk) return collectionSizeTooBig
      ? `max ${fmtWhole(MAX_DN404_COLLECTION_SIZE)} NFTs per collection`
      : 'set how many NFTs the collection has';
    if (!unitOk) return 'set how many tokens make one NFT';
    if (supplyTooBig) return 'total supply is too large. use fewer NFTs or fewer tokens per NFT';
    if (!founderBpsOk) return `your share can be at most ${MAX_FOUNDER_PERCENT}%`;
    if (!premintNftsOk) return `your share can include at most ${MAX_PREMINT_NFT_COUNT} NFTs`;
    if (!taxBpsOk) return `tax rate must be above 0% and at most ${MAX_TAX_PERCENT}%`;
    if (!taxTargetOk) return 'pick which token the tax buys';
    if (!burnBpsOk) return `burn can be at most ${MAX_BURN_PERCENT}%`;
    return null;
  }, [
    chainEnabled, deployReady, walletAddress, nameOk, tickerOk, collectionSizeOk,
    collectionSizeTooBig, unitOk, supplyTooBig, founderBpsOk, premintNftsOk,
    taxBpsOk, taxTargetOk, burnBpsOk,
  ]);

  const submit = () => {
    if (!factoryAddress) return;
    if (!collectionSizeOk) return; // also gated by canSubmit; belt and braces

    resetLaunch();
    writeContract({
      address: factoryAddress,
      abi: dn404LaunchFactoryAbi,
      functionName: 'launch',
      args: [
        {
          name,
          ticker,
          baseURI: baseUri,
          contractURI: contractUri,
          collectionSize: collectionSizeBig,
          unit: unitBig,
          founderPremintBps: founderBps,
          antiSniperBlocks,
          buybackBurnBps: burnBps,
          pairCurrency,
          taxMode,
          taxBps: taxMode === 0 ? 0 : taxBps,
          taxTarget,
          uruAmount: requiredUruFee,
        },
      ],
    });
  };

  const previewTitle = name.trim() || 'your collection';
  const previewTicker = ticker || '???';
  // Before a ticker is typed, read naturally ("spend ETH to get tokens").
  const tickLabel = ticker || 'tokens';
  const pauseTicket = PAUSE_OPTIONS.find((p) => p.blocks === antiSniperBlocks)?.ticket ?? 'none';

  return (
    <div className={styles.studio}>
      <header className={styles.hero}>
        <div className={styles.heroTitle}>
          <Mascot size={48} mood="happy" />
          <h1 className={styles.uruH1}>❁ launch a DN404 collection</h1>
          <span className="uru-stamp uru-stamp-mint" style={{ transform: 'rotate(-4deg)' }}>
            token + nft
          </span>
        </div>
        <p className={styles.heroSub}>
          one token and one NFT collection, joined together. hold enough tokens and you hold an
          NFT; sell them and the NFT goes away. it trades on a curve until it fills up, then moves
          to Uniswap. got your art already? paste the links. or make it in{' '}
          <a href="https://studio.urufulabs.xyz/" target="_blank" rel="noopener noreferrer">
            chibi studio ↗
          </a>.
        </p>
      </header>

      {!chainEnabled && (
        <div className={styles.warnPane} style={{ marginBottom: 14 }}>
          <b>not live on {activeChain}.</b> switch to robinhood to launch.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          {/* Basics */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❀ basics</span>
              <span className={styles.sectionEye}>name · ticker · size</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-name">name</label>
              <input
                id="dn-name"
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
                <label className={styles.fieldLabel} htmlFor="dn-ticker">ticker</label>
                <input
                  id="dn-ticker"
                  type="text"
                  className="uru-input"
                  value={ticker}
                  onChange={(e) => setTicker(sanitizeTicker(e.target.value))}
                  placeholder="CHIBI"
                  maxLength={10}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dn-size">how many NFTs</label>
                <input
                  id="dn-size"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={collectionSize}
                  onChange={(e) => setCollectionSize(digitsOnly(e.target.value))}
                  placeholder="1000"
                />
                {collectionSizeTooBig && (
                  <span className={styles.fieldHint} style={{ color: 'var(--pink-hot)' }}>
                    max {fmtWhole(MAX_DN404_COLLECTION_SIZE)} NFTs per collection, so buys stay
                    under Robinhood&apos;s gas limit.
                  </span>
                )}
              </div>
            </div>

            <div className={`${styles.field} ${styles.shortField}`}>
              <label className={styles.fieldLabel} htmlFor="dn-unit">tokens per NFT</label>
              <input
                id="dn-unit"
                type="text"
                inputMode="numeric"
                className="uru-input"
                value={unit}
                onChange={(e) => setUnit(digitsOnly(e.target.value))}
                placeholder="10000"
              />
              <span className={styles.fieldHint}>
                hold {unit ? fmtWhole(unitBig) : 'this many'} {tickLabel}, get 1 NFT.
                {unitOk && collectionSizeOk && (
                  <> total supply: {fmtWhole(collectionSizeBig * unitBig)} {tickLabel}.</>
                )}
                {supplyTooBig && (
                  <span style={{ color: 'var(--pink-hot)' }}>
                    {' '}too large. use fewer NFTs or fewer tokens per NFT.
                  </span>
                )}
              </span>
            </div>
          </section>

          {/* Art */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✿ art</span>
              <span className={styles.sectionEye}>what the NFTs look like</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-baseuri">art folder link</label>
              <input
                id="dn-baseuri"
                type="text"
                className="uru-input"
                value={baseUri}
                onChange={(e) => setBaseUri(e.target.value)}
                placeholder="ipfs://bafy.../"
              />
              <span className={styles.fieldHint}>
                the folder holding 1.json, 2.json and so on. end it with a slash. chibi studio fills
                this in for you.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-cuuri">collection info link (optional)</label>
              <input
                id="dn-cuuri"
                type="text"
                className="uru-input"
                value={contractUri}
                onChange={(e) => setContractUri(e.target.value)}
                placeholder="ipfs://bafy.../collection.json"
              />
              <span className={styles.fieldHint}>
                the cover and description marketplaces like OpenSea show. leave blank to skip.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>cover preview</label>
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
              <span className={styles.fieldHint}>
                {coverDataUrl
                  ? 'showing your upload. it is only for this preview; marketplaces use the art from your links.'
                  : artLookupPending
                    ? 'looking for your art ~'
                    : autoCover
                      ? 'found your art from the links above.'
                      : baseUri || contractUri
                        ? 'could not load art from those links yet. you can upload an image to preview.'
                        : 'paste your art links and the cover shows up here, or upload an image to preview.'}
              </span>
            </div>
          </section>

          {/* Trading */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✦ trading</span>
              <span className={styles.sectionEye}>what buyers pay with</span>
            </div>

            <div className={styles.modeRow}>
              {pairOptions.map((opt) => (
                <button
                  key={opt.address}
                  type="button"
                  className={styles.modeChip}
                  style={CHIP_STYLE}
                  data-active={pairCurrency === opt.address}
                  onClick={() => setPairCurrency(opt.address as Address)}
                  aria-label={`Pay in ${opt.label}`}
                >
                  pay in {opt.label}
                </button>
              ))}
            </div>
            <p className={styles.fieldHint}>
              buyers spend {pairLabel} to get {tickLabel}. once the curve fills up, it moves to a
              Uniswap pool paired with {pairLabel}.
            </p>

            <div className={styles.field} style={{ marginTop: 14 }}>
              <label className={styles.fieldLabel}>pause trading right after it moves to Uniswap</label>
              <div className={styles.modeRow} style={{ marginBottom: 4 }}>
                {PAUSE_OPTIONS.map((p) => (
                  <button
                    key={p.blocks}
                    type="button"
                    className={styles.modeChip}
                    data-active={antiSniperBlocks === p.blocks}
                    onClick={() => setAntiSniperBlocks(p.blocks)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span className={styles.fieldHint}>
                a short pause stops bots from buying the instant the pool opens.
              </span>
            </div>

            <div className={`${styles.field} ${styles.tinyField}`}>
              <label className={styles.fieldLabel} htmlFor="dn-burn">burn on Uniswap buys (%)</label>
              <input
                id="dn-burn"
                type="text"
                inputMode="decimal"
                className="uru-input"
                value={burnPercent}
                onChange={(e) => setBurnPercent(percentInput(e.target.value))}
                placeholder="0"
              />
            </div>
            <span className={styles.fieldHint}>
              {burnBpsOk
                ? burnBps > 0
                  ? `${burnPercent}% of the ${tickLabel} from every Uniswap buy is burned. 0 turns it off.`
                  : `0 = off. up to ${MAX_BURN_PERCENT}%.`
                : <span style={{ color: 'var(--pink-hot)' }}>max {MAX_BURN_PERCENT}%.</span>}
            </span>
          </section>

          {/* Your share */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✧ your share (optional)</span>
              <span className={styles.sectionEye}>up to {MAX_FOUNDER_PERCENT}%, the rest goes on the curve</span>
            </div>

            <div className={`${styles.field} ${styles.tinyField}`}>
              <label className={styles.fieldLabel} htmlFor="dn-founder">your share (%)</label>
              <input
                id="dn-founder"
                type="text"
                inputMode="decimal"
                className="uru-input"
                value={founderPercent}
                onChange={(e) => setFounderPercent(percentInput(e.target.value))}
                placeholder="0"
              />
            </div>
            <span className={styles.fieldHint}>
              {!founderBpsOk ? (
                <span style={{ color: 'var(--pink-hot)' }}>max {MAX_FOUNDER_PERCENT}%.</span>
              ) : founderBps === 0 ? (
                'everything goes on the curve. you buy like everyone else.'
              ) : (
                <>
                  you get {fmtTokens(founderMintWei)} {tickLabel} and {fmtWhole(premintNfts)} NFT
                  {premintNfts === 1n ? '' : 's'} at launch.
                  {!premintNftsOk && (
                    <span style={{ color: 'var(--pink-hot)' }}>
                      {' '}that is over the {MAX_PREMINT_NFT_COUNT} NFT limit. lower your share or
                      raise tokens per NFT.
                    </span>
                  )}
                </>
              )}
            </span>
          </section>

          {/* Tax */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">♡ tax (optional)</span>
              <span className={styles.sectionEye}>take a cut of transfers and put it to work</span>
            </div>

            <div className={styles.modeRow}>
              {DN404_TAX_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={styles.modeChip}
                  style={CHIP_STYLE}
                  data-active={taxMode === m.value}
                  onClick={() => {
                    setTaxMode(m.value);
                    if (!m.needsAllowlistedTarget) setTaxTarget(ZERO);
                  }}
                >
                  {chipText(m.label)}
                </button>
              ))}
            </div>

            <p className={styles.fieldHint}>
              {taxMode === 0
                ? 'no tax. this is the default and makes transfers cheapest.'
                : `${taxModeOption.description}. our bot handles it automatically and keeps 5% of each payout for gas. the rate can not change after launch.`}
            </p>

            {taxMode !== 0 && (
              <div className={`${styles.field} ${styles.tinyField}`} style={{ marginTop: 12 }}>
                <label className={styles.fieldLabel} htmlFor="dn-tax">tax rate (%)</label>
                <input
                  id="dn-tax"
                  type="text"
                  inputMode="decimal"
                  className="uru-input"
                  value={taxPercent}
                  onChange={(e) => setTaxPercent(percentInput(e.target.value))}
                  placeholder="1"
                />
                <span className={styles.fieldHint}>
                  {taxBpsOk
                    ? `up to ${MAX_TAX_PERCENT}%.`
                    : <span style={{ color: 'var(--pink-hot)' }}>pick a rate above 0% and up to {MAX_TAX_PERCENT}%.</span>}
                </span>
              </div>
            )}

            {taxModeOption.needsAllowlistedTarget && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>token to buy</label>
                <div className={styles.modeRow} style={{ marginBottom: 4 }}>
                  {taxDestOptions.map((opt) => (
                    <button
                      key={opt.address}
                      type="button"
                      className={styles.modeChip}
                      style={CHIP_STYLE}
                      data-active={taxTarget === opt.address}
                      onClick={() => setTaxTarget(opt.address as Address)}
                      title={opt.description}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className={styles.fieldHint}>
                  {taxDestOptions.length === 0
                    ? 'no tokens are approved for this yet.'
                    : 'only approved tokens are shown.'}
                </span>
              </div>
            )}
          </section>
        </div>

        {/* Right rail: preview + CTA */}
        <aside className={styles.launchRail}>
          <div className={styles.preview}>
            <div className={styles.previewTopline}>
              <span>preview</span>
              <b>token + nft</b>
            </div>
            <div
              className={styles.previewArt}
              style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
            >
              {!coverUrl && <span>{previewTitle}</span>}
            </div>
            <div className={styles.previewTicket}>
              <b>❁ {previewTicker}</b>
              <dl>
                <dt>chain</dt><dd>{activeChain}</dd>
                <dt>pay with</dt><dd>{pairLabel}</dd>
                <dt>NFTs</dt><dd>{collectionSizeOk ? fmtWhole(collectionSizeBig) : '?'}</dd>
                <dt>1 NFT</dt><dd>{unitOk ? `${fmtWhole(unitBig)} ${tickLabel}` : '?'}</dd>
                <dt>supply</dt>
                <dd>{unitOk && collectionSizeOk ? `${fmtWhole(collectionSizeBig * unitBig)} ${tickLabel}` : '?'}</dd>
                {founderBps > 0 && founderBpsOk && (
                  <><dt>your share</dt><dd>{founderPercent}% ({fmtWhole(premintNfts)} NFTs)</dd></>
                )}
                <dt>tax</dt>
                <dd>
                  {taxMode === 0
                    ? 'none'
                    : `${taxPercent || 0}%, ${chipText(taxModeOption.label)}${taxTargetLabel ? ` (${taxTargetLabel})` : ''}`}
                </dd>
                {antiSniperBlocks > 0 && <><dt>pause</dt><dd>{pauseTicket}</dd></>}
                {burnBps > 0 && burnBpsOk && <><dt>burn</dt><dd>{burnPercent}% of Uniswap buys</dd></>}
                {requiredUruFee > 0n && <><dt>launch fee</dt><dd>{fmtTokens(requiredUruFee)} URU</dd></>}
              </dl>
            </div>
          </div>

          <div className={styles.launchCta}>
            {needsUruApprove && !isApproved && (
              <button
                type="button"
                className="uru-btn uru-btn-mint"
                disabled={isApproving || isWaitingApprove}
                onClick={approveUru}
              >
                {isWaitingApprove
                  ? 'waiting for approval ~'
                  : isApproving
                    ? 'approving URU ~'
                    : `✿ approve ${fmtTokens(requiredUruFee)} URU`}
              </button>
            )}
            <button
              type="button"
              className={`uru-btn ${canSubmit ? 'uru-btn-primary' : ''}`}
              disabled={!canSubmit || isLaunched}
              onClick={submit}
            >
              {isLaunched
                ? '✿ launched ✓'
                : isWaitingLaunch
                  ? 'waiting for receipt ~'
                  : isLaunching
                    ? 'confirming in wallet ~'
                    : canSubmit
                      ? '✿ launch collection'
                      : '❁ launch collection'}
            </button>
            {requiredUruFee > 0n && (
              <p className={styles.reasonNote}>
                launch fee: {fmtTokens(requiredUruFee)} URU (approve first)
              </p>
            )}
            {launchError && (
              <p className={styles.reasonNote} style={{ color: 'var(--pink-hot)' }}>
                {launchError.message.split('\n')[0]}
              </p>
            )}
            {isLaunched && receipt && (
              <p className={styles.reasonNote}>
                launched in block {receipt.blockNumber.toString()}.
                {launchedToken ? (
                  <>
                    {' '}opening{' '}
                    <Link href={`/trade/${launchedToken}`} style={{ textDecoration: 'underline' }}>
                      the trade page
                    </Link>
                    {' '}~
                  </>
                ) : (
                  <> find it on the discover page under dn404.</>
                )}
              </p>
            )}
            {disabledReason && !isLaunching && !isWaitingLaunch && !isLaunched && (
              <p className={styles.reasonNote}>{disabledReason}</p>
            )}
            {!disabledReason && needsUruApprove && !isLaunched && (
              <p className={styles.reasonNote}>approve the URU fee, then launch.</p>
            )}
            <Link
              href="/create/nft"
              className="uru-eyebrow"
              style={{ textAlign: 'center', textDecoration: 'underline' }}
            >
              or launch a regular NFT collection
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
