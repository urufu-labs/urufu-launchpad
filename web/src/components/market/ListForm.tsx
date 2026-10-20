'use client';

/// List one NFT for sale: price in ETH + how long the listing lasts.
///
/// One-time approval lets Seaport move NFTs from this collection when a buyer
/// fills (for DN404 that's the mirror, the NFT side of the pair). Listing
/// itself is a free signature. The order has no marketplace fee; if the
/// collection has an ERC-2981 creator royalty, that part goes to the creator.

import { useEffect, useMemo, useState } from 'react';
import { parseEther, type Address } from 'viem';
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import {
  ERC721_MARKET_ABI,
  EXPIRY_CHOICES,
  MARKET_CHAIN_ID,
  NO_FEE_COPY,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  buildListingOrder,
  formatEthShort,
  randomSalt,
  seaportDomain,
  submitListing,
  type MarketListing,
} from '@/lib/market';
import styles from './market.module.css';

function parsePrice(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  try {
    const v = parseEther(s.endsWith('.') ? `${s}0` : s);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function ListForm({
  collection,
  tokenId,
  lane,
  onListed,
}: {
  collection: Address;
  tokenId: string;
  lane: 'nft' | 'dn404';
  onListed?: (l: MarketListing) => void;
}) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId: MARKET_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const [priceRaw, setPriceRaw] = useState('');
  const [expiry, setExpiry] = useState(EXPIRY_CHOICES[2]!.seconds);
  const price = useMemo(() => parsePrice(priceRaw), [priceRaw]);
  const [status, setStatus] = useState<'idle' | 'signing' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const { data: owner } = useReadContract({
    address: collection,
    abi: ERC721_MARKET_ABI,
    functionName: 'ownerOf',
    args: [BigInt(tokenId)],
    chainId: MARKET_CHAIN_ID,
    query: { staleTime: 10_000 },
  });
  const isOwner = !!wallet && !!owner && owner.toLowerCase() === wallet.toLowerCase();

  const { data: approvedAll, refetch: refetchApproval } = useReadContract({
    address: collection,
    abi: ERC721_MARKET_ABI,
    functionName: 'isApprovedForAll',
    args: wallet ? [wallet, SEAPORT_ADDRESS] : undefined,
    chainId: MARKET_CHAIN_ID,
    query: { enabled: !!wallet, staleTime: 10_000 },
  });

  // ERC-2981: reverts (no royalty) on collections without it.
  const { data: royaltyInfo, isError: noRoyalty } = useReadContract({
    address: collection,
    abi: ERC721_MARKET_ABI,
    functionName: 'royaltyInfo',
    args: [BigInt(tokenId), price ?? 0n],
    chainId: MARKET_CHAIN_ID,
    query: { enabled: price !== null, staleTime: 30_000, retry: false },
  });
  const royalty = !noRoyalty && royaltyInfo && royaltyInfo[1] > 0n
    ? { receiver: royaltyInfo[0], amount: royaltyInfo[1] }
    : null;

  const { writeContractAsync, isPending: approving, error: approveError } = useWriteContract();
  const [approveTx, setApproveTx] = useState<`0x${string}` | undefined>();
  const { isLoading: approveWaiting, isSuccess: approveDone } = useWaitForTransactionReceipt({ hash: approveTx, chainId: MARKET_CHAIN_ID });
  useEffect(() => { if (approveDone) void refetchApproval(); }, [approveDone, refetchApproval]);
  const approved = approvedAll === true || approveDone;

  const { signTypedDataAsync } = useSignTypedData();

  async function ensureChain(): Promise<boolean> {
    if (walletChainId === MARKET_CHAIN_ID) return true;
    try {
      await switchChainAsync({ chainId: MARKET_CHAIN_ID });
      return true;
    } catch {
      return false;
    }
  }

  async function approve() {
    setError(null);
    if (!(await ensureChain())) return;
    try {
      const hash = await writeContractAsync({
        address: collection,
        abi: ERC721_MARKET_ABI,
        functionName: 'setApprovalForAll',
        args: [SEAPORT_ADDRESS, true],
        chainId: MARKET_CHAIN_ID,
      });
      setApproveTx(hash);
    } catch {
      // Shown via approveError.
    }
  }

  async function list() {
    setError(null);
    if (!wallet || !client || price === null) return;
    if (!(await ensureChain())) return;
    try {
      setStatus('signing');
      const counter = await client.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [wallet],
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const order = buildListingOrder({
        seller: wallet,
        collection,
        tokenId: BigInt(tokenId),
        priceWei: price,
        royalty,
        startTime: now - 60n,
        endTime: now + BigInt(expiry),
        salt: randomSalt(),
        counter,
      });
      const signature = await signTypedDataAsync({
        domain: seaportDomain(MARKET_CHAIN_ID),
        types: SEAPORT_ORDER_TYPES,
        primaryType: 'OrderComponents',
        message: order,
      });
      setStatus('saving');
      const res = await submitListing(order, signature);
      if (!res.ok) {
        setError(res.message);
        setStatus('idle');
        return;
      }
      setStatus('done');
      onListed?.(res.listing);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : 'Listing failed.';
      setError(/reject|denied/i.test(msg ?? '') ? 'Signature cancelled.' : (msg ?? 'Listing failed.'));
      setStatus('idle');
    }
  }

  if (!wallet) return <p className={styles.note}>Connect a wallet to list.</p>;
  if (owner && !isOwner) return <p className={styles.note}>Only the owner of this NFT can list it.</p>;

  const youGet = price !== null ? price - (royalty?.amount ?? 0n) : null;

  return (
    <div className={styles.form}>
      <label className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Price (ETH)</span>
        <input
          className="ui-input"
          data-mono="true"
          inputMode="decimal"
          placeholder="0.05"
          value={priceRaw}
          onChange={(e) => setPriceRaw(e.target.value)}
        />
      </label>
      <label className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Listing lasts</span>
        <select className="ui-input" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.seconds} value={c.seconds}>{c.label}</option>
          ))}
        </select>
      </label>

      {price !== null && (
        <div className={styles.split}>
          <div><span>Buyer pays</span><b>{formatEthShort(price)} ETH</b></div>
          <div>
            <span>Creator royalty</span>
            <b>{royalty ? `${formatEthShort(royalty.amount)} ETH` : 'None'}</b>
          </div>
          <div><span>Marketplace fee</span><b>0 ETH</b></div>
          <div><span>You get</span><b>{formatEthShort(youGet ?? 0n)} ETH</b></div>
        </div>
      )}
      <p className={styles.note}>{NO_FEE_COPY}</p>
      {lane === 'dn404' && (
        <p className={styles.note}>
          Selling this NFT also sends the tokens behind it to the buyer. If you sell or move
          those tokens first, the NFT goes away and this listing stops working.
        </p>
      )}

      {!approved ? (
        <button
          type="button"
          className="ui-btn"
          data-variant="ink"
          data-block="true"
          disabled={approving || approveWaiting}
          onClick={approve}
        >
          {approveWaiting ? 'Waiting for approval…' : approving ? 'Confirm in your wallet…' : 'Approve marketplace (one time)'}
        </button>
      ) : (
        <button
          type="button"
          className="ui-btn"
          data-variant="primary"
          data-block="true"
          disabled={price === null || status === 'signing' || status === 'saving' || status === 'done'}
          onClick={list}
        >
          {status === 'done'
            ? 'Listed ✓'
            : status === 'signing'
              ? 'Sign in your wallet…'
              : status === 'saving'
                ? 'Saving listing…'
                : 'List for sale'}
        </button>
      )}
      {!approved && (
        <p className={styles.note}>
          The approval lets Seaport send this collection&apos;s NFTs to a buyer when they pay.
          Listing after that is a free signature, no gas.
        </p>
      )}
      {(error || approveError) && <p className="ui-error">{error ?? approveError?.message.split('\n')[0]}</p>}
    </div>
  );
}
