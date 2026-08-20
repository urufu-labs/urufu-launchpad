'use client';

/// Per-collection page.
///
/// Reads live state from the ERC-721 clone + its NftMintModule (found by
/// reading the ERC-721's Solady `owner()` — which is the mint module by
/// construction post-launch). Renders price + supply + mint controls.
///
/// URL: /collection/[address]  (address = the ERC-721 collection).
///
/// The mint UI dispatches between `mint()` and `mintWithUru()` based on
/// the module's `paymentToken` field. URU-mode adds an allowance step
/// before the mint tx.

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatEther, formatUnits, isAddress, zeroAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { NFT_LAUNCHES_ENABLED, type ChainKey } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { explorerAddressUrl } from '@/lib/wagmi';
import { nftErc721Abi, nftMintModuleAbi } from '@/lib/abis';
import styles from './collection.module.css';

// Solady Ownable — the ERC-721 clone inherits it; `owner()` returns the
// mint module post-`transferOwnership`. Kept inline because we don't
// pull in Solady's full ABI just for one function.
const soladyOwnerAbi = [
  {
    type: 'function',
    name: 'owner',
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
  const { address: walletAddress } = useAccount();
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  // ------------------------------------------------------------
  // 1. Read the ERC-721 basics + find its mint module (== owner()).
  // ------------------------------------------------------------
  const { data: baseReads } = useReadContracts({
    contracts: [
      { address, abi: nftErc721Abi, functionName: 'name' },
      { address, abi: nftErc721Abi, functionName: 'symbol' },
      { address, abi: nftErc721Abi, functionName: 'baseURI' },
      { address, abi: nftErc721Abi, functionName: 'totalMinted' },
      { address, abi: nftErc721Abi, functionName: 'maxSupply' },
      { address, abi: soladyOwnerAbi, functionName: 'owner' },
    ],
    query: { staleTime: 10_000 },
  });

  const name = baseReads?.[0]?.result as string | undefined;
  const symbol = baseReads?.[1]?.result as string | undefined;
  const baseURI = baseReads?.[2]?.result as string | undefined;
  const totalMinted = baseReads?.[3]?.result as bigint | undefined;
  const maxSupply = baseReads?.[4]?.result as bigint | undefined;
  const mintModule = baseReads?.[5]?.result as Address | undefined;
  const hasMintModule = mintModule && mintModule !== zeroAddress;

  // ------------------------------------------------------------
  // 2. Read mint-module state. Only fires once we've located the module.
  // ------------------------------------------------------------
  const { data: moduleReads } = useReadContracts({
    contracts: hasMintModule
      ? [
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'paymentToken' },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'basePriceWei' },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'priceStepWei' },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'mintMode' },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'discountFloorBps' },
          { address: mintModule as Address, abi: nftMintModuleAbi, functionName: 'perWalletMintCap' },
        ]
      : [],
    query: { enabled: hasMintModule, staleTime: 10_000 },
  });

  const paymentToken = moduleReads?.[0]?.result as Address | undefined;
  const basePriceWei = moduleReads?.[1]?.result as bigint | undefined;
  const priceStepWei = moduleReads?.[2]?.result as bigint | undefined;
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
    query: { enabled: hasMintModule && mintQty > 0, staleTime: 5_000 },
  });
  const price = (quotedWei as bigint | undefined) ?? 0n;
  const priceDisplay = price > 0n ? formatUnits(price, 18) : '—';

  // ------------------------------------------------------------
  // 4. URU allowance (only relevant when paidInUru).
  // ------------------------------------------------------------
  const { data: uruAllowance } = useReadContract({
    address: paidInUru ? (paymentToken as Address) : undefined,
    abi: erc20MinAbi,
    functionName: 'allowance',
    args: walletAddress && mintModule ? [walletAddress, mintModule as Address] : undefined,
    query: {
      enabled: paidInUru && !!walletAddress && !!mintModule,
      staleTime: 10_000,
    },
  });
  const needsUruApprove = paidInUru && (uruAllowance ?? 0n) < price;

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
    useWaitForTransactionReceipt({ hash: approveTxHash });

  const {
    writeContract: writeMint,
    data: mintTxHash,
    isPending: isMinting,
    error: mintError,
    reset: resetMint,
  } = useWriteContract();
  const { isLoading: isWaitingMint, isSuccess: isMinted, data: mintReceipt } =
    useWaitForTransactionReceipt({ hash: mintTxHash });

  // Clear write state when the buyer changes qty so stale "minted" flags
  // don't confuse the CTA.
  useEffect(() => {
    resetMint();
    resetApprove();
  }, [mintQty, resetMint, resetApprove]);

  const doApprove = () => {
    if (!paidInUru || !paymentToken || !mintModule) return;
    writeApprove({
      address: paymentToken as Address,
      abi: erc20MinAbi,
      functionName: 'approve',
      args: [mintModule as Address, price],
    });
  };

  const doMint = () => {
    if (!hasMintModule || !mintModule) return;
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
          [],
        ],
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
          [],
        ],
        value: price,
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

      {!chainEnabled && (
        <div className={styles.warnPane}>
          <b>nft collections aren&apos;t live on this chain yet.</b> switch to robinhood to preview.
        </div>
      )}

      {chainEnabled && !hasMintModule && (
        <div className={styles.warnPane}>
          <b>collection not found.</b> either not launched via the launchpad, or the mint module
          hasn&apos;t been assigned yet.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          <section className={styles.artShell}>
            <span className={`uru-stamp uru-stamp-pink ${styles.artStamp}`} aria-hidden="true">
              new ✿
            </span>
            <div className={styles.artFrame}>
              <span>{name ?? 'cover art pending'}</span>
            </div>
          </section>

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">♡ holders</span>
              <span className={styles.sectionEye}>who&apos;s in the collection</span>
            </div>
            <div className={styles.emptyRow}>holder list wires from indexer ~</div>
          </section>

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❉ recent mints</span>
              <span className={styles.sectionEye}>the live mint feed</span>
            </div>
            <div className={styles.emptyRow}>mint feed wires from indexer ~</div>
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
              </dl>

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
                  disabled={isApproving || isWaitingApprove || !walletAddress}
                  onClick={doApprove}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {isWaitingApprove
                    ? 'waiting for approval ~'
                    : isApproving
                      ? 'approving URU ~'
                      : `✿ approve ${priceDisplay} URU`}
                </button>
              )}

              <button
                type="button"
                className={`uru-btn ${hasMintModule && !needsUruApprove ? 'uru-btn-primary' : ''}`}
                disabled={
                  !hasMintModule ||
                  needsUruApprove ||
                  isMinting ||
                  isWaitingMint ||
                  isMinted ||
                  !walletAddress
                }
                onClick={doMint}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {isMinted
                  ? '✿ minted ✓'
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
