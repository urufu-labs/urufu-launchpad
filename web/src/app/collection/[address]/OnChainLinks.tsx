'use client';

/// "Advanced" tab of Customize your page: the two on-chain links. NFT lane:
/// called on the ERC-721 collection. DN404 lane: called on the BASE ERC-20
/// (the mirror has no setters). Both are Solady onlyOwner; confirmed by
/// eth_call against live RH collections on 2026-10-19 (owner succeeds, any
/// other wallet reverts Unauthorized()).

import { useEffect, useState } from 'react';
import { useSwitchChain, useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { Address } from 'viem';

import type { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import styles from './collection.module.css';

/// Shared by ERC721ATemplate and Dn404Template.
export const uriAdminAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'baseURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'setBaseURI',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newBaseURI', type: 'string' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setContractURI',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newContractURI', type: 'string' }],
    outputs: [],
  },
] as const;

function isLinkUri(v: string): boolean {
  const t = v.trim();
  return t.startsWith('ipfs://') || t.startsWith('ar://') || t.startsWith('https://');
}

export function OnChainLinks({
  ownerTarget,
  chainId,
  currentBaseUri,
  currentContractUri,
  onChanged,
}: {
  ownerTarget: Address;
  chainId: (typeof CHAIN_KEY_TO_ID)[keyof typeof CHAIN_KEY_TO_ID];
  currentBaseUri: string;
  currentContractUri: string;
  onChanged: () => void;
}) {
  const { chainId: walletChainId } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();

  async function ensureChain(): Promise<boolean> {
    if (walletChainId === chainId) return true;
    try {
      await switchChainAsync({ chainId });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ contractURI
  const [contractUriDraft, setContractUriDraft] = useState('');
  const {
    writeContract: writeContractUri,
    data: contractUriTx,
    isPending: contractUriPending,
    error: contractUriError,
  } = useWriteContract();
  const { isLoading: contractUriWaiting, isSuccess: contractUriDone } =
    useWaitForTransactionReceipt({ hash: contractUriTx, chainId });
  const suggestedContractUri = currentBaseUri ? `${currentBaseUri}collection.json` : '';

  async function doSetContractUri() {
    if (!isLinkUri(contractUriDraft)) return;
    if (!(await ensureChain())) return;
    writeContractUri({
      address: ownerTarget,
      abi: uriAdminAbi,
      functionName: 'setContractURI',
      args: [contractUriDraft.trim()],
      chainId,
    });
  }

  // ------------------------------------------------------------ baseURI
  const [baseUriDraft, setBaseUriDraft] = useState('');
  const [baseUriConfirmed, setBaseUriConfirmed] = useState(false);
  const {
    writeContract: writeBaseUri,
    data: baseUriTx,
    isPending: baseUriPending,
    error: baseUriError,
  } = useWriteContract();
  const { isLoading: baseUriWaiting, isSuccess: baseUriDone } =
    useWaitForTransactionReceipt({ hash: baseUriTx, chainId });
  // tokenURI(id) = baseURI + id + ".json" on both templates, so the link
  // must end in a slash or every NFT points at a broken file.
  const baseUriDraftOk = isLinkUri(baseUriDraft) && baseUriDraft.trim().endsWith('/');

  async function doSetBaseUri() {
    if (!baseUriDraftOk || !baseUriConfirmed) return;
    if (!(await ensureChain())) return;
    writeBaseUri({
      address: ownerTarget,
      abi: uriAdminAbi,
      functionName: 'setBaseURI',
      args: [baseUriDraft.trim()],
      chainId,
    });
  }

  useEffect(() => {
    if (contractUriDone || baseUriDone) onChanged();
  }, [contractUriDone, baseUriDone, onChanged]);

  return (
    <div className={styles.launcherBody}>
      <p className={styles.note}>
        Stored on-chain, so each change is a transaction with a small gas fee. Most creators never
        touch these.
      </p>

      <div className={styles.sectionLabel}>Marketplace info</div>
      <p className={styles.note}>
        The file OpenSea and other marketplaces read for this collection&apos;s name, banner and
        description.
      </p>
      <p className={styles.note}>
        {currentContractUri
          ? <>Now: <span className={`ui-num ${styles.breakAll}`}>{currentContractUri}</span></>
          : <>Not set yet. Marketplaces show no banner or description until it is.</>}
      </p>
      <input
        type="text"
        className="ui-input"
        data-mono="true"
        value={contractUriDraft}
        onChange={(e) => setContractUriDraft(e.target.value)}
        placeholder={suggestedContractUri || 'ipfs://.../collection.json'}
        aria-label="Marketplace info link"
      />
      <div className={styles.launcherActions}>
        {suggestedContractUri && contractUriDraft !== suggestedContractUri && (
          <button
            type="button"
            className="ui-btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => setContractUriDraft(suggestedContractUri)}
            title="The studio publishes collection.json next to the NFT files"
          >
            Use collection.json from the art folder
          </button>
        )}
        <button
          type="button"
          className="ui-btn"
          data-size="sm"
          data-variant="primary"
          disabled={!isLinkUri(contractUriDraft) || contractUriPending || contractUriWaiting || isSwitching}
          onClick={() => void doSetContractUri()}
        >
          {contractUriDone
            ? 'Saved ✓'
            : contractUriWaiting
              ? 'Waiting for receipt…'
              : contractUriPending
                ? 'Confirm in your wallet…'
                : 'Save marketplace info'}
        </button>
      </div>
      {contractUriDraft && !isLinkUri(contractUriDraft) && (
        <p className="ui-error">Links must start with ipfs://, ar:// or https://</p>
      )}
      {contractUriError && <p className="ui-error">{contractUriError.message.split('\n')[0]}</p>}

      <hr className={styles.toolsDivider} />

      <div className={styles.sectionLabel}>Art and metadata folder</div>
      <p className={styles.toolsWarn}>
        <b>This changes every NFT in the collection.</b> Each NFT&apos;s picture and traits are read
        from this folder, so a wrong link breaks the art for every holder until you fix it.
      </p>
      <p className={styles.note}>
        {currentBaseUri
          ? <>Now: <span className={`ui-num ${styles.breakAll}`}>{currentBaseUri}</span></>
          : <>Not set.</>}
      </p>
      <input
        type="text"
        className="ui-input"
        data-mono="true"
        value={baseUriDraft}
        onChange={(e) => { setBaseUriDraft(e.target.value); setBaseUriConfirmed(false); }}
        placeholder="ipfs://.../"
        aria-label="Art and metadata folder link"
      />
      {baseUriDraft && !baseUriDraftOk && (
        <p className="ui-error">
          The link must start with ipfs://, ar:// or https:// and end with a slash (/).
        </p>
      )}
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={baseUriConfirmed}
          onChange={(e) => setBaseUriConfirmed(e.target.checked)}
          disabled={!baseUriDraftOk}
        />
        <span>
          I understand this changes the art and traits of every NFT in this collection, including
          ones people already hold.
        </span>
      </label>
      <div className={styles.launcherActions}>
        <button
          type="button"
          className="ui-btn"
          data-size="sm"
          data-variant="ink"
          disabled={!baseUriDraftOk || !baseUriConfirmed || baseUriPending || baseUriWaiting || isSwitching}
          onClick={() => void doSetBaseUri()}
        >
          {baseUriDone
            ? 'Saved ✓'
            : baseUriWaiting
              ? 'Waiting for receipt…'
              : baseUriPending
                ? 'Confirm in your wallet…'
                : 'Change art folder'}
        </button>
      </div>
      {baseUriError && <p className="ui-error">{baseUriError.message.split('\n')[0]}</p>}
    </div>
  );
}
