'use client';

/// Buy one listed NFT through Seaport (fulfillOrder, pays the listing price
/// in ETH). Before sending, re-reads ownerOf so a listing whose NFT moved or
/// (DN404) burned since the page loaded is never sent. For DN404 NFTs the
/// buyer's skipNFT flag is checked and explained: the purchase still
/// delivers this NFT (fork-tested on live $SMOKE), but with the flag on, new
/// whole amounts of the token the wallet buys later won't show up as NFTs.

import { useEffect, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import {
  DN404_SKIP_NFT_ABI,
  ERC721_MARKET_ABI,
  MARKET_CHAIN_ID,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  formatEthShort,
  fulfillArgs,
  type MarketListing,
} from '@/lib/market';
import styles from './market.module.css';

export function BuyButton({
  listing,
  pairedToken,
  onDone,
  size = 'md',
}: {
  listing: MarketListing;
  /// DN404 only: the base ERC-20 whose getSkipNFT decides if the buyer can
  /// receive the NFT.
  pairedToken?: Address;
  onDone?: () => void;
  size?: 'md' | 'lg';
}) {
  const { address: buyer, chainId: walletChainId } = useAccount();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const client = usePublicClient({ chainId: MARKET_CHAIN_ID });
  const isDn404 = listing.lane === 'dn404' && !!pairedToken && pairedToken !== zeroAddress;
  const isOwn = !!buyer && buyer.toLowerCase() === listing.seller.toLowerCase();

  const { data: skipNft, refetch: refetchSkip } = useReadContract({
    address: isDn404 ? pairedToken : undefined,
    abi: DN404_SKIP_NFT_ABI,
    functionName: 'getSkipNFT',
    args: buyer ? [buyer] : undefined,
    chainId: MARKET_CHAIN_ID,
    query: { enabled: isDn404 && !!buyer, staleTime: 15_000 },
  });

  const { writeContractAsync, isPending: confirming, error: writeError, reset } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: waiting, isSuccess: bought } = useWaitForTransactionReceipt({ hash: txHash, chainId: MARKET_CHAIN_ID });
  const [skipTx, setSkipTx] = useState<`0x${string}` | undefined>();
  const { isLoading: skipWaiting, isSuccess: skipDone } = useWaitForTransactionReceipt({ hash: skipTx, chainId: MARKET_CHAIN_ID });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => { if (bought) onDone?.(); }, [bought, onDone]);
  useEffect(() => { if (skipDone) void refetchSkip(); }, [skipDone, refetchSkip]);

  async function ensureChain(): Promise<boolean> {
    if (walletChainId === MARKET_CHAIN_ID) return true;
    try {
      await switchChainAsync({ chainId: MARKET_CHAIN_ID });
      return true;
    } catch {
      return false;
    }
  }

  async function buy() {
    setProblem(null);
    reset();
    if (!buyer || !client) return;
    if (!(await ensureChain())) return;
    // Re-check right before paying: the NFT must still be the seller's.
    try {
      const owner = await client.readContract({
        address: listing.collection,
        abi: ERC721_MARKET_ABI,
        functionName: 'ownerOf',
        args: [BigInt(listing.tokenId)],
      });
      if (owner.toLowerCase() !== listing.seller.toLowerCase()) {
        setProblem('This NFT moved since it was listed, so the listing is no longer valid.');
        onDone?.();
        return;
      }
    } catch {
      setProblem(isDn404
        ? 'This NFT no longer exists (the seller sold the tokens behind it), so the listing is no longer valid.'
        : "Couldn't confirm the seller still owns this NFT. Try again.");
      onDone?.();
      return;
    }
    try {
      const hash = await writeContractAsync({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'fulfillOrder',
        args: fulfillArgs(listing),
        value: BigInt(listing.priceWei),
        chainId: MARKET_CHAIN_ID,
      });
      setTxHash(hash);
    } catch {
      // Shown via writeError.
    }
  }

  async function turnOnNftReceiving() {
    if (!pairedToken || !(await ensureChain())) return;
    try {
      const hash = await writeContractAsync({
        address: pairedToken,
        abi: DN404_SKIP_NFT_ABI,
        functionName: 'setSkipNFT',
        args: [false],
        chainId: MARKET_CHAIN_ID,
      });
      setSkipTx(hash);
    } catch {
      // Shown via writeError.
    }
  }

  if (isOwn) {
    return <p className={styles.sub}>This is your listing.</p>;
  }

  const skipOn = isDn404 && skipNft === true;
  const busy = confirming || waiting || switching || skipWaiting;

  return (
    <div className={styles.form}>
      {skipOn && (
        <p className={styles.warn}>
          Your wallet has NFT receiving turned off for this token (skipNFT). You still get this
          NFT and the tokens behind it. But while it&apos;s off, more of the token you buy later
          won&apos;t show up as NFTs.{' '}
          <button type="button" className="ui-btn" data-size="sm" disabled={busy} onClick={turnOnNftReceiving}>
            {skipWaiting ? 'Waiting…' : 'Turn on NFT receiving'}
          </button>
        </p>
      )}
      <button
          type="button"
          className="ui-btn"
          data-variant="primary"
          data-block="true"
          data-size={size === 'lg' ? 'lg' : undefined}
          disabled={!buyer || busy || bought}
          onClick={buy}
        >
          {bought
            ? 'Bought ✓'
            : waiting
              ? 'Waiting for receipt…'
              : confirming
                ? 'Confirm in your wallet…'
                : !buyer
                  ? 'Connect a wallet to buy'
                  : `Buy for ${formatEthShort(listing.priceWei)} ETH`}
      </button>
      {problem && <p className="ui-error">{problem}</p>}
      {writeError && !problem && <p className="ui-error">{writeError.message.split('\n')[0]}</p>}
    </div>
  );
}
