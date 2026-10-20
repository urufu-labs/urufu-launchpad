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
import { formatUnits, isAddress, maxUint256, zeroAddress, type Address, type Hex } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { NFT_LAUNCHES_ENABLED, DN404_PAIR_CURRENCIES, type ChainKey } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { CHAIN_KEY_TO_ID, explorerAddressUrl } from '@/lib/wagmi';
import { nftErc721Abi, nftMintModuleAbi } from '@/lib/abis';
import { useDiscountTiers } from '@/lib/useDiscountTiers';
import {
  fetchNftCollectionsByAddresses,
  fetchNftMintsByCollection,
  type IndexerNftCollection,
  type IndexerNftMint,
} from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { fetchNftHolders, type NftHolder } from '@/lib/nftHoldersApi';
import { fetchCollectionMetadata, type RemoteCollectionMetadata } from '@/lib/socialApi';
import { CreatorTools, type PageDraft } from './CreatorTools';
import { cssUrl, safeImageUrl, themeStyle, type BackgroundStyle } from './collectionTheme';
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

/// DN404 mirror (the NFT half of a DN404 pair). It has no mint module: NFTs
/// appear and disappear as wallets hold whole units of the paired token. It
/// does answer these, plus name/symbol/owner/tokenURI.
const dn404MirrorAbi = [
  { type: 'function', name: 'baseERC20', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const nftWhitelistModuleAbi = [
  { type: 'function', name: 'flavor', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'wlWindowEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'walletListRoot', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

/// compile-service: whitelist proofs + holder signatures (/api/nft-wl).
const COMPILE_SERVICE = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? '';

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
          <h1 className={styles.notFoundTitle}>
            That&apos;s not a valid collection address
          </h1>
          <p className={styles.notFoundCopy}>
            Try browsing <Link href="/discover" className={styles.inlineLink}>launches</Link>.
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
      { address, abi: nftErc721Abi, functionName: 'owner', chainId: targetChainId },
      // DN404 mirrors only; these fail harmlessly on plain NFT collections.
      { address, abi: dn404MirrorAbi, functionName: 'baseERC20', chainId: targetChainId },
      { address, abi: dn404MirrorAbi, functionName: 'totalSupply', chainId: targetChainId },
    ],
    query: { staleTime: 10_000 },
  });
  const dn404Base = baseReads?.[7]?.status === 'success' ? (baseReads[7].result as Address) : undefined;
  const isDn404 = !!dn404Base && dn404Base !== zeroAddress;
  const dn404NftCount = baseReads?.[8]?.result as bigint | undefined;

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
  // DN404 mirrors have no minter(), so its failure is expected there.
  const minterMissing = minterRead?.status === 'success' && !hasMintModule;
  const minterReadFailed = !isDn404 && (baseReadsError || minterRead?.status === 'failure');
  const collectionOwner = baseReads?.[6]?.result as Address | undefined;
  // ------------------------------------------------------------
  // Page details + look the launcher saved from Customize your page (cover,
  // banner, accent color, background, description, socials). When set, these
  // win over the indexer copy. While the launcher edits, `previewDraft` holds
  // their unsaved changes and only their own browser renders it.
  // ------------------------------------------------------------
  const [pageMeta, setPageMeta] = useState<RemoteCollectionMetadata | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const row = await fetchCollectionMetadata(targetChainId, address);
      if (!cancelled) setPageMeta(row);
    })();
    return () => { cancelled = true; };
  }, [address, targetChainId]);
  const [previewDraft, setPreviewDraft] = useState<PageDraft | null>(null);
  const look = previewDraft ?? {
    imageUrl: pageMeta?.imageUrl ?? null,
    bannerUrl: pageMeta?.bannerUrl ?? null,
    accentColor: pageMeta?.accentColor ?? null,
    backgroundStyle: (pageMeta?.backgroundStyle ?? null) as BackgroundStyle | null,
    description: pageMeta?.description ?? null,
    website: pageMeta?.website ?? null,
    twitter: pageMeta?.twitter ?? null,
    telegram: pageMeta?.telegram ?? null,
    discord: pageMeta?.discord ?? null,
  };
  // data: URLs only ever come from the launcher's own unsaved preview.
  const pageImage = safeImageUrl(look.imageUrl, previewDraft !== null);
  const bannerImage = safeImageUrl(look.bannerUrl, previewDraft !== null);
  const bannerCss = bannerImage
    ? cssUrl(bannerImage.startsWith('data:') ? bannerImage : (toGatewayUrl(bannerImage) ?? bannerImage))
    : null;

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
  // DN404 mirrors have no baseURI() getter, so use the indexer's copy.
  const artBaseUri = baseUri ?? indexerRow?.baseUri ?? undefined;
  useEffect(() => {
    if (pageImage) { setCover(pageImage.startsWith('data:') ? pageImage : toGatewayUrl(pageImage)); return; }
    if (indexerRow?.coverImageUrl) { setCover(toGatewayUrl(indexerRow.coverImageUrl)); return; }
    if (!artBaseUri) return;
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(`${artBaseUri}1`);
      if (!cancelled) setCover(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [pageImage, indexerRow?.coverImageUrl, artBaseUri]);
  const description = (previewDraft ? look.description : pageMeta?.description) || indexerRow?.description || '';
  const socialLinks = collectionSocialLinks(look);

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
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'whitelistModule', chainId: targetChainId },
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

  // ------------------------------------------------------------
  // 2b. Whitelist window. During it, only listed wallets (wallet-list
  //     flavor: merkle proof) or holders (holders flavor: signed balance)
  //     can mint; the page fetches the proof or signature from
  //     compile-service and sends it with the mint. After the window,
  //     anyone mints with empty proofs.
  // ------------------------------------------------------------
  const wlModule = moduleReads?.[6]?.result as Address | undefined;
  const hasWl = !!wlModule && wlModule !== zeroAddress;
  const { data: wlReads } = useReadContracts({
    contracts: hasWl
      ? (['flavor', 'wlWindowEnd', 'walletListRoot'] as const).map((fn) => ({
          address: wlModule as Address,
          abi: nftWhitelistModuleAbi,
          functionName: fn,
          chainId: targetChainId,
        }))
      : [],
    query: { enabled: hasWl, staleTime: 60_000 },
  });
  const wlFlavor = wlReads?.[0]?.result as number | undefined; // 1 holders, 2 wallet list
  const wlWindowEnd = wlReads?.[1]?.result as bigint | undefined;
  const wlRoot = wlReads?.[2]?.result as Hex | undefined;
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  const wlActive = hasWl && wlFlavor !== undefined && wlFlavor !== 0 && wlWindowEnd !== undefined && BigInt(nowS) <= wlWindowEnd;
  const [wlArgs, setWlArgs] = useState<{ proof: Hex[]; count: bigint; expiry: bigint; sig: Hex } | null>(null);
  const [wlStatus, setWlStatus] = useState<'idle' | 'checking' | 'eligible' | 'not-eligible' | 'error'>('idle');
  useEffect(() => {
    setWlArgs(null);
    if (!wlActive || !walletAddress || !wlModule) { setWlStatus('idle'); return; }
    let cancelled = false;
    setWlStatus('checking');
    (async () => {
      try {
        if (wlFlavor === 2 && wlRoot) {
          const res = await fetch(`${COMPILE_SERVICE}/api/nft-wl/proof/${wlRoot}/${walletAddress}`);
          const body = res.ok ? ((await res.json()) as { inList: boolean; proof: Hex[] }) : null;
          if (cancelled) return;
          if (!body) { setWlStatus('error'); return; }
          if (!body.inList) { setWlStatus('not-eligible'); return; }
          setWlArgs({ proof: body.proof, count: 0n, expiry: 0n, sig: '0x' });
          setWlStatus('eligible');
        } else if (wlFlavor === 1) {
          const res = await fetch(`${COMPILE_SERVICE}/api/nft-wl/attest`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: walletAddress, whitelistModule: wlModule }),
          });
          const body = res.ok
            ? ((await res.json()) as { eligible: boolean; count?: string; expiry?: string; sig?: Hex })
            : null;
          if (cancelled) return;
          if (!body) { setWlStatus('error'); return; }
          if (!body.eligible || !body.sig) { setWlStatus(body.eligible ? 'idle' : 'not-eligible'); return; }
          setWlArgs({ proof: [], count: BigInt(body.count ?? '0'), expiry: BigInt(body.expiry ?? '0'), sig: body.sig });
          setWlStatus('eligible');
        }
      } catch {
        if (!cancelled) setWlStatus('error');
      }
    })();
    return () => { cancelled = true; };
    // Holder signatures last 15 min; refresh every 10 so one never goes stale.
  }, [wlActive, wlFlavor, wlRoot, wlModule, walletAddress, Math.floor(nowS / 600)]);
  const wlBlocksMint = wlActive && wlStatus !== 'eligible';

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
      // `uruAmount` is a ceiling: the module pulls only the live price. On
      // linear-step collections another mint can land first and raise the
      // price, which reverted an exact quote, so allow 5% headroom when the
      // approval covers it (one-time approvals do; one-mint approvals don't).
      const headroom = mintMode === 1 ? price + price / 20n : price;
      const maxPay = uruAllowance !== undefined && uruAllowance < headroom
        ? (uruAllowance > price ? uruAllowance : price)
        : headroom;
      writeMint({
        address: mintModule as Address,
        abi: nftMintModuleAbi,
        functionName: 'mintWithUru',
        args: [
          BigInt(mintQty),
          maxPay,
          (wlArgs?.proof ?? []) as `0x${string}`[],
          wlArgs?.count ?? 0n,
          wlArgs?.expiry ?? 0n,
          (wlArgs?.sig ?? '0x') as `0x${string}`,
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
          (wlArgs?.proof ?? []) as `0x${string}`[],
          wlArgs?.count ?? 0n,
          wlArgs?.expiry ?? 0n,
          (wlArgs?.sig ?? '0x') as `0x${string}`,
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
  const supplyLabel = isDn404
    ? `${dn404NftCount?.toString() ?? '—'}/${indexerRow?.maxSupply ?? '—'}`
    : maxSupply !== undefined && totalMinted !== undefined
      ? `${totalMinted.toString()}/${maxSupply === 0n ? '∞' : maxSupply.toString()}`
      : '—/—';
  // Display only: minted share of a capped supply, for the progress meter.
  const mintedPct =
    !isDn404 && maxSupply !== undefined && maxSupply > 0n && totalMinted !== undefined
      ? Math.min(100, Number((totalMinted * 10_000n) / maxSupply) / 100)
      : null;
  const chainLabel = chainKey === 'robinhood' ? 'Robinhood Chain' : chainKey;

  return (
    <div className={styles.themeShell} style={themeStyle(look)}>
    {bannerCss && look.backgroundStyle === 'banner' && (
      <div className={styles.backdrop} style={{ backgroundImage: bannerCss }} aria-hidden="true" />
    )}
    <div className={styles.page}>
      {previewDraft && (
        <div className={styles.previewBar}>
          <span>You&apos;re seeing unsaved changes. Visitors still see the old page.</span>
          <a href="#customize" className="ui-btn" data-size="sm">Back to editing</a>
        </div>
      )}
      {bannerCss && (
        <div
          className={styles.banner}
          role="img"
          aria-label={`${name ?? 'collection'} banner`}
          style={{ backgroundImage: bannerCss }}
        />
      )}
      <header className={styles.hero}>
        <div className={styles.eyebrow}>{isDn404 ? 'DN404 collection' : 'NFT collection'}</div>
        <h1 className={styles.heroTitle}>
          {name ? `${name}` : 'Collection'}
        </h1>
        <div className={styles.metaRow}>
          {symbol && (
            <span className="ui-badge" data-tone="accent">
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
          {collectionOwner && collectionOwner !== zeroAddress && (
            <span className={styles.metaItem}>
              Launched by{' '}
              <a
                className={styles.metaLink}
                href={explorerAddressUrl(chainKey, collectionOwner)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {collectionOwner.slice(0, 6)}…{collectionOwner.slice(-4)}
              </a>
            </span>
          )}
        </div>
        {description && (
          <p className={styles.lede}>
            {description}
          </p>
        )}
        {socialLinks.length > 0 && (
          <div className={styles.socialRow}>
            {socialLinks.map((l) => (
              <a
                key={l.label}
                className="ui-btn"
                data-size="sm"
                href={l.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
      </header>

      {!chainEnabled && (
        <div className={styles.warnPane}>
          <b>NFT collections aren&apos;t live on this chain yet.</b> Switch to Robinhood Chain to preview.
        </div>
      )}

      {chainEnabled && minterMissing && (
        <div className={styles.warnPane}>
          <b>Collection not found.</b> Either it wasn&apos;t launched here, or its mint module
          hasn&apos;t been assigned yet.
        </div>
      )}
      {chainEnabled && !hasMintModule && !minterMissing && minterReadFailed && !baseReadsPending && (
        <div className={styles.warnPane}>
          <b>Couldn&apos;t load this collection.</b> The network is busy, give it a moment.{' '}
          <button type="button" className="ui-btn" data-size="sm" onClick={() => void refetchBase()}>
            Try again
          </button>
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          <section className={styles.artShell}>
            {/* Cover art: indexer-resolved cover first, tokenURI(1) as the
                fallback. The plain surface + name only shows until art loads.
                `contain` so the whole image shows, never cropped. */}
            <div
              className={styles.artFrame}
              role={cover ? 'img' : undefined}
              aria-label={cover ? `${name ?? 'collection'} cover art` : undefined}
              style={cover ? {
                background: `var(--surface-2) center/contain no-repeat url("${encodeURI(cover).replace(/"/g, '%22')}")`,
              } : undefined}
            >
              {!cover && <span>{name ?? 'Cover art pending'}</span>}
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
              <section className={`ui-panel ${styles.pairPanel}`}>
                <div className={styles.pairCopy}>
                  <span className={styles.sectionLabel}>DN404 pair, priced in {pairLabel}</span>
                  <span className={styles.pairLine}>
                    Hold{' '}
                    <b className="ui-num">
                      {indexerRow.unitWei && indexerRow.unitWei !== '0'
                        ? (BigInt(indexerRow.unitWei) / 10n ** 18n).toString()
                        : '?'}
                    </b>
                    {' '}${indexerRow.ticker || 'TICK'} to hold 1 art piece
                  </span>
                </div>
                <Link
                  href={`/trade/${indexerRow.pairedToken}`}
                  className="ui-btn"
                  data-size="sm"
                >
                  Trade ${indexerRow.ticker || 'TICK'} →
                </Link>
              </section>
            );
          })()}

          <section className="ui-panel">
            <div className="ui-panel-head">
              <h2 className="ui-panel-title">Holders</h2>
              <span className={styles.headAside}>
                {holders && holders.length > 0 ? `${holders.length} wallets` : `Who's in the collection`}
              </span>
            </div>
            {holders === null ? (
              <div className={styles.emptyRow}>Loading holders…</div>
            ) : holders.length === 0 ? (
              <div className={styles.emptyRow}>No holders yet. Mint the first one.</div>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th data-align="right">Held</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders.slice(0, 20).map((h) => (
                      <tr key={h.address}>
                        <td>
                          <a
                            className={styles.holderLink}
                            href={explorerAddressUrl(chainKey, h.address)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {h.address.slice(0, 6)}…{h.address.slice(-4)}
                          </a>
                        </td>
                        <td data-align="right" className="ui-num">{h.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {holders.length > 20 && (
                  <div className={styles.moreRow}>
                    + {holders.length - 20} more
                  </div>
                )}
              </div>
            )}
          </section>

          {/* DN404 collections have no mints: NFTs come from holding the token. */}
          {!isDn404 && <section className="ui-panel">
            <div className="ui-panel-head">
              <h2 className="ui-panel-title">Recent mints</h2>
              <span className={styles.headAside}>Live mint feed</span>
            </div>
            {recentMints === null ? (
              <div className={styles.emptyRow}>Loading mints…</div>
            ) : recentMints.length === 0 ? (
              <div className={styles.emptyRow}>No mints yet. Be the first.</div>
            ) : (
              // Tiles big enough to actually see each minted piece.
              <ul className={styles.mintGrid}>
                {recentMints.map((m) => (
                  <li key={m.id} className={styles.mintTile}>
                    <MintThumb baseUri={baseUri} tokenId={firstMintedId(m)} />
                    <div className={styles.mintTileRow}>
                      <span className={styles.mintTileId}>{mintedIdsLabel(m)}</span>
                      <span className={styles.mintTileTime}>
                        {new Date(Number(m.blockTimestamp) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <a
                      className={styles.mintTileMinter}
                      href={explorerAddressUrl(chainKey, m.minter)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {m.minter.slice(0, 6)}…{m.minter.slice(-4)}
                      {m.wlUsed ? <span className={styles.mintTileWl}> · whitelist</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>}
        </div>

        <aside className={styles.rail}>
          {isDn404 ? (
            <section className="ui-panel">
              <div className="ui-panel-head">
                <h2 className="ui-panel-title">How to get one</h2>
                <span className="ui-badge">DN404</span>
              </div>
              <div className={`ui-panel-body ${styles.mintPanel}`}>
                <dl className={styles.kvList}>
                  <div className="ui-kv">
                    <dt>NFTs now</dt>
                    <dd className="ui-num">{supplyLabel}</dd>
                  </div>
                  <div className="ui-kv">
                    <dt>1 NFT per</dt>
                    <dd className="ui-num">
                      {indexerRow?.unitWei && indexerRow.unitWei !== '0'
                        ? `${(BigInt(indexerRow.unitWei) / 10n ** 18n).toLocaleString()} $${indexerRow.ticker || 'TICK'}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
                <p className={styles.note}>
                  There&apos;s no mint here. Buy the token and every full amount you hold
                  gives you one of these NFTs. Sell below it and the NFT goes away.
                </p>
                <Link
                  href={`/trade/${dn404Base}`}
                  className="ui-btn"
                  data-variant="primary"
                  data-block="true"
                  data-size="lg"
                >
                  Trade ${indexerRow?.ticker || symbol || 'token'}
                </Link>
              </div>
            </section>
          ) : (
          <section className="ui-panel">
            <div className="ui-panel-head">
              <h2 className="ui-panel-title">Mint</h2>
              <span className="ui-badge">{chainLabel}</span>
            </div>

            <div className={`ui-panel-body ${styles.mintPanel}`}>
              <dl className={styles.kvList}>
                <div className="ui-kv">
                  <dt>Price</dt>
                  <dd className={styles.priceValue}>
                    {hasMintModule && price > 0n ? (
                      `${priceDisplay} ${priceUnitLabel}`
                    ) : (
                      <span className={styles.muted}>Pending</span>
                    )}
                  </dd>
                </div>
                <div className="ui-kv">
                  <dt>Pay with</dt>
                  <dd className="ui-num">{hasMintModule ? priceUnitLabel : <span className={styles.muted}>—</span>}</dd>
                </div>
                <div className="ui-kv">
                  <dt>Pricing</dt>
                  <dd>
                    {mintMode === undefined ? (
                      <span className={styles.muted}>—</span>
                    ) : mintMode === 0 ? (
                      'Fixed'
                    ) : (
                      'Linear step'
                    )}
                  </dd>
                </div>
                {discountFloorBps !== undefined && discountFloorBps < 10_000n && (
                  <div className="ui-kv">
                    <dt>Discount floor</dt>
                    <dd className="ui-num">{Number(discountFloorBps) / 100}% min</dd>
                  </div>
                )}
                {claimedDiscountBps > 0n && (
                  <div className="ui-kv">
                    <dt>Tier discount</dt>
                    <dd className="ui-num">
                      <span className={styles.discount}>−{(Number(claimedDiscountBps) / 100).toFixed(2)}%</span>
                      {savingsDisplay && (
                        <span className={styles.savings}>
                          (saves {savingsDisplay} {priceUnitLabel})
                        </span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>

              <div className={styles.supplyBlock}>
                <div className={styles.supplyHead}>
                  <span>Minted</span>
                  <span className="ui-num">{supplyLabel}</span>
                </div>
                {mintedPct !== null && (
                  <div className="ui-meter" data-size="lg">
                    <span className="ui-meter-fill" style={{ transform: `scaleX(${mintedPct / 100})` }} />
                  </div>
                )}
              </div>

              {tiers.length > 0 && (
                <p className={styles.note}>
                  {fetchingAttestations
                    ? 'Checking your discounts…'
                    : externalProofs.length > 0
                      ? `Discount applied for ${externalProofs.length} tier${externalProofs.length === 1 ? '' : 's'}`
                      : Object.keys(attestationErrors).length > 0
                        ? 'Discount check failed, so this mint is full price'
                        : walletAddress
                          ? 'No discount for this wallet'
                          : 'Connect a wallet to check for discounts'}
                </p>
              )}

              {wlActive && wlWindowEnd !== undefined && (
                <p className={styles.wlNote}>
                  <b>Whitelist only</b> until{' '}
                  {new Date(Number(wlWindowEnd) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.{' '}
                  {!walletAddress
                    ? 'Connect a wallet to check if you are on it.'
                    : wlStatus === 'checking'
                      ? 'Checking your wallet…'
                      : wlStatus === 'eligible'
                        ? "You're on the whitelist."
                        : wlStatus === 'not-eligible'
                          ? wlFlavor === 1
                            ? "This wallet doesn't hold enough of the required collection. Everyone can mint after the whitelist ends."
                            : "This wallet isn't on the whitelist. Everyone can mint after it ends."
                          : wlStatus === 'error'
                            ? "Couldn't check the whitelist right now. Try again in a moment."
                            : ''}
                </p>
              )}

              <div className={styles.qtyRow}>
                <span className={styles.qtyLabel}>Quantity</span>
                <div className={styles.qtyControls}>
                  <button
                    type="button"
                    className="ui-icon-btn"
                    onClick={() => setMintQty(Math.max(1, mintQty - 1))}
                    aria-label="Decrease quantity"
                  >
                    −
                  </button>
                  <span className={styles.qtyNum}>{mintQty}</span>
                  <button
                    type="button"
                    className="ui-icon-btn"
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
                  className="ui-btn"
                  data-variant="ink"
                  data-block="true"
                  disabled={isApproving || isWaitingApprove || isSwitching || !walletAddress}
                  onClick={doApprove}
                >
                  {isWaitingApprove
                    ? 'Waiting for approval…'
                    : isApproving
                      ? 'Approving URU…'
                      : approveOnce
                        ? 'Approve URU (one time)'
                        : `Approve ${priceDisplay} URU`}
                </button>
              )}
              {needsUruApprove && !isApproved && (
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={approveOnce}
                    onChange={(e) => setApproveOnce(e.target.checked)}
                  />
                  <span>
                    Approve once for all mints here. You&apos;re only charged the mint price when you mint.
                    Untick to approve just this mint.
                  </span>
                </label>
              )}

              <button
                type="button"
                className="ui-btn"
                data-variant={hasMintModule && !needsUruApprove ? 'primary' : undefined}
                data-block="true"
                data-size="lg"
                disabled={
                  !hasMintModule ||
                  needsUruApprove ||
                  isMinting ||
                  isWaitingMint ||
                  isSwitching ||
                  wlBlocksMint ||
                  !walletAddress
                }
                onClick={doMint}
              >
                {isMinted
                  ? `Minted ✓ · Mint ${mintQty} more`
                  : isWaitingMint
                    ? 'Waiting for receipt…'
                    : isMinting
                      ? 'Confirm in your wallet…'
                      : hasMintModule
                        ? `Mint ${mintQty}`
                        : 'Mint (soon)'}
              </button>

              {mintError && (
                <p className={`ui-error ${styles.centerNote}`}>
                  {mintError.message.split('\n')[0]}
                </p>
              )}
              {isMinted && mintReceipt && (
                <p className={styles.centerNote}>
                  Transaction <span className="ui-num">{mintReceipt.transactionHash.slice(0, 10)}…</span> confirmed
                </p>
              )}
              {!walletAddress && (
                <p className={styles.centerNote}>
                  Connect a wallet to mint
                </p>
              )}
            </div>
          </section>
          )}

          {/* Creator tools: only the on-chain owner sees it (the component
              re-checks). Wait for the lane read so a DN404 page never points
              the setters at the mirror, which has none. */}
          {walletAddress && baseReads && (
            <CreatorTools
              collection={address}
              ownerTarget={isDn404 && dn404Base ? dn404Base : address}
              chainId={targetChainId}
              pageMeta={pageMeta}
              onPageMetaSaved={setPageMeta}
              onPreview={setPreviewDraft}
            />
          )}
        </aside>
      </div>
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
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--line)',
        // Metadata is untrusted: encode so a quote in the URL can't break out of url("").
        background: src
          ? `var(--surface-2) center/contain no-repeat url("${encodeURI(src).replace(/"/g, '%22')}")`
          : 'var(--surface-2)',
        display: 'block',
      }}
    />
  );
}

/// Socials the launcher saved, as safe http(s) links. Handles are accepted
/// as typed ("@name" or a full link); anything that is not http(s) after
/// expanding is dropped so a stored value can never become a script link.
function collectionSocialLinks(meta: Pick<RemoteCollectionMetadata, 'website' | 'twitter' | 'telegram' | 'discord'> | null): { label: string; href: string }[] {
  if (!meta) return [];
  const handle = (v: string) => v.trim().replace(/^@/, '');
  const asLink = (v: string | null, base: string | null): string | null => {
    if (!v || !v.trim()) return null;
    const t = v.trim();
    if (/^https?:\/\/\S+$/i.test(t)) return t;
    if (!base || !/^[A-Za-z0-9_.\-/]+$/.test(handle(t))) return null;
    return base + handle(t);
  };
  const out: { label: string; href: string }[] = [];
  const push = (label: string, href: string | null) => { if (href) out.push({ label, href }); };
  push('Website', asLink(meta.website, null));
  push('X', asLink(meta.twitter, 'https://x.com/'));
  push('Telegram', asLink(meta.telegram, 'https://t.me/'));
  push('Discord', asLink(meta.discord, 'https://discord.gg/'));
  return out;
}
