'use client';

/// Per-collection page.
///
/// Reads live state from the ERC-721 clone + its NftMintModule (found by
/// reading the ERC-721's `minter()` — which returns the mint module (per the
/// construction post-launch). Renders price + supply + mint controls.
///
/// URL: /collection/[address]  (address = the ERC-721 collection).
///
/// The mint UI dispatches between `mint()` and `mintWithUru()` based on
/// the module's `paymentToken` field. URU-mode adds an allowance step
/// before the mint tx.

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatUnits, isAddress, maxUint256, zeroAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { NFT_LAUNCHES_ENABLED, DN404_PAIR_CURRENCIES, type ChainKey } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { CHAIN_KEY_TO_ID, explorerAddressUrl } from '@/lib/wagmi';
import { nftErc721Abi, nftMintModuleAbi } from '@/lib/abis';
import { useDiscountTiers, TierKind } from '@/lib/useDiscountTiers';
import {
  fetchNftCollectionsByAddresses,
  fetchNftMintsByCollection,
  type IndexerNftCollection,
  type IndexerNftMint,
} from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { fetchNftHolders, type NftHolder } from '@/lib/nftHoldersApi';
import styles from './collection.module.css';

// Solady Ownable — the ERC-721 clone inherits it; `owner()` returns the
// mint module post-`transferOwnership`. Kept inline because we don't
// pull in Solady's full ABI just for one function.
/// The ERC-721 template's `minter()` returns the mint module (V5 two-role
/// model: owner=launcher, minter=mintModule). Older V1-V4 collections used
/// `owner()` for this role — they're on the hidden list and don't render
/// through this page anymore.
const nftErc721MinterAbi = [
  {
    type: 'function',
    name: 'minter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const erc20MinAbi = [
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
] as const;

export default function CollectionPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return <CollectionRoute params={params} />;
}

function CollectionRoute({ params }: { params: Promise<{ address: string }> }) {
  const resolved = use(params);
  const activeChain = useActiveChain();
  const chainEnabled = NFT_LAUNCHES_ENABLED[activeChain] === true;

  if (!isAddress(resolved.address)) {
    return (
      <div className={styles.page}>
        <div className={styles.notFound}>
          <Mascot size={72} mood="sleepy" />
          <div className="uru-h1" style={{ fontSize: 22 }}>
            that&apos;s not a valid collection address ~
          </div>
          <p style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13, opacity: 0.75 }}>
            try browsing <Link href="/discover" style={{ textDecoration: 'underline', color: 'var(--pink-hot)' }}>launches</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <CollectionView
      address={resolved.address as Address}
      chainEnabled={chainEnabled}
      chainKey={activeChain}
    />
  );
}

