'use client';

/// NFT detail page: art, traits, owner, and the marketplace panel (price,
/// seller, Buy; List / Cancel for the owner). DN404 NFTs also show the token
/// value of 1 NFT next to the price.
///
/// URL: /collection/[address]/[tokenId]

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { isAddress, zeroAddress, type Address } from 'viem';
import { useAccount, useReadContract } from 'wagmi';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { BuyButton } from '@/components/market/BuyButton';
import { CancelButton } from '@/components/market/CancelButton';
import { ListForm } from '@/components/market/ListForm';
import { TokenValueLine } from '@/components/market/MarketPanel';
import { useTokenImage } from '@/components/market/TokenArt';
import marketStyles from '@/components/market/market.module.css';
import { useActiveChain } from '@/components/ChainSwitcher';
import { nftErc721Abi } from '@/lib/abis';
import { fetchMarketSalesByToken, type IndexerMarketSale } from '@/lib/indexer';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import {
  ERC721_MARKET_ABI,
  MARKET_CHAIN_ID,
  NO_FEE_COPY,
  fetchTokenListing,
  formatEthShort,
  shortAddr,
  type TokenListing,
} from '@/lib/market';
import { useDn404TokenValue } from '@/lib/useDn404TokenValue';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/wagmi';
import styles from '../collection.module.css';

export default function NftDetailPage({ params }: { params: Promise<{ address: string; tokenId: string }> }) {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return <NftDetailRoute params={params} />;
}

function NftDetailRoute({ params }: { params: Promise<{ address: string; tokenId: string }> }) {
  const { address, tokenId } = use(params);
  if (!isAddress(address) || !/^\d{1,78}$/.test(tokenId)) {
    return (
      <div className={styles.page}>
        <div className={styles.notFound}>
          <Mascot size={72} mood="sleepy" />
          <h1 className={styles.notFoundTitle}>That&apos;s not a valid NFT link</h1>
          <p className={styles.notFoundCopy}>
            Try browsing <Link href="/discover" className={styles.inlineLink}>launches</Link>.
          </p>
        </div>
      </div>
    );
  }
  return <NftDetail collection={address as Address} tokenId={tokenId} />;
}

