'use client';

import { useState } from 'react';
import type { Address } from 'viem';

import {
  fetchWalletNfts,
  type NftAvatarSource,
  type WalletNftChain,
  type WalletNftAvatar,
} from '@/lib/nftAvatarApi';
import styles from './NftAvatarPicker.module.css';

interface Props {
  address: Address | string;
  selected?: NftAvatarSource;
  onSelect: (nft: WalletNftAvatar) => void;
}

export function NftAvatarPicker({ address, selected, onSelect }: Props) {
  const [chains, setChains] = useState<WalletNftChain[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loadingChain, setLoadingChain] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await fetchWalletNfts(address);
      setChains(result.chains);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not scan this wallet’s NFTs.');
    } finally {
      setScanning(false);
    }
  };

  const loadMore = async (chain: WalletNftChain) => {
    if (!chain.nextCursor) return;
    setLoadingChain(chain.id);
    setError(null);
    try {
      const result = await fetchWalletNfts(address, { chain: chain.id, cursor: chain.nextCursor });
      const page = result.chains[0];
      if (!page) return;
      setChains((current) => current?.map((existing) => existing.id === chain.id ? {
        ...page,
        items: [...existing.items, ...page.items],
      } : existing) ?? current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more NFTs.');
    } finally {
      setLoadingChain(null);
    }
  };

  const found = chains?.reduce((sum, chain) => sum + chain.items.length, 0) ?? 0;

  return (
    <section className={styles.picker} aria-label="choose an NFT avatar">
      <div className={styles.head}>
        <div>
          <div className={styles.label}>NFT avatar</div>
          <p className={styles.copy}>Use an NFT you hold. Its original media URL is saved — we do not copy or host the image.</p>
        </div>
        <button type="button" className="uru-btn uru-btn-mint" onClick={scan} disabled={scanning}>
          {scanning ? 'scanning 12 chains…' : chains ? 'rescan NFTs' : 'find my NFTs'}
        </button>
      </div>

      {selected && (
        <div className={styles.selectedNote}>
          selected: {selected.tokenName ?? selected.collectionName ?? `#${selected.tokenId}`} · {selected.chain}
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {chains && found === 0 && !scanning && (
        <div className={styles.empty}>no displayable NFTs found across these networks</div>
      )}
      {chains?.map((chain) => chain.items.length > 0 && (
        <section className={styles.chain} key={chain.id}>
          <div className={styles.chainHead}>
            <span>{chain.label}</span>
            <small>{chain.items.length}{chain.nextCursor ? '+' : ''}</small>
          </div>
          <div className={styles.grid}>
            {chain.items.map((nft) => {
              const active = selected
                && selected.chainId === nft.chainId
                && selected.contractAddress === nft.contractAddress
                && selected.tokenId === nft.tokenId;
              return (
                <button
                  key={`${nft.contractAddress}:${nft.tokenId}`}
                  type="button"
                  className={styles.card}
                  data-active={active || undefined}
                  onClick={() => onSelect(nft)}
                  title={`Use ${nft.tokenName ?? nft.collectionName ?? `NFT #${nft.tokenId}`} as avatar`}
                >
                  <span className={styles.art}>
                    {/* NFT media originates on arbitrary collection hosts, so Next's static
                        remote-image allowlist cannot safely optimize this user-selected preview. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={nft.imageUrl} alt="" loading="lazy" />
                  </span>
                  <span className={styles.nftName}>{nft.tokenName ?? nft.collectionName ?? `#${nft.tokenId}`}</span>
                  <span className={styles.nftMeta}>{nft.collectionName ?? 'NFT'} · #{nft.tokenId}</span>
                </button>
              );
            })}
          </div>
          {chain.nextCursor && (
            <button
              type="button"
              className={styles.more}
              onClick={() => loadMore(chain)}
              disabled={loadingChain === chain.id}
            >
              {loadingChain === chain.id ? 'loading…' : `more ${chain.label} NFTs`}
            </button>
          )}
        </section>
      ))}
      {chains?.some((chain) => chain.error) && (
        <p className={styles.partial}>A network did not answer in time; rescan to try it again.</p>
      )}
    </section>
  );
}
