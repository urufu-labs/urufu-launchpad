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
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  decodeEventLog,
  parseUnits,
  isAddress,
  zeroAddress,
  type Address,
} from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { CHAIN_LABELS, NFT_LAUNCHES, NFT_LAUNCHES_ENABLED, ECOSYSTEM_TOKENS, isNftDeployReady } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { readFileAsDataUrl } from '@/lib/metadata';
import { nftLaunchFactoryAbi, NFT_MINT_MODE, NFT_TIER_KIND, NFT_WL_FLAVOR } from '@/lib/abis';
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
  { id: 'ethereum', label: 'Ethereum', chainId: 1 },
  { id: 'base', label: 'Base', chainId: 8453 },
  { id: 'robinhood', label: 'Robinhood', chainId: 4663 },
] as const;
type ExternalNftChain = (typeof EXTERNAL_NFT_CHAINS)[number]['id'];

function externalChainIdOf(id: ExternalNftChain): number {
  return EXTERNAL_NFT_CHAINS.find((c) => c.id === id)?.chainId ?? 0;
}

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

/// Whitelists and wallet-list discount tiers (re-enabled 2026-10-09). Pasted
/// lists are saved with compile-service (/api/nft-wl/list), which returns the
/// merkle root the contract stores; the collection page fetches each minter's
/// proof, and holder whitelists get a signed balance from /api/nft-wl/attest.
/// Proven on a fork in contracts/test/nft/NftWalletListFork.t.sol. Set false to
/// hide both options again.
const NFT_WL_READY = true;