function NftDetail({ collection, tokenId }: { collection: Address; tokenId: string }) {
  const chainKey = useActiveChain();
  const { address: wallet } = useAccount();
  const [data, setData] = useState<TokenListing | null | undefined>(undefined);
  const [sales, setSales] = useState<IndexerMarketSale[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [res, s] = await Promise.all([
        fetchTokenListing(collection, tokenId, nonce > 0),
        fetchMarketSalesByToken(collection, tokenId, 20),
      ]);
      if (cancelled) return;
      setData(res);
      setSales(s);
    })();
    return () => { cancelled = true; };
  }, [collection, tokenId, nonce]);

  const { data: name } = useReadContract({
    address: collection, abi: nftErc721Abi, functionName: 'name', chainId: MARKET_CHAIN_ID, query: { staleTime: 300_000 },
  });
  const { data: owner, isError: ownerMissing, refetch: refetchOwner } = useReadContract({
    address: collection,
    abi: ERC721_MARKET_ABI,
    functionName: 'ownerOf',
    args: [BigInt(tokenId)],
    chainId: MARKET_CHAIN_ID,
    query: { staleTime: 10_000, retry: false },
  });
  useEffect(() => { if (nonce > 0) void refetchOwner(); }, [nonce, refetchOwner]);

  const lane = data?.lane ?? 'nft';
  const pairedToken = data?.pairedToken && data.pairedToken !== zeroAddress ? data.pairedToken : undefined;
  const unitWei = data?.unitWei ? BigInt(data.unitWei) : undefined;
  const tokenValue = useDn404TokenValue(lane === 'dn404' ? pairedToken : undefined, unitWei, MARKET_CHAIN_ID);
  const image = useTokenImage(collection, tokenId, data?.meta?.image);
  const listing = data?.listing ?? null;
  const myPaused = wallet
    ? (data?.paused ?? []).find((p) => p.seller.toLowerCase() === wallet.toLowerCase()) ?? null
    : null;
  const isOwner = !!wallet && !!owner && owner.toLowerCase() === wallet.toLowerCase();
  // Some metadata names a token just "1" or "#1"; lead with the collection then.
  const metaName = data?.meta?.name?.trim();
  const title = metaName && !/^#?\d+$/.test(metaName)
    ? metaName
    : `${(name as string | undefined) ?? 'NFT'} #${tokenId}`;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.eyebrow}>
          <Link href={`/collection/${collection}`} className={styles.inlineLink}>
            {(name as string | undefined) ?? 'Collection'}
          </Link>
          {lane === 'dn404' ? ' · DN404' : ''}
        </div>
        <h1 className={styles.heroTitle}>{title}</h1>
        <div className={styles.metaRow}>
          {owner ? (
            <span className={styles.metaItem}>
              Owned by{' '}
              <Link className={styles.metaLink} href={`/profile/${owner}`}>{shortAddr(owner)}</Link>
            </span>
          ) : ownerMissing ? (
            <span className={styles.metaItem}>
              {lane === 'dn404' ? 'This NFT is not held by anyone right now.' : 'Not minted yet.'}
            </span>
          ) : null}
          {data?.rarityRank ? (
            <span className="ui-badge">Rarity rank {data.rarityRank} of {data.rarityScanned}</span>
          ) : null}
        </div>
      </header>

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          <section className={styles.artShell}>
            <div
              className={styles.artFrame}
              role={image ? 'img' : undefined}
              aria-label={image ? title : undefined}
              style={image ? { background: `var(--surface-2) center/contain no-repeat url("${encodeURI(image).replace(/"/g, '%22')}")` } : undefined}
            >
              {!image && <span>{title}</span>}
            </div>
          </section>

          {data?.meta?.attributes && data.meta.attributes.length > 0 && (
            <section className="ui-panel">
              <div className="ui-panel-head">
                <h2 className="ui-panel-title">Traits</h2>
              </div>
              <div className={`ui-panel-body ${marketStyles.traits}`}>
                {data.meta.attributes.map((a) => (
                  <div key={`${a.trait_type}:${a.value}`} className={marketStyles.trait}>
                    <span>{a.trait_type}</span>
                    {a.value}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="ui-panel">
            <div className="ui-panel-head">
              <h2 className="ui-panel-title">Sales</h2>
            </div>
            {!sales || sales.length === 0 ? (
              <div className={styles.emptyRow}>No sales yet.</div>
            ) : (
              <div className="ui-table-wrap">
                <table className="ui-table">
                  <thead>
                    <tr><th data-align="right">Price</th><th>From</th><th>To</th><th data-align="right">When</th></tr>
                  </thead>
                  <tbody>
                    {sales.map((s) => (
                      <tr key={s.id}>
                        <td data-align="right" className="ui-num">{formatEthShort(s.priceWei)} ETH</td>
                        <td><a className={styles.holderLink} href={explorerAddressUrl(chainKey, s.seller)} target="_blank" rel="noopener noreferrer">{shortAddr(s.seller)}</a></td>
                        <td><a className={styles.holderLink} href={explorerAddressUrl(chainKey, s.buyer)} target="_blank" rel="noopener noreferrer">{shortAddr(s.buyer)}</a></td>
                        <td data-align="right">
                          <a className={styles.holderLink} href={explorerTxUrl(chainKey, s.txHash)} target="_blank" rel="noopener noreferrer">
                            {new Date(Number(s.blockTimestamp) * 1000).toLocaleDateString()}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className={styles.rail}>
          <section className="ui-panel">
            <div className="ui-panel-head">
              <h2 className="ui-panel-title">{listing ? 'For sale' : isOwner ? 'List for sale' : 'Not listed'}</h2>
              <span className="ui-badge" data-tone="accent">0% fee</span>
            </div>
            <div className={`ui-panel-body ${styles.mintPanel}`}>
              {myPaused && !listing && (
                <div className={marketStyles.warn}>
                  You have an older listing for this NFT at {formatEthShort(myPaused.priceWei)} ETH. It
                  isn&apos;t buyable right now
                  {myPaused.hiddenReason === 'not_approved'
                    ? ' because marketplace approval is off, but approving again would make it buyable at that price.'
                    : myPaused.hiddenReason === 'not_owner'
                      ? ' because this wallet no longer holds the NFT, but it would be buyable again if the NFT comes back.'
                      : '.'}{' '}
                  Cancel it to be safe.
                  <div style={{ marginTop: 8 }}>
                    <CancelButton listing={myPaused} onDone={refresh} />
                  </div>
                </div>
              )}
              {data === undefined ? (
                <p className={styles.note}>Loading…</p>
              ) : data === null ? (
                <p className={styles.note}>Only NFTs from collections launched on urufu can be traded here.</p>
              ) : listing ? (
                <>
                  <dl className={styles.kvList}>
                    <div className="ui-kv">
                      <dt>Price</dt>
                      <dd className={styles.priceValue}>{formatEthShort(listing.priceWei)} ETH</dd>
                    </div>
                    <div className="ui-kv">
                      <dt>Seller</dt>
                      <dd><Link className={styles.metaLink} href={`/profile/${listing.seller}`}>{shortAddr(listing.seller)}</Link></dd>
                    </div>
                    {BigInt(listing.royaltyWei) > 0n && (
                      <div className="ui-kv">
                        <dt>Creator royalty</dt>
                        <dd className="ui-num">{formatEthShort(listing.royaltyWei)} ETH</dd>
                      </div>
                    )}
                    <div className="ui-kv">
                      <dt>Ends</dt>
                      <dd>{new Date(Number(listing.endTime) * 1000).toLocaleDateString()}</dd>
                    </div>
                  </dl>
                  {lane === 'dn404' && <TokenValueLine value={tokenValue} priceWei={BigInt(listing.priceWei)} />}
                  {isOwner ? (
                    <>
                      <details>
                        <summary className={styles.note}>Change price</summary>
                        <ListForm
                          collection={collection}
                          tokenId={tokenId}
                          lane={lane}
                          replaces={listing}
                          pairedToken={pairedToken}
                          unitWei={unitWei}
                          onListed={refresh}
                        />
                      </details>
                      <CancelButton listing={listing} onDone={refresh} />
                    </>
                  ) : (
                    <BuyButton listing={listing} pairedToken={pairedToken} onDone={refresh} size="lg" />
                  )}
                  <p className={styles.note}>{NO_FEE_COPY}</p>
                </>
              ) : isOwner ? (
                <>
                  {lane === 'dn404' && tokenValue.value !== null && (
                    <p className={styles.note}>
                      Token value of 1 NFT: <b>{formatEthShort(tokenValue.value)} {tokenValue.unit}</b>. Price it above
                      that if its traits are worth more than the tokens behind it.
                    </p>
                  )}
                  <ListForm
                    collection={collection}
                    tokenId={tokenId}
                    lane={lane}
                    replaces={myPaused ?? undefined}
                    pairedToken={pairedToken}
                    unitWei={unitWei}
                    onListed={refresh}
                  />
                </>
              ) : (
                <>
                  {lane === 'dn404' && tokenValue.value !== null && (
                    <p className={styles.note}>
                      Token value of 1 NFT: <b>{formatEthShort(tokenValue.value)} {tokenValue.unit}</b>.
                    </p>
                  )}
                  <p className={styles.note}>This NFT isn&apos;t listed right now.</p>
                </>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