function CollectionView({
  address,
  chainEnabled,
  chainKey,
}: {
  address: Address;
  chainEnabled: boolean;
  chainKey: ChainKey;
}) {
  const { address: walletAddress, chainId: walletChainId } = useAccount();
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;
  // Every read and write is pinned to the collection's chain. Unpinned reads
  // follow the wallet's network, so a wallet on another chain saw
  // "collection not found" (2026-10-08).
  const targetChainId = CHAIN_KEY_TO_ID[chainKey];
  const onTargetChain = walletChainId === targetChainId;
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();

  // ------------------------------------------------------------
  // 1. Read the ERC-721 basics + find its mint module (== minter()).
  // ------------------------------------------------------------
  const { data: baseReads, isPending: baseReadsPending, isError: baseReadsError, refetch: refetchBase } = useReadContracts({
    contracts: [
      { address, abi: nftErc721Abi, functionName: 'name', chainId: targetChainId },
      { address, abi: nftErc721Abi, functionName: 'symbol', chainId: targetChainId },
      { address, abi: nftErc721Abi, functionName: 'baseURI', chainId: targetChainId },
      { address, abi: nftErc721Abi, functionName: 'totalMinted', chainId: targetChainId },
      { address, abi: nftErc721Abi, functionName: 'maxSupply', chainId: targetChainId },
      { address, abi: nftErc721MinterAbi, functionName: 'minter', chainId: targetChainId },
      // Launcher-only collection-metadata control below reads these two.
      { address, abi: nftErc721Abi, functionName: 'owner', chainId: targetChainId },
      { address, abi: nftErc721Abi, functionName: 'contractURI', chainId: targetChainId },
    ],
    query: { staleTime: 10_000 },
  });

  const name = baseReads?.[0]?.result as string | undefined;
  const symbol = baseReads?.[1]?.result as string | undefined;
  const baseUri = baseReads?.[2]?.result as string | undefined;
  const totalMinted = baseReads?.[3]?.result as bigint | undefined;
  const maxSupply = baseReads?.[4]?.result as bigint | undefined;
  const mintModule = baseReads?.[5]?.result as Address | undefined;
  const hasMintModule = mintModule && mintModule !== zeroAddress;
  // "Not found" only when the minter() read came back and was empty. While
  // loading, or when the RPC call failed, say so instead.
  const minterRead = baseReads?.[5];
  const minterMissing = minterRead?.status === 'success' && !hasMintModule;
  const minterReadFailed = baseReadsError || minterRead?.status === 'failure';
  const collectionOwner = baseReads?.[6]?.result as Address | undefined;
  const onChainContractUri = (baseReads?.[7]?.result as string | undefined) ?? '';
  const isLauncher =
    !!walletAddress && !!collectionOwner && walletAddress.toLowerCase() === collectionOwner.toLowerCase();

  // ------------------------------------------------------------
  // Launcher-only: set collection-level metadata (contractURI). OpenSea
  // reads this for the collection PAGE (banner, description) — separate
  // from per-token tokenURI. The NFT-lane LaunchParams has no slot for
  // it, so every collection launches with it empty; this is the only way
  // it gets populated. The studio publishes `collection.json` next to the
  // per-token files, so the natural value is `<baseURI>collection.json`.
  // ------------------------------------------------------------
  const [contractUriDraft, setContractUriDraft] = useState('');
  const {
    writeContract: writeContractUri,
    data: contractUriTxHash,
    isPending: isSettingContractUri,
    error: contractUriError,
  } = useWriteContract();
  const { isLoading: isWaitingContractUri, isSuccess: contractUriSet } =
    useWaitForTransactionReceipt({ hash: contractUriTxHash });
  const suggestedContractUri = baseUri ? `${baseUri}collection.json` : '';
  const contractUriDraftOk =
    contractUriDraft.startsWith('ipfs://') ||
    contractUriDraft.startsWith('ar://') ||
    contractUriDraft.startsWith('https://');
  const doSetContractUri = async () => {
    if (!isLauncher || !contractUriDraftOk) return;
    if (!(await ensureChain())) return;
    writeContractUri({
      address,
      abi: nftErc721Abi,
      functionName: 'setContractURI',
      args: [contractUriDraft.trim()],
      chainId: targetChainId,
    });
  };

  /// Ask the wallet to switch to the collection's chain before a write.
  async function ensureChain(): Promise<boolean> {
    if (onTargetChain) return true;
    try {
      await switchChainAsync({ chainId: targetChainId });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------
  // 1b. Indexer-side collection metadata — cover image, description,
  //     contractURI. Preferred over client-side IPFS fetches because
  //     the indexer resolves once server-side and serves warm.
  // ------------------------------------------------------------
  const [indexerRow, setIndexerRow] = useState<IndexerNftCollection | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchNftCollectionsByAddresses([address as Address]);
      if (cancelled) return;
      const forChain = (rows ?? []).find(
        (r) => r.chainId === targetChainId && r.collectionAddress.toLowerCase() === address.toLowerCase(),
      );
      setIndexerRow(forChain ?? null);
    })();
    return () => { cancelled = true; };
  }, [address, targetChainId]);

  // Cover art — prefer indexer-resolved URL, fall back to client-side
  // tokenURI(1) → metadata JSON → image resolve when the indexer
  // hasn't populated the field yet (fresh launch, backfill in flight).
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    if (indexerRow?.coverImageUrl) { setCover(toGatewayUrl(indexerRow.coverImageUrl)); return; }
    if (!baseUri) return;
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(`${baseUri}1`);
      if (!cancelled) setCover(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [indexerRow?.coverImageUrl, baseUri]);

  // ------------------------------------------------------------
  // 1b'. Holders — current owners via compile-service /nft/.../holders.
  //      Refetches when totalMinted advances so live-mint activity moves
  //      the list within a minute.
  // ------------------------------------------------------------
  const [holders, setHolders] = useState<NftHolder[] | null>(null);
  useEffect(() => {
    if (chainKey !== 'robinhood') { setHolders([]); return; }
    let cancelled = false;
    (async () => {
      const scan = await fetchNftHolders(chainKey, address, { limit: 100 });
      if (cancelled) return;
      setHolders(scan?.holders ?? []);
    })();
    return () => { cancelled = true; };
  }, [address, chainKey, totalMinted]);

  // ------------------------------------------------------------
  // 1c. Recent mints feed for this collection.
  // ------------------------------------------------------------
  const [recentMints, setRecentMints] = useState<IndexerNftMint[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchNftMintsByCollection(address as Address, 20);
      if (cancelled) return;
      setRecentMints(rows ?? []);
    })();
    return () => { cancelled = true; };
    // Refetch when totalMinted advances so a live mint appears in the feed
    // shortly after it lands (indexer lag is a few seconds).
  }, [address, totalMinted]);

  // ------------------------------------------------------------
  // 2. Read mint-module state. Only fires once we've located the module.
  // ------------------------------------------------------------
  const { data: moduleReads } = useReadContracts({
    contracts: hasMintModule
      ? [
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'paymentToken', chainId: targetChainId },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'basePriceWei', chainId: targetChainId },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'priceStepWei', chainId: targetChainId },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'mintMode', chainId: targetChainId },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'discountFloorBps', chainId: targetChainId },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'perWalletMintCap', chainId: targetChainId },
        ]
      : [],
    query: { enabled: hasMintModule, staleTime: 10_000 },
  });

  const paymentToken = moduleReads?.[0]?.result as Address | undefined;
  // _basePriceWei / _priceStepWei: read for the marketplace-panel /
  // discount-preview widgets. The rendered price uses `grossPriceFor`
  // (accounts for qty and linear-step math server-side) instead of
  // deriving locally, but the raw slots are batched here so future
  // consumers don't re-fetch.
  const _basePriceWei = moduleReads?.[1]?.result as bigint | undefined;
  const _priceStepWei = moduleReads?.[2]?.result as bigint | undefined;
  const mintMode = moduleReads?.[3]?.result as number | undefined;    // 0 = fixed, 1 = linear
  const discountFloorBps = moduleReads?.[4]?.result as bigint | undefined;

  const paidInUru = paymentToken !== undefined && paymentToken !== zeroAddress;
  const priceUnitLabel = paidInUru ? 'URU' : 'ETH';

  const [mintQty, setMintQty] = useState(1);

  // ------------------------------------------------------------
  // 3. Live price quote from the mint module. Includes linear-step
  //    pricing, no discount applied (discount tiers require proofs).
  // ------------------------------------------------------------
  const { data: quotedWei } = useReadContract({
    address: mintModule as Address | undefined,
    abi: nftMintModuleAbi,
    functionName: 'grossPriceFor',
    args: [BigInt(mintQty)],
    chainId: targetChainId,
    query: { enabled: hasMintModule && mintQty > 0, staleTime: 5_000 },
  });
  const grossPrice = (quotedWei as bigint | undefined) ?? 0n;

  // ------------------------------------------------------------
  // 3b. Discount tiers — read every tier the mint module exposes, fetch
  //     attestations for ExternalNft tiers the wallet qualifies for,
  //     then quote the net price with the sum of tier discounts applied.
  //     Wallet-list tiers aren't wired to the merkle-lookup service yet
  //     (post-launch slice); ExternalNft is the flow that ships now.
  // ------------------------------------------------------------
  const {
    tiers,
    externalProofs,
    fetchingAttestations,
    attestationErrors,
    claimedDiscountBps,
  } = useDiscountTiers(mintModule as Address | undefined, address, targetChainId);

  const { data: netPriceQuoted } = useReadContract({
    address: mintModule as Address | undefined,
    abi: nftMintModuleAbi,
    functionName: 'netPriceFor',
    args: [BigInt(mintQty), claimedDiscountBps],
    chainId: targetChainId,
    query: {
      enabled: hasMintModule && mintQty > 0 && claimedDiscountBps > 0n,
      staleTime: 5_000,
    },
  });
  const price =
    claimedDiscountBps > 0n && netPriceQuoted !== undefined
      ? (netPriceQuoted as bigint)
      : grossPrice;
  const priceDisplay = price > 0n ? formatUnits(price, 18) : '—';
  const savings = grossPrice > price ? grossPrice - price : 0n;
  const savingsDisplay = savings > 0n ? formatUnits(savings, 18) : null;

  // ------------------------------------------------------------
  // 4. URU allowance (only relevant when paidInUru).
  // ------------------------------------------------------------
  const { data: uruAllowance, refetch: refetchAllowance } = useReadContract({
    address: paidInUru ? (paymentToken as Address) : undefined,
    abi: erc20MinAbi,
    functionName: 'allowance',
    args: walletAddress && mintModule ? [walletAddress, mintModule as Address] : undefined,
    chainId: targetChainId,
    query: {
      enabled: paidInUru && !!walletAddress && !!mintModule,
      staleTime: 10_000,
    },
  });
  // ------------------------------------------------------------
  // 5. Write hooks — approve + mint (branches on payment token)
  // ------------------------------------------------------------
  const {
    writeContract: writeApprove,
    data: approveTxHash,
    isPending: isApproving,
    reset: resetApprove,
  } = useWriteContract();
  const { isLoading: isWaitingApprove, isSuccess: isApproved } =
    useWaitForTransactionReceipt({ hash: approveTxHash, chainId: targetChainId });
  // Amount the confirmed approve tx covered, so the mint button unlocks the
  // moment it lands instead of waiting on the allowance re-read.
  const [approvedAmount, setApprovedAmount] = useState(0n);
  // Approving the exact price meant every mint asked for a new approval.
  // Default to one approval for all mints of this collection: the mint module
  // only pulls URU from the minting wallet, and only the price of that mint
  // (NftMintModule.mintWithUru). Buyers can still pick a one-mint approval.
  const [approveOnce, setApproveOnce] = useState(true);

  // The allowance read is cached, so it never saw the new approval and the
  // mint button stayed locked until a page refresh. Re-read on confirm.
  useEffect(() => {
    if (isApproved) void refetchAllowance();
  }, [isApproved, refetchAllowance]);

  const needsUruApprove =
    paidInUru && (uruAllowance ?? 0n) < price && !(isApproved && approvedAmount >= price);

  const {
    writeContract: writeMint,
    data: mintTxHash,
    isPending: isMinting,
    error: mintError,
    reset: resetMint,
  } = useWriteContract();
  const { isLoading: isWaitingMint, isSuccess: isMinted, data: mintReceipt } =
    useWaitForTransactionReceipt({ hash: mintTxHash, chainId: targetChainId });

  // After a mint lands, refresh supply (which also refreshes holders and the
  // mint feed) and the allowance the mint just spent.
  useEffect(() => {
    if (!isMinted) return;
    void refetchBase();
    if (paidInUru) {
      // The mint spent the approval, so the next mint needs a fresh one.
      resetApprove();
      setApprovedAmount(0n);
      void refetchAllowance();
    }
  }, [isMinted, paidInUru, refetchBase, refetchAllowance, resetApprove]);

  // Clear write state when the buyer changes qty so stale "minted" flags
  // don't confuse the CTA.
  useEffect(() => {
    resetMint();
    resetApprove();
  }, [mintQty, resetMint, resetApprove]);

  const doApprove = async () => {
    if (!paidInUru || !paymentToken || !mintModule) return;
    if (!(await ensureChain())) return;
    const amount = approveOnce ? maxUint256 : price;
    setApprovedAmount(amount);
    writeApprove({
      address: paymentToken as Address,
      abi: erc20MinAbi,
      functionName: 'approve',
      args: [mintModule as Address, amount],
      chainId: targetChainId,
    });
  };

  const doMint = async () => {
    if (!hasMintModule || !mintModule) return;
    if (!(await ensureChain())) return;
    // Discount proofs — ExternalNft tiers only for now; each proof was
    // signed by compile-service for THIS wallet + collection, so the
    // on-chain verifier accepts them one-shot. WalletList tiers pass
    // through empty until the merkle-lookup service ships.
    const discountProofs = externalProofs.map((p) => ({
      tierId: p.tierId,
      merkleProof: p.merkleProof,
      count: p.count,
      expiry: p.expiry,
      sig: p.sig,
    }));
    if (paidInUru) {
      writeMint({
        address: mintModule as Address,
        abi: nftMintModuleAbi,
        functionName: 'mintWithUru',
        args: [
          BigInt(mintQty),
          price,
          [] as `0x${string}`[],
          0n,
          0n,
          '0x' as `0x${string}`,
          discountProofs,
        ],
        chainId: targetChainId,
      });
    } else {
      writeMint({
        address: mintModule as Address,
        abi: nftMintModuleAbi,
        functionName: 'mint',
        args: [
          BigInt(mintQty),
          [] as `0x${string}`[],
          0n,
          0n,
          '0x' as `0x${string}`,
          discountProofs,
        ],
        value: price,
        chainId: targetChainId,
      });
    }
  };

  // ------------------------------------------------------------
  // 6. Cover art — resolve from baseURI/0 metadata if the collection
  //    publishes it. For phase-1 we render the placeholder until the
  //    metadata-fetch worker is added; the frontend does not fetch
  //    IPFS on this render pass to keep TTFB fast.
  // ------------------------------------------------------------
  const supplyLabel = maxSupply !== undefined && totalMinted !== undefined
    ? `${totalMinted.toString()}/${maxSupply === 0n ? '∞' : maxSupply.toString()}`
    : '—/—';

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Mascot size={44} mood="happy" />
        <h1 className={styles.heroTitle}>
          {name ? `❁ ${name}` : '❁ collection'}
        </h1>
        {symbol && (
          <span className="uru-stamp uru-stamp-cream" style={{ transform: 'rotate(-2deg)' }}>
            {symbol}
          </span>
        )}
        <a
          className={styles.addressChip}
          href={explorerAddressUrl(chainKey, address)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddr} ↗
        </a>
      </header>

      {indexerRow?.description && (
        <p
          style={{
            maxWidth: 480,
            margin: '0 auto 16px',
            padding: '0 12px',
            textAlign: 'center',
            fontSize: 13,
            lineHeight: 1.4,
            color: 'var(--anchor-soft)',
          }}
        >
          {indexerRow.description}
        </p>
      )}

      {!chainEnabled && (
        <div className={styles.warnPane}>
          <b>nft collections aren&apos;t live on this chain yet.</b> switch to robinhood to preview.
        </div>
      )}

      {chainEnabled && minterMissing && (
        <div className={styles.warnPane}>
          <b>collection not found.</b> either not launched via the launchpad, or the mint module
          hasn&apos;t been assigned yet.
        </div>
      )}
      {chainEnabled && !hasMintModule && !minterMissing && minterReadFailed && !baseReadsPending && (
        <div className={styles.warnPane}>
          <b>couldn&apos;t load this collection.</b> the network is busy, give it a moment.{' '}
          <button type="button" className="uru-chip" onClick={() => void refetchBase()}>
            try again
          </button>
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          <section className={styles.artShell}>
            <span className={`uru-stamp uru-stamp-pink ${styles.artStamp}`} aria-hidden="true">
              new ✿
            </span>
            {/* Cover art: indexer-resolved cover first, tokenURI(1) as the
                fallback. The pastel gradient + name only shows until art loads.
                `contain` so the whole image shows, never cropped. */}
            <div
              className={styles.artFrame}
              role={cover ? 'img' : undefined}
              aria-label={cover ? `${name ?? 'collection'} cover art` : undefined}
              style={cover ? {
                background: `var(--cream-deep) center/contain no-repeat url("${encodeURI(cover).replace(/"/g, '%22')}")`,
              } : undefined}
            >
              {!cover && <span>{name ?? 'cover art pending'}</span>}
            </div>
          </section>

          {indexerRow?.lane === 'dn404' && indexerRow.pairedToken && indexerRow.pairedToken !== '0x0000000000000000000000000000000000000000' && (() => {
            const pairAddr = indexerRow.pairCurrency ?? '0x0000000000000000000000000000000000000000';
            const pairLabel = pairAddr === '0x0000000000000000000000000000000000000000'
              ? 'ETH'
              : (DN404_PAIR_CURRENCIES[chainKey] ?? [])
                  .find((o) => o.address.toLowerCase() === pairAddr.toLowerCase())?.label
                ?? 'ERC-20';
            return (
              <section
                className="uru-shell-tight"
                style={{ marginBottom: 10, background: 'var(--cream)' }}
              >
                <div className="uru-eyebrow" style={{ marginBottom: 4 }}>✧ dn404 pair · priced in {pairLabel}</div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 10.5,
                  }}
                >
                  <span style={{ color: 'var(--anchor-soft)' }}>
                    hold{' '}
                    <b style={{ color: 'var(--anchor)' }}>
                      {indexerRow.unitWei && indexerRow.unitWei !== '0'
                        ? (BigInt(indexerRow.unitWei) / 10n ** 18n).toString()
                        : '?'}
                    </b>
                    {' '}${indexerRow.ticker || 'TICK'} to hold 1 art piece
                  </span>
                  <Link
                    href={`/trade/${indexerRow.pairedToken}`}
                    className="uru-chip"
                    style={{ padding: '2px 8px', fontSize: 10, textDecoration: 'none' }}
                  >
                    trade ${indexerRow.ticker || 'TICK'} →
                  </Link>
                </div>
              </section>
            );
          })()}

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">♡ holders</span>
              <span className={styles.sectionEye}>
                {holders && holders.length > 0 ? `${holders.length} wallets` : `who's in the collection`}
              </span>
            </div>
            {holders === null ? (
              <div className={styles.emptyRow}>loading holders…</div>
            ) : holders.length === 0 ? (
              <div className={styles.emptyRow}>no holders yet ~ mint first</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
                {holders.slice(0, 20).map((h) => (
                  <li
                    key={h.address}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 10,
                      alignItems: 'center',
                      padding: '4px 8px',
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 11,
                    }}
                  >
                    <a
                      href={explorerAddressUrl(chainKey, h.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'var(--anchor)',
                        textDecoration: 'none',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h.address.slice(0, 6)}··{h.address.slice(-4)}
                    </a>
                    <span style={{ color: 'var(--pink-hot)' }}>x{h.balance}</span>
                  </li>
                ))}
                {holders.length > 20 && (
                  <li style={{ padding: '4px 8px', fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)', textAlign: 'center' }}>
                    + {holders.length - 20} more
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❉ recent mints</span>
              <span className={styles.sectionEye}>the live mint feed</span>
            </div>
            {recentMints === null ? (
              <div className={styles.emptyRow}>loading mints…</div>
            ) : recentMints.length === 0 ? (
              <div className={styles.emptyRow}>no mints yet ~ be the first</div>
            ) : (
              // Tiles big enough to actually see each minted piece.
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                  gap: 10,
                }}
              >
                {recentMints.map((m) => (
                  <li
                    key={m.id}
                    style={{
                      display: 'grid',
                      gap: 4,
                      minWidth: 0,
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 11,
                    }}
                  >
                    <MintThumb baseUri={baseUri} tokenId={firstMintedId(m)} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ color: 'var(--pink-hot)' }}>{mintedIdsLabel(m)}</span>
                      <span style={{ color: 'var(--anchor-soft)', fontSize: 9 }}>
                        {new Date(Number(m.blockTimestamp) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <a
                      href={explorerAddressUrl(chainKey, m.minter)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--anchor)',
                        textDecoration: 'none',
                        fontSize: 10,
                      }}
                    >
                      {m.minter.slice(0, 6)}··{m.minter.slice(-4)}
                      {m.wlUsed ? <span style={{ color: 'var(--anchor-soft)' }}> · wl</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className={styles.rail}>
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✦ mint</span>
              <span className={styles.sectionEye}>{chainKey}</span>
            </div>

            <div className={styles.mintPanel}>
              <dl className={styles.statRow}>
                <dt>pay</dt>
                <dd>{hasMintModule ? priceUnitLabel : <span style={{ opacity: 0.5 }}>—</span>}</dd>
                <dt>mode</dt>
                <dd>
                  {mintMode === undefined ? (
                    <span style={{ opacity: 0.5 }}>—</span>
                  ) : mintMode === 0 ? (
                    'fixed'
                  ) : (
                    'linear step'
                  )}
                </dd>
                <dt>price</dt>
                <dd>
                  {hasMintModule && price > 0n ? (
                    `${priceDisplay} ${priceUnitLabel}`
                  ) : (
                    <span style={{ opacity: 0.5 }}>pending ~</span>
                  )}
                </dd>
                <dt>supply</dt>
                <dd>{supplyLabel}</dd>
                {discountFloorBps !== undefined && discountFloorBps < 10_000n && (
                  <>
                    <dt>floor</dt>
                    <dd>{Number(discountFloorBps) / 100}% min</dd>
                  </>
                )}
                {claimedDiscountBps > 0n && (
                  <>
                    <dt>tier discount</dt>
                    <dd>
                      −{(Number(claimedDiscountBps) / 100).toFixed(2)}%
                      {savingsDisplay && (
                        <span style={{ opacity: 0.75, marginLeft: 6 }}>
                          (saves {savingsDisplay} {priceUnitLabel})
                        </span>
                      )}
                    </dd>
                  </>
                )}
              </dl>

              {tiers.some((t) => t.kind === TierKind.ExternalNft) && (
                <p
                  style={{
                    fontSize: 12,
                    opacity: 0.8,
                    margin: '4px 0 8px',
                  }}
                >
                  {fetchingAttestations
                    ? '~ checking your external NFT holdings ~'
                    : externalProofs.length > 0
                      ? `✿ discount applied for ${externalProofs.length} tier${externalProofs.length === 1 ? '' : 's'}`
                      : Object.keys(attestationErrors).length > 0
                        ? '⚠ discount check failed — mint proceeds at full price'
                        : walletAddress
                          ? 'no external NFTs held → no tier discount'
                          : 'connect wallet to check ExternalNft-tier discounts'}
                </p>
              )}

              <div className={styles.qtyRow}>
                <span className={styles.qtyLabel}>qty</span>
                <div className={styles.qtyControls}>
                  <button
                    type="button"
                    className={styles.qtyBtn}
                    onClick={() => setMintQty(Math.max(1, mintQty - 1))}
                    aria-label="Decrease quantity"
                  >
                    −
                  </button>
                  <span className={styles.qtyNum}>{mintQty}</span>
                  <button
                    type="button"
                    className={styles.qtyBtn}
                    onClick={() => setMintQty(Math.min(20, mintQty + 1))}
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
              </div>

              {needsUruApprove && !isApproved && (
                <button
                  type="button"
                  className="uru-btn uru-btn-mint"
                  disabled={isApproving || isWaitingApprove || isSwitching || !walletAddress}
                  onClick={doApprove}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {isWaitingApprove
                    ? 'waiting for approval ~'
                    : isApproving
                      ? 'approving URU ~'
                      : approveOnce
                        ? '✿ approve URU (one time)'
                        : `✿ approve ${priceDisplay} URU`}
                </button>
              )}
              {needsUruApprove && !isApproved && (
                <label
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'flex-start',
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: 'var(--anchor-soft)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={approveOnce}
                    onChange={(e) => setApproveOnce(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    approve once for all mints here. you&apos;re only charged the mint price when you mint.
                    untick to approve just this mint.
                  </span>
                </label>
              )}

              <button
                type="button"
                className={`uru-btn ${hasMintModule && !needsUruApprove ? 'uru-btn-primary' : ''}`}
                disabled={
                  !hasMintModule ||
                  needsUruApprove ||
                  isMinting ||
                  isWaitingMint ||
                  isSwitching ||
                  !walletAddress
                }
                onClick={doMint}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {isMinted
                  ? `✿ minted ✓ · mint ${mintQty} more`
                  : isWaitingMint
                    ? 'waiting for receipt ~'
                    : isMinting
                      ? 'confirming in wallet ~'
                      : hasMintModule
                        ? `❁ mint ${mintQty}`
                        : '❁ mint (soon)'}
              </button>

              {mintError && (
                <p style={{
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 11,
                  color: 'var(--pink-hot)',
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}>
                  {mintError.message.split('\n')[0]}
                </p>
              )}
              {isMinted && mintReceipt && (
                <p style={{
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 11,
                  color: 'var(--anchor)',
                  opacity: 0.75,
                  textAlign: 'center',
                }}>
                  tx {mintReceipt.transactionHash.slice(0, 10)}… mined
                </p>
              )}

              {isLauncher && (
                <div
                  className="uru-shell-tight"
                  style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  <div className="uru-eyebrow">❁ collection metadata (launcher only)</div>
                  <p style={{ fontSize: 11, opacity: 0.8, margin: 0, lineHeight: 1.45 }}>
                    {onChainContractUri
                      ? <>set to <span className="uru-num">{onChainContractUri}</span></>
                      : <>not set. OpenSea shows no banner or description for this collection until it is.</>}
                  </p>
                  <input
                    type="text"
                    className="uru-input"
                    value={contractUriDraft}
                    onChange={(e) => setContractUriDraft(e.target.value)}
                    placeholder={suggestedContractUri || 'ipfs://.../collection.json'}
                    aria-label="collection metadata URI"
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {suggestedContractUri && contractUriDraft !== suggestedContractUri && (
                      <button
                        type="button"
                        className="uru-chip"
                        onClick={() => setContractUriDraft(suggestedContractUri)}
                        title="the studio publishes collection.json next to the per-token files"
                      >
                        use {'<baseURI>'}collection.json
                      </button>
                    )}
                    <button
                      type="button"
                      className="uru-btn"
                      disabled={!contractUriDraftOk || isSettingContractUri || isWaitingContractUri}
                      onClick={doSetContractUri}
                    >
                      {contractUriSet
                        ? '✓ saved'
                        : isWaitingContractUri
                          ? 'waiting for receipt ~'
                          : isSettingContractUri
                            ? 'confirming in wallet ~'
                            : 'save'}
                    </button>
                  </div>
                  {contractUriError && (
                    <p style={{ fontSize: 11, color: 'var(--pink-hot)', margin: 0 }}>
                      {contractUriError.message.split('\n')[0]}
                    </p>
                  )}
                </div>
              )}
              {!walletAddress && (
                <p style={{
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 11,
                  color: 'var(--anchor)',
                  opacity: 0.7,
                  textAlign: 'center',
                }}>
                  connect a wallet to mint
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// The mint module's Minted event carries totalMinted() from before the mint,
// but collections number tokens from 1 (ERC721ATemplate._startTokenId), so the
// first new token is that value + 1.
function firstMintedId(m: IndexerNftMint): bigint {
  return BigInt(m.tokenId) + 1n;
}

function mintedIdsLabel(m: IndexerNftMint): string {
  const first = firstMintedId(m);
  return m.quantity > 1 ? `#${first}-${first + BigInt(m.quantity - 1)}` : `#${first}`;
}

/// Square tile of a minted NFT that fills its grid cell: tokenURI JSON ->
/// image, through our /api/ipfs route. Plain tile until (or unless) the art loads.
function MintThumb({ baseUri, tokenId }: { baseUri: string | undefined; tokenId: bigint }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!baseUri) return;
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(`${baseUri}${tokenId}`);
      if (!cancelled) setSrc(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [baseUri, tokenId]);
  return (
    <span
      aria-hidden="true"
      style={{
        width: '100%',
        aspectRatio: '1 / 1',
        borderRadius: 8,
        border: '1.5px solid var(--anchor)',
        // Metadata is untrusted: encode so a quote in the URL can't break out of url("").
        background: src
          ? `var(--cream-deep) center/contain no-repeat url("${encodeURI(src).replace(/"/g, '%22')}")`
          : 'var(--cream-deep)',
        display: 'block',
      }}
    />
  );
}