/// Save a pasted wallet list with compile-service and return its merkle root.
/// The service recomputes the root itself, so it always matches the list.
async function saveWalletList(text: string): Promise<`0x${string}`> {
  const base = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? '';
  let res: Response;
  try {
    res = await fetch(`${base}/api/nft-wl/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallets: text }),
    });
  } catch {
    throw new Error("Couldn't save the wallet list. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { root?: string; code?: string; max?: number };
  if (res.ok && body.root && /^0x[0-9a-fA-F]{64}$/.test(body.root)) return body.root as `0x${string}`;
  if (body.code === 'NO_VALID_WALLETS') throw new Error('A wallet list has no valid addresses.');
  if (body.code === 'TOO_MANY_WALLETS') throw new Error(`A wallet list can have at most ${body.max ?? 10000} addresses.`);
  throw new Error("Couldn't save the wallet list right now. Try again in a moment.");
}

function newDiscountTier(): DiscountTier {
  return {
    key: Math.random().toString(36).slice(2, 10),
    kind: NFT_WL_READY ? 'walletList' : 'externalNft',
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
  /// Payment token for mints. Bound to the contract's `paymentToken`
  /// field at launch:
  ///   - `eth` → paymentToken=address(0), buyer pays ETH via mint()
  ///   - `uru` → paymentToken=URU addr,   buyer pays URU via mintWithUru()
  /// Deployer picks ONE per collection; can't be changed after launch.
  /// (The variable name still says "Eth" for both since it's just a
  /// number in whatever token's smallest unit — 18 decimals for both.)
  const [payWithUru, setPayWithUru] = useState(false);
  const priceUnit = payWithUru ? 'URU' : 'ETH';
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
      setCoverError(e instanceof Error ? e.message : 'Upload failed.');
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
    if (!chainEnabled) return "NFT launches aren't live on this chain yet.";
    if (!deployReady) return 'The launch contracts are still being set up. You can fill in the form now, and launching unlocks once they are live.';
    if (!nameOk) return 'Name must be 2 to 40 characters.';
    if (!tickerOk) return 'Ticker must be 2 to 10 characters (A-Z, 0-9).';
    if (!baseUriOk) return 'Base URI must start with ipfs://, ar:// or https://.';
    if (!maxSupplyOk) return 'Max supply must be a whole number from 1 to 100,000.';
    if (!basePriceOk) return 'Enter a valid mint price (and a step for linear step pricing).';
    return null;
  }, [chainEnabled, deployReady, nameOk, tickerOk, baseUriOk, maxSupplyOk, basePriceOk]);

  // ------------------------------------------------------------
  // On-chain wiring (only active when NFT_LAUNCHES[chain] is set).
  // ------------------------------------------------------------
  const { address: walletAddress, chainId: walletChainId } = useAccount();
  const nftSet = NFT_LAUNCHES[activeChain];
  // Pin every read and write to the launch chain; writes switch the wallet
  // first. Unpinned, a wallet on another network read a 0 fee from an empty
  // address there and sent launch() to it (same bug as /create/dn404).
  const targetChainId = CHAIN_KEY_TO_ID[activeChain];
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  async function ensureChain(): Promise<boolean> {
    if (walletChainId === targetChainId) return true;
    try {
      await switchChainAsync({ chainId: targetChainId });
      return true;
    } catch {
      return false;
    }
  }
  const factoryAddress = nftSet?.LaunchFactory as Address | undefined;
  const ecosystem = ECOSYSTEM_TOKENS[activeChain];
  const uruTokenAddress = ecosystem?.uruToken as Address | undefined;

  // Live minUruFee quote — factory applies the launcher's LoyaltyOracle
  // discount server-side. Zero on factories with no launch fee.
  const { data: minUruFeeQuote, isSuccess: feeLoaded } = useReadContract({
    address: factoryAddress,
    abi: nftLaunchFactoryAbi,
    functionName: 'minUruFeeFor',
    args: walletAddress ? [walletAddress] : undefined,
    chainId: targetChainId,
    query: { enabled: !!factoryAddress && !!walletAddress, staleTime: 30_000 },
  });
  const requiredUruFee = (minUruFeeQuote as bigint | undefined) ?? 0n;

  // URU allowance check — launcher must have approved factory for
  // ≥ requiredUruFee before launch() will succeed (safeTransferFrom
  // inside the launch tx will otherwise revert). Approval is a separate
  // tx; UI shows an approve button when short.
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
    chainId: targetChainId,
    query: { enabled: !!uruTokenAddress && !!walletAddress && !!factoryAddress, staleTime: 15_000 },
  });
  const needsUruApprove = requiredUruFee > 0n && (uruAllowance ?? 0n) < requiredUruFee;

  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproving,
  } = useWriteContract();
  const { isLoading: isWaitingApprove, isSuccess: isApproved } =
    useWaitForTransactionReceipt({ hash: approveTxHash, chainId: targetChainId });

  // Refetch the allowance the moment the approve tx confirms so the launch
  // button lights up without a manual refresh. Wagmi's useReadContract has
  // no built-in tx-completion invalidation, so we wire it here.
  useEffect(() => {
    if (isApproved) refetchAllowance();
  }, [isApproved, refetchAllowance]);

  const approveUru = async () => {
    if (!uruTokenAddress || !factoryAddress) return;
    if (!(await ensureChain())) return;
    writeApprove({
      chainId: targetChainId,
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
      // Approve exactly what's required — not max. Deployer can re-approve
      // if the fee changes. Prefers smaller-blast-radius approval over
      // convenience.
      args: [factoryAddress, requiredUruFee],
    });
  };

  const {
    writeContract,
    data: launchTxHash,
    isPending: isSubmitting,
    error: submitError,
    reset: resetSubmit,
  } = useWriteContract();
  const { isLoading: isWaitingReceipt, isSuccess: isLaunched, data: receipt } =
    useWaitForTransactionReceipt({ hash: launchTxHash, chainId: targetChainId });

  // Parse the CollectionLaunched event out of the receipt so we can (a) show
  // the launcher a clickable link to the mint page and (b) auto-redirect
  // there. Address decoding runs once per receipt and is null-safe: if the
  // event isn't in the logs for whatever reason (reorg, unsupported ABI),
  // we just skip the redirect and leave the tx-hash note.
  const router = useRouter();
  const launchedCollection: Address | null = useMemo(() => {
    if (!receipt) return null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: nftLaunchFactoryAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'CollectionLaunched') {
          return (decoded.args as { token: Address }).token;
        }
      } catch { /* not our event; keep scanning */ }
    }
    return null;
  }, [receipt]);

  // Auto-redirect to the mint page shortly after launch so the launcher can
  // eyeball their own collection immediately. Small delay lets the "launched"
  // toast render first; user can also click the link in the meantime.
  useEffect(() => {
    if (!isLaunched || !launchedCollection) return;
    const t = setTimeout(() => router.push(`/collection/${launchedCollection}`), 2000);
    return () => clearTimeout(t);
  }, [isLaunched, launchedCollection, router]);

  /// Encode `LaunchParams` and fire the tx. Everything the mint module
  /// needs is packed here — merkle roots (wallet-list tier + WL) get
  /// computed off-chain by the compile-service in a follow-up call, but
  /// for the phase-1 wire-up we pass whatever the deployer explicitly
  /// entered. Tiers without walletList/holders addresses land as their
  /// literal zero form so the module's per-tier validation catches
  /// deployer typos.
  const [savingLists, setSavingLists] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const submit = async () => {
    if (!factoryAddress || !uruTokenAddress) return;
    resetSubmit();
    setListError(null);
    if (!(await ensureChain())) return;

    // Save each pasted wallet list with compile-service first. It returns the
    // list's merkle root (what the contract stores) and keeps the list so the
    // collection page can hand each listed wallet its proof. If saving fails
    // we stop: a whitelist launched without a saved list could never be used.
    const zeroRoot = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
    const tierRoots: `0x${string}`[] = [];
    let wlWalletRoot: `0x${string}` = zeroRoot;
    try {
      setSavingLists(true);
      for (const t of discountTiers) {
        tierRoots.push(t.kind === 'walletList' ? await saveWalletList(t.walletList) : zeroRoot);
      }
      if (wlFlavor === 'walletList') wlWalletRoot = await saveWalletList(wlWalletList);
    } catch (err) {
      setListError((err as Error).message);
      return;
    } finally {
      setSavingLists(false);
    }

    const priceUnitDecimals = 18; // ETH + URU both 18 decimals
    const basePriceWei = basePriceEth
      ? parseUnits(basePriceEth, priceUnitDecimals)
      : 0n;
    const priceStepWei = mintMode === 'linear' && priceStepEth
      ? parseUnits(priceStepEth, priceUnitDecimals)
      : 0n;

    const wlWindowSecs = wlFlavor === 'off' ? 0n : BigInt(wlOpenWindowMin || '0') * 60n;

    // Convert user-facing percents → bps at submit time.
    const encodedTiers = discountTiers.map((t, i) => ({
      kind: t.kind === 'walletList' ? NFT_TIER_KIND.WalletList : NFT_TIER_KIND.ExternalNft,
      walletListRoot: tierRoots[i] ?? zeroRoot,
      externalCollection: (isAddress(t.extNftAddress) ? t.extNftAddress : zeroAddress) as Address,
      externalChainId: BigInt(externalChainIdOf(t.extNftChain)),
      percentPerNftBps: t.kind === 'externalNft' && t.extNftPercentPerNft
        ? BigInt(Number(t.extNftPercentPerNft) * 100)
        : 0n,
      maxCountedNfts: t.kind === 'externalNft' && t.extNftCap ? BigInt(t.extNftCap) : 0n,
      fixedDiscountBps: t.kind === 'walletList' && t.walletPercent
        ? BigInt(Number(t.walletPercent) * 100)
        : 0n,
    }));

    const wlHoldersTargetAddr =
      wlFlavor === 'holders' && isAddress(wlHoldersAddress)
        ? (wlHoldersAddress as Address)
        : zeroAddress;
    writeContract({
      chainId: targetChainId,
      address: factoryAddress,
      abi: nftLaunchFactoryAbi,
      functionName: 'launch',
      args: [
        {
          name,
          ticker,
          baseURI: baseUri,
          maxSupply: BigInt(maxSupply || '0'),
          mintMode: mintMode === 'fixed' ? NFT_MINT_MODE.Fixed : NFT_MINT_MODE.LinearStep,
          basePriceWei,
          priceStepWei,
          discountFloorBps: 1000n, // 10% floor default — matches the token launcher
          perWalletMintCap: 0n,     // no cap by default
          payWithUru,
          tiers: encodedTiers,
          wlFlavor:
            wlFlavor === 'off'
              ? NFT_WL_FLAVOR.Off
              : wlFlavor === 'holders'
                ? NFT_WL_FLAVOR.Holders
                : NFT_WL_FLAVOR.WalletList,
          wlHoldersTarget: wlHoldersTargetAddr,
          wlHoldersTargetChainId: BigInt(externalChainIdOf(wlHoldersChain)),
          wlHoldersMinCount: BigInt(wlHoldersMin || '0'),
          wlWalletListRoot: wlWalletRoot,
          wlWindowEnd: wlWindowSecs > 0n ? BigInt(Math.floor(Date.now() / 1000)) + wlWindowSecs : 0n,
          uruAmount: requiredUruFee,
        },
      ],
    });
  };

  const previewTitle = name.trim() || 'Your collection';
  const previewTicker = ticker || 'TICKER';
  // Preview + button copy switch when payWithUru flips.
  // Kept as computed strings so future locale-aware formatting (thousands
  // separators for URU, decimal-precision for ETH) can be added in one spot.
  const priceUnitLabel = priceUnit; // ETH | URU
  const previewSupply = maxSupply ? Number(maxSupply).toLocaleString('en-US') : 'Not set';
  const priceLabel = !basePriceEth
    ? 'Not set'
    : mintMode === 'fixed'
      ? `${basePriceEth} ${priceUnitLabel}`
      : priceStepEth
        ? `${basePriceEth} ${priceUnitLabel} + ${priceStepEth} per mint`
        : `${basePriceEth} ${priceUnitLabel} (linear)`;
  const chainName = activeChain === 'robinhood' ? 'Robinhood Chain' : (CHAIN_LABELS[activeChain] ?? activeChain);
  const feeText = `${(Number(requiredUruFee) / 1e18).toLocaleString()} URU`;

  return (
    <div className={styles.studio}>
      <header className={styles.hero}>
        <p className={styles.heroEyebrow}>Launch · NFT collection</p>
        <div className={styles.heroTitle}>
          <h1 className={styles.uruH1}>Launch an NFT collection</h1>
        </div>
        <p className={styles.heroSub}>
          Already have your art hosted? Paste its base URI. Or build the collection in{' '}
          <a href="https://studio.urufulabs.xyz/" target="_blank" rel="noopener noreferrer">
            chibi studio ↗
          </a>.
        </p>
      </header>

      {!chainEnabled && (
        <div className={styles.warnPane} role="status">
          <b>NFT launches aren&apos;t live on {chainName} yet.</b> Switch to Robinhood Chain to preview the flow.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          {/* Basics */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelHeadText}>
                <h2 className={styles.panelTitle}>Basics</h2>
                <p className={styles.panelSub}>Name, ticker, art and supply</p>
              </div>
            </div>

            <div className={styles.panelBody}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="nft-name">Collection name</label>
                <input
                  id="nft-name"
                  type="text"
                  className="ui-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My chibi collection"
                  maxLength={40}
                />
              </div>

              <div className={styles.rowInputs}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="nft-ticker">Ticker</label>
                  <input
                    id="nft-ticker"
                    type="text"
                    className="ui-input"
                    data-mono="true"
                    value={ticker}
                    onChange={(e) => setTicker(sanitizeTicker(e.target.value))}
                    placeholder="CHIBI"
                    maxLength={10}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="nft-supply">Max supply</label>
                  <input
                    id="nft-supply"
                    type="text"
                    inputMode="numeric"
                    className="ui-input"
                    data-mono="true"
                    value={maxSupply}
                    onChange={(e) => setMaxSupply(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="1000"
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="nft-baseuri">Base URI</label>
                <input
                  id="nft-baseuri"
                  type="text"
                  className="ui-input"
                  data-mono="true"
                  value={baseUri}
                  onChange={(e) => setBaseUri(e.target.value)}
                  placeholder="ipfs://bafy.../"
                />
                <p className={styles.fieldHint}>
                  The link to your metadata folder. End it with a slash: each NFT&apos;s metadata is
                  read from this link plus its token number.
                </p>
              </div>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Cover image</span>
                <div className={styles.coverActionsRow}>
                  <label className="ui-btn">
                    {coverDataUrl ? 'Change cover' : 'Upload cover'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => onPickCover(e.target.files?.[0])}
                      className={styles.hiddenInput}
                    />
                  </label>
                  {coverDataUrl && (
                    <button
                      type="button"
                      className="ui-btn"
                      data-variant="ghost"
                      onClick={() => { setCoverDataUrl(null); setCoverError(null); }}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {coverError && <p className={styles.fieldError}>{coverError}</p>}
              </div>
            </div>
          </section>

          {/* Mint mechanic */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelHeadText}>
                <h2 className={styles.panelTitle}>Mint price</h2>
                <p className={styles.panelSub}>How each mint is priced</p>
              </div>
            </div>

            <div className={styles.panelBody}>
              {/* The pricing pair (fixed / linear) and the payment pair (ETH /
                  URU) are separate radio groups, shown side by side. */}
              <div className={styles.optionGroups}>
                <div className={styles.optionGroup}>
                  <span className={styles.fieldLabel}>Pricing</span>
                  <div className={`ui-seg ${styles.seg}`}>
                    <button
                      type="button"
                      aria-pressed={mintMode === 'fixed'}
                      onClick={() => setMintMode('fixed')}
                    >
                      Fixed price
                    </button>
                    <button
                      type="button"
                      aria-pressed={mintMode === 'linear'}
                      onClick={() => setMintMode('linear')}
                    >
                      Linear step
                    </button>
                  </div>
                </div>
                <div className={styles.optionGroup}>
                  <span className={styles.fieldLabel}>Paid in</span>
                  <div className={`ui-seg ${styles.seg}`}>
                    <button
                      type="button"
                      aria-pressed={!payWithUru}
                      onClick={() => setPayWithUru(false)}
                      aria-label="Pay in ETH"
                    >
                      ETH
                    </button>
                    <button
                      type="button"
                      aria-pressed={payWithUru}
                      onClick={() => setPayWithUru(true)}
                      aria-label="Pay in URU"
                    >
                      URU
                    </button>
                  </div>
                </div>
              </div>

              <div className={mintMode === 'linear' ? styles.rowInputs : undefined}>
                <div className={mintMode === 'linear' ? styles.field : `${styles.field} ${styles.shortField}`}>
                  <label className={styles.fieldLabel} htmlFor="nft-price">
                    {mintMode === 'fixed' ? `Mint price (${priceUnit})` : `Starting price (${priceUnit})`}
                  </label>
                  <input
                    id="nft-price"
                    type="text"
                    inputMode="decimal"
                    className="ui-input"
                    data-mono="true"
                    value={basePriceEth}
                    onChange={(e) => setBasePriceEth(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0.005"
                  />
                </div>
                {mintMode === 'linear' && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="nft-step">Step per mint ({priceUnit})</label>
                    <input
                      id="nft-step"
                      type="text"
                      inputMode="decimal"
                      className="ui-input"
                      data-mono="true"
                      value={priceStepEth}
                      onChange={(e) => setPriceStepEth(e.target.value.replace(/[^\d.]/g, ''))}
                      placeholder="0.0001"
                    />
                  </div>
                )}
              </div>
              <p className={styles.fieldHint}>
                {mintMode === 'fixed'
                  ? `Every mint costs the same, paid in ${priceUnit}.`
                  : `The price goes up by the step after each mint, paid in ${priceUnit}.`}
              </p>
            </div>
          </section>

          {/* Whitelist */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelHeadText}>
                <h2 className={styles.panelTitle}>Whitelist</h2>
                <p className={styles.panelSub}>An early mint window for certain wallets</p>
              </div>
              <span className="ui-badge">Optional</span>
            </div>

            <div className={styles.panelBody}>
              {!NFT_WL_READY && (
                <p className={styles.fieldHint}>
                  Whitelist windows are coming soon. For now every collection opens to everyone at launch.
                </p>
              )}
              {NFT_WL_READY && (
                <div className={`ui-seg ${styles.seg}`}>
                  <button
                    type="button"
                    aria-pressed={wlFlavor === 'off'}
                    onClick={() => setWlFlavor('off')}
                  >
                    No whitelist
                  </button>
                  <button
                    type="button"
                    aria-pressed={wlFlavor === 'holders'}
                    onClick={() => setWlFlavor('holders')}
                  >
                    NFT holders
                  </button>
                  <button
                    type="button"
                    aria-pressed={wlFlavor === 'walletList'}
                    onClick={() => setWlFlavor('walletList')}
                  >
                    Wallet list
                  </button>
                </div>
              )}

              {NFT_WL_READY && wlFlavor === 'off' && (
                <p className={styles.fieldHint}>
                  Public mint from the start. Anyone can mint at the base price.
                </p>
              )}

              {wlFlavor === 'holders' && (
                <>
                  <div className={styles.rowInputs}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel} htmlFor="nft-wl-chain">Chain</label>
                      <select
                        id="nft-wl-chain"
                        className="ui-input"
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
                        Minimum held
                      </label>
                      <input
                        id="nft-wl-min"
                        type="text"
                        inputMode="numeric"
                        className="ui-input"
                        data-mono="true"
                        value={wlHoldersMin}
                        onChange={(e) => setWlHoldersMin(e.target.value.replace(/[^\d]/g, ''))}
                        placeholder="1"
                      />
                    </div>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="nft-wl-addr">
                      NFT collection address
                    </label>
                    <input
                      id="nft-wl-addr"
                      type="text"
                      className="ui-input"
                      data-mono="true"
                      value={wlHoldersAddress}
                      onChange={(e) => setWlHoldersAddress(e.target.value.trim())}
                      placeholder="0x…"
                    />
                    <p className={styles.fieldHint}>
                      Any wallet holding <b className={styles.mono}>{wlHoldersMin || 'N'}</b> or more
                      NFTs from this collection on {chainLabel(wlHoldersChain)} can mint during the
                      whitelist window.
                    </p>
                  </div>
                </>
              )}

              {wlFlavor === 'walletList' && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="nft-wl-list">
                    Wallet addresses
                  </label>
                  <textarea
                    id="nft-wl-list"
                    className={`ui-input ${styles.textareaMono}`}
                    value={wlWalletList}
                    onChange={(e) => setWlWalletList(e.target.value)}
                    placeholder={'0xabc…\n0xdef…\n0x123…'}
                    rows={6}
                  />
                  <p className={styles.fieldHint}>
                    Paste one address per line, or separate them with commas. We handle the proofs
                    behind the scenes. <b className={styles.mono}>{wlWalletCount}</b> valid
                    address{wlWalletCount === 1 ? '' : 'es'} found.
                  </p>
                </div>
              )}

              {wlFlavor !== 'off' && (
                <div className={`${styles.field} ${styles.tinyField}`}>
                  <label className={styles.fieldLabel} htmlFor="nft-wlwin">
                    Whitelist window (minutes)
                  </label>
                  <input
                    id="nft-wlwin"
                    type="text"
                    inputMode="numeric"
                    className="ui-input"
                    data-mono="true"
                    value={wlOpenWindowMin}
                    onChange={(e) => setWlOpenWindowMin(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="60"
                  />
                  <p className={styles.fieldHint}>
                    After the window closes, anyone can mint.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Discount tiers */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelHeadText}>
                <h2 className={styles.panelTitle}>Discount tiers</h2>
                <p className={styles.panelSub}>Discounts for a wallet list or for holders of another NFT</p>
              </div>
              <span className="ui-badge">Optional</span>
            </div>

            <div className={styles.panelBody}>
              <p className={styles.fieldHint}>
                Give a discount to specific wallets, or to anyone who holds another NFT (the more
                they hold, the bigger the discount).
              </p>

              {discountTiers.length > 0 && (
                <div className={styles.tierList}>
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
                            className={`ui-input ${styles.tierLabelInput}`}
                            placeholder="Tier label (for example, urufu gemu nft holders)"
                            value={tier.label}
                            onChange={(e) => update({ label: e.target.value })}
                          />
                          <button
                            type="button"
                            className="ui-btn"
                            data-variant="ghost"
                            data-size="sm"
                            onClick={() => setDiscountTiers(discountTiers.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        </div>
                        <div className={`ui-seg ${styles.seg}`} role="tablist" aria-label="Tier kind">
                          {NFT_WL_READY && (
                            <button
                              type="button"
                              aria-pressed={tier.kind === 'walletList'}
                              onClick={() => update({ kind: 'walletList' })}
                            >
                              Wallet list
                            </button>
                          )}
                          <button
                            type="button"
                            aria-pressed={tier.kind === 'externalNft'}
                            onClick={() => update({ kind: 'externalNft' })}
                          >
                            Holders of another NFT
                          </button>
                        </div>

                        {tier.kind === 'walletList' ? (
                          <div className={styles.tierBody}>
                            <textarea
                              className={`ui-input ${styles.textareaMono}`}
                              placeholder={'Paste wallet addresses, one per line\n0xabc…\n0xdef…'}
                              value={tier.walletList}
                              onChange={(e) => update({ walletList: e.target.value })}
                              rows={4}
                            />
                            <div className={styles.inlineRow}>
                              <span className={styles.inlineGroup}>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className="ui-input"
                                  data-mono="true"
                                  placeholder="20"
                                  value={tier.walletPercent}
                                  onChange={(e) => update({ walletPercent: e.target.value.replace(/[^\d]/g, '') })}
                                />
                                % off
                              </span>
                            </div>
                            <p className={styles.fieldHint}>
                              <b className={styles.mono}>{countValidWallets(tier.walletList)}</b> valid address
                              {countValidWallets(tier.walletList) === 1 ? '' : 'es'} found. Paste one per
                              line and we handle the rest.
                            </p>
                          </div>
                        ) : (
                          <div className={styles.tierBody}>
                            <div className={styles.tierFieldRow}>
                              <select
                                className={`ui-input ${styles.chainSelect}`}
                                value={tier.extNftChain}
                                onChange={(e) => update({ extNftChain: e.target.value as ExternalNftChain })}
                              >
                                {EXTERNAL_NFT_CHAINS.map((c) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </select>
                              <input
                                type="text"
                                className="ui-input"
                                data-mono="true"
                                placeholder="NFT contract address (0x…)"
                                value={tier.extNftAddress}
                                onChange={(e) => update({ extNftAddress: e.target.value.trim() })}
                              />
                            </div>
                            <div className={styles.inlineRow}>
                              <span className={styles.inlineGroup}>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className="ui-input"
                                  data-mono="true"
                                  placeholder="5"
                                  value={tier.extNftPercentPerNft}
                                  onChange={(e) => update({ extNftPercentPerNft: e.target.value.replace(/[^\d]/g, '') })}
                                />
                                % off per NFT they own
                              </span>
                              <span className={styles.inlineGroup}>
                                up to
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className="ui-input"
                                  data-mono="true"
                                  placeholder="10"
                                  value={tier.extNftCap}
                                  onChange={(e) => update({ extNftCap: e.target.value.replace(/[^\d]/g, '') })}
                                />
                                NFTs
                              </span>
                            </div>
                            <p className={styles.fieldHint}>
                              Example: <span className={styles.mono}>{tier.extNftPercentPerNft || 5}% × {tier.extNftCap || 10}</span> NFTs
                              owned = <b className={styles.mono}>{Number(tier.extNftPercentPerNft || 5) * Number(tier.extNftCap || 10)}%</b> off
                              at most. We check their wallet on {chainLabel(tier.extNftChain)} when they mint.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className={styles.addTierRow}>
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() => setDiscountTiers([...discountTiers, newDiscountTier()])}
                >
                  + Add tier
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Right rail: preview + CTA */}
        <aside className={styles.launchRail}>
          <div className={styles.preview}>
            <div className={styles.previewHead}>
              <h2 className={styles.previewHeadTitle}>Preview</h2>
              <span className="ui-badge" data-tone="accent">NFT collection</span>
            </div>
            <div
              className={styles.previewArt}
              style={coverDataUrl ? { backgroundImage: `url(${coverDataUrl})` } : undefined}
            >
              {!coverDataUrl && <span className={styles.previewArtEmpty}>{previewTitle}</span>}
            </div>
            <div className={styles.previewBody}>
              <p className={styles.previewTicker}>{previewTicker}</p>
              <p className={styles.previewName}>{previewTitle}</p>
              <dl className={styles.previewList}>
                <dt>Chain</dt><dd>{chainName}</dd>
                <dt>Pricing</dt><dd>{mintMode === 'fixed' ? 'Fixed price' : 'Linear step'}</dd>
                <dt>Paid in</dt><dd>{priceUnitLabel}</dd>
                <dt>Price</dt><dd className={styles.mono}>{priceLabel}</dd>
                <dt>Supply</dt><dd className={styles.mono}>{previewSupply}</dd>
                {wlFlavor === 'holders' && (
                  <>
                    <dt>Whitelist</dt>
                    <dd>Hold {wlHoldersMin || 1}+ on {chainLabel(wlHoldersChain)}</dd>
                    <dt>Window</dt>
                    <dd className={styles.mono}>{wlOpenWindowMin || 60} min</dd>
                  </>
                )}
                {wlFlavor === 'walletList' && (
                  <>
                    <dt>Whitelist</dt>
                    <dd className={styles.mono}>{wlWalletCount} wallets</dd>
                    <dt>Window</dt>
                    <dd className={styles.mono}>{wlOpenWindowMin || 60} min</dd>
                  </>
                )}
                {discountTiers.length > 0 && (
                  <><dt>Discount tiers</dt><dd className={styles.mono}>{discountTiers.length}</dd></>
                )}
              </dl>
            </div>
          </div>

          <div className={styles.launchCta}>
            {requiredUruFee > 0n && (
              <div className={styles.feeRow}>
                <span>Launch fee</span>
                <b>{feeText}</b>
              </div>
            )}
            {needsUruApprove && !isApproved && (
              <button
                type="button"
                className="ui-btn"
                data-variant="ink"
                data-size="lg"
                data-block="true"
                disabled={isApproving || isWaitingApprove}
                onClick={approveUru}
              >
                {isWaitingApprove
                  ? 'Waiting for approval…'
                  : isApproving
                    ? 'Approving URU…'
                    : `Approve ${feeText}`}
              </button>
            )}
            <button
              type="button"
              className="ui-btn"
              data-variant={canSubmit && !needsUruApprove && !isSubmitting && !isWaitingReceipt ? 'primary' : undefined}
              data-size="lg"
              data-block="true"
              // A failed fee read used to leave the fee at 0 and let launch through.
              disabled={!canSubmit || !feeLoaded || needsUruApprove || isSubmitting || isWaitingReceipt || isLaunched || savingLists || isSwitching}
              onClick={() => void submit()}
            >
              {isLaunched
                ? 'Launched'
                : isWaitingReceipt
                  ? 'Waiting for confirmation…'
                  : savingLists
                    ? 'Saving wallet list…'
                    : isSubmitting
                    ? 'Confirm in your wallet…'
                    : canSubmit
                      ? 'Launch collection'
                      : 'Launch collection'}
            </button>
            {requiredUruFee > 0n && needsUruApprove && !isApproved && (
              <p className={styles.reasonNote}>
                Approve the URU launch fee first, then launch.
              </p>
            )}
            {listError && (
              <p className={styles.errorNote} role="alert">
                {listError}
              </p>
            )}
            {submitError && (
              <p className={styles.errorNote} role="alert">
                {submitError.message.split('\n')[0]}
              </p>
            )}
            {isLaunched && receipt && (
              <p className={styles.successNote} role="status">
                Confirmed in block <span className={styles.mono}>{receipt.blockNumber.toString()}</span>{' '}
                (tx <span className={styles.mono}>{receipt.transactionHash.slice(0, 10)}…</span>).
                {launchedCollection ? (
                  <>
                    {' '}Opening{' '}
                    <Link href={`/collection/${launchedCollection}`}>
                      the mint page
                    </Link>
                    …
                  </>
                ) : (
                  <> Your collection is live, but we couldn&apos;t read its address from the receipt. Find it on the Discover page.</>
                )}
              </p>
            )}
            {disabledReason && !isSubmitting && !isWaitingReceipt && !isLaunched && (
              <p className={styles.reasonNote}>{disabledReason}</p>
            )}
            <Link href="/create" className={styles.altLink}>
              Or launch an ERC-20 token
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
