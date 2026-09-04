'use client';

/// DN404 launch studio (slice 9b).
///
/// The DN404 lane is a paired ERC-20 + mirror ERC-721. The launcher picks a
/// `unit` (whole tokens per NFT — "hold N to hold one art piece") and a
/// `collectionSize` (how many NFTs exist). `totalSupply = collectionSize *
/// unit` is derived and shown as a live preview. There is no mint mechanic
/// selector, no per-mint price, and no whitelist — trading happens on the
/// bonding curve, and NFTs mint/burn on whole-unit balance transitions.
///
/// Deep-link contract (studio → here):
///   /create/dn404?baseUri=ipfs://...&name=...&ticker=...&collectionSize=...
///
/// Gate posture: form always renders when the feature flag is on so we can
/// iterate on the UX, but the submit button stays disabled until the
/// DN404_LAUNCHES[chain] slot is populated (isDn404DeployReady).

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatUnits, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import {
  DN404_LAUNCHES,
  DN404_LAUNCHES_ENABLED,
  ECOSYSTEM_TOKENS,
  isDn404DeployReady,
} from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { dn404LaunchFactoryAbi } from '@/lib/abis';
import styles from '../nft/nft-studio.module.css';

const MAX_FOUNDER_PREMINT_BPS = 2000;
const MAX_PREMINT_NFT_COUNT = 100;

function sanitizeTicker(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d]/g, '');
}

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
  const [contractUri, setContractUri] = useState('');
  const [collectionSize, setCollectionSize] = useState(search.get('collectionSize') ?? '');
  const [unit, setUnit] = useState('');
  const [founderPremintBps, setFounderPremintBps] = useState('0');
  const [antiSniperBlocks, setAntiSniperBlocks] = useState('0');
  const [buybackBurnBps, setBuybackBurnBps] = useState('0');

  // Live derived values
  const collectionSizeBig = useMemo(() => {
    try { return BigInt(collectionSize || '0'); } catch { return 0n; }
  }, [collectionSize]);
  const unitBig = useMemo(() => {
    try { return BigInt(unit || '0'); } catch { return 0n; }
  }, [unit]);
  const bpsNum = Math.min(Number(founderPremintBps || '0'), MAX_FOUNDER_PREMINT_BPS);

  const totalSupplyWei = collectionSizeBig * unitBig * 10n ** 18n;
  const founderMintWei = (totalSupplyWei * BigInt(bpsNum)) / 10_000n;
  const premintNfts = (collectionSizeBig * BigInt(bpsNum)) / 10_000n;

  // Client-side validation (mirrors the factory's on-chain gates so the
  // launcher sees the failure before they pay gas).
  const nameOk = name.trim().length > 0;
  const tickerOk = ticker.length > 0;
  const collectionSizeOk = collectionSizeBig > 0n;
  const unitOk = unitBig > 0n;
  const premintNftsOk = premintNfts <= BigInt(MAX_PREMINT_NFT_COUNT);
  const founderBpsOk = bpsNum <= MAX_FOUNDER_PREMINT_BPS;

  // ------------------------------------------------------------
  // On-chain wiring (only active when DN404_LAUNCHES[chain] is set).
  // ------------------------------------------------------------
  const { address: walletAddress } = useAccount();
  const dn404Set = DN404_LAUNCHES[activeChain];
  const factoryAddress = dn404Set?.LaunchFactory as Address | undefined;
  const ecosystem = ECOSYSTEM_TOKENS[activeChain];
  const uruTokenAddress = ecosystem?.uruToken as Address | undefined;

  // Live minUruFee quote — factory applies the launcher's LoyaltyOracle
  // discount server-side. Same read pattern as the NFT lane.
  const { data: minUruFeeQuote } = useReadContract({
    address: factoryAddress,
    abi: dn404LaunchFactoryAbi,
    functionName: 'minUruFeeFor',
    args: walletAddress ? [walletAddress] : undefined,
    query: { enabled: !!factoryAddress && !!walletAddress, staleTime: 30_000 },
  });
  const requiredUruFee = (minUruFeeQuote as bigint | undefined) ?? 0n;

  // URU allowance check — launcher must have approved factory for
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
  const { isLoading: isWaitingLaunch, isSuccess: isLaunched } =
    useWaitForTransactionReceipt({ hash: launchTxHash });

  const canSubmit =
    deployReady &&
    !!factoryAddress &&
    !!walletAddress &&
    !needsUruApprove &&
    nameOk &&
    tickerOk &&
    collectionSizeOk &&
    unitOk &&
    founderBpsOk &&
    premintNftsOk &&
    !isLaunching &&
    !isWaitingLaunch;

  const submit = () => {
    if (!factoryAddress) return;
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
          founderPremintBps: bpsNum,
          antiSniperBlocks: Number(antiSniperBlocks || '0'),
          buybackBurnBps: Number(buybackBurnBps || '0'),
          uruAmount: requiredUruFee,
        },
      ],
    });
  };

  return (
    <main className={styles.studio}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <Mascot size={44} />
        <div>
          <h1 style={{ margin: 0 }}>launch a DN404 pair</h1>
          <div className="uru-eyebrow" style={{ marginTop: 4 }}>
            one token, one paired collection · hold whole units to hold art
          </div>
        </div>
      </div>

      {!chainEnabled && (
        <div className="uru-shell-tight" style={{ marginBottom: 10 }}>
          <b>not live on {activeChain}.</b> switch to robinhood to preview the flow.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          {/* Basics */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❀ basics</span>
              <span className={styles.sectionEye}>name · ticker · art · size</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-name">pair name</label>
              <input
                id="dn-name"
                type="text"
                className="uru-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my dn404 pair"
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
                  placeholder="TICK"
                  maxLength={10}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dn-size">collection size (N)</label>
                <input
                  id="dn-size"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={collectionSize}
                  onChange={(e) => setCollectionSize(digitsOnly(e.target.value))}
                  placeholder="1000"
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-unit">unit — whole tokens per NFT</label>
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
                &quot;hold {unit || 'N'} {ticker || 'TICK'}, hold 1 NFT.&quot;
                total supply = collection size × unit.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-baseuri">baseURI</label>
              <input
                id="dn-baseuri"
                type="text"
                className="uru-input"
                value={baseUri}
                onChange={(e) => setBaseUri(e.target.value)}
                placeholder="ipfs://bafy.../"
              />
              <span className={styles.fieldHint}>
                trailing slash. tokenURI resolves as baseURI + tokenId + &quot;.json&quot;.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-cuuri">contractURI (optional)</label>
              <input
                id="dn-cuuri"
                type="text"
                className="uru-input"
                value={contractUri}
                onChange={(e) => setContractUri(e.target.value)}
                placeholder="ipfs://bafy.../collection.json"
              />
              <span className={styles.fieldHint}>
                marketplace cover + description JSON. leave blank to skip.
              </span>
            </div>
          </section>

          {/* Founder premint */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✧ founder premint (optional)</span>
              <span className={styles.sectionEye}>0 – 20% up front, rest to curve</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dn-fbps">bps (0 – 2000)</label>
              <input
                id="dn-fbps"
                type="text"
                inputMode="numeric"
                className="uru-input"
                value={founderPremintBps}
                onChange={(e) => setFounderPremintBps(digitsOnly(e.target.value))}
                placeholder="0"
              />
              <span className={styles.fieldHint}>
                {bpsNum > MAX_FOUNDER_PREMINT_BPS && (
                  <span style={{ color: 'var(--pink-hot)' }}>
                    max 2000 bps (20%).
                  </span>
                )}
                {bpsNum <= MAX_FOUNDER_PREMINT_BPS && (
                  <>
                    {premintNfts.toString()} NFTs + {formatUnits(founderMintWei, 18)}{' '}
                    {ticker || 'TICK'} to your wallet at launch.
                    {!premintNftsOk && (
                      <span style={{ color: 'var(--pink-hot)' }}>
                        {' · '}exceeds {MAX_PREMINT_NFT_COUNT}-NFT cap. reduce bps or increase unit.
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          </section>

          {/* Curve params */}
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✦ curve params (optional)</span>
              <span className={styles.sectionEye}>same knobs as ERC-20 launches</span>
            </div>

            <div className={styles.rowInputsShort}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dn-anti">anti-sniper blocks</label>
                <input
                  id="dn-anti"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={antiSniperBlocks}
                  onChange={(e) => setAntiSniperBlocks(digitsOnly(e.target.value))}
                  placeholder="0"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="dn-bb">buyback-burn bps</label>
                <input
                  id="dn-bb"
                  type="text"
                  inputMode="numeric"
                  className="uru-input"
                  value={buybackBurnBps}
                  onChange={(e) => setBuybackBurnBps(digitsOnly(e.target.value))}
                  placeholder="0"
                />
              </div>
            </div>
          </section>
        </div>

        {/* Launch rail */}
        <aside className={styles.launchRail}>
          <section className="uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❁ launch ticket</div>

            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, lineHeight: 1.7 }}>
              <div>pair · <b>{name || '—'}</b></div>
              <div>ticker · <b>{ticker || '—'}</b></div>
              <div>collection · <b>{collectionSize || '—'} NFTs</b></div>
              <div>unit · <b>{unit || '—'} {ticker || 'TICK'} / NFT</b></div>
              <div>total supply · <b>{formatUnits(totalSupplyWei, 18)} {ticker || 'TICK'}</b></div>
              <div>curve share · <b>{formatUnits(totalSupplyWei - founderMintWei, 18)}</b></div>
              <div>your premint · <b>{formatUnits(founderMintWei, 18)} + {premintNfts.toString()} NFTs</b></div>
              <div style={{ marginTop: 6 }}>
                URU launch fee · <b>{formatUnits(requiredUruFee, 18)}</b>
              </div>
            </div>

            {needsUruApprove && (
              <button
                type="button"
                className="uru-btn uru-btn-mint"
                onClick={approveUru}
                disabled={isApproving || isWaitingApprove}
                style={{ width: '100%', marginTop: 10 }}
              >
                {isApproving || isWaitingApprove ? 'approving…' : 'approve URU'}
              </button>
            )}

            <button
              type="button"
              className="uru-btn uru-btn-mint"
              onClick={submit}
              disabled={!canSubmit}
              style={{ width: '100%', marginTop: 8 }}
            >
              {isLaunching || isWaitingLaunch ? 'launching…' : 'launch DN404 pair'}
            </button>

            {!deployReady && chainEnabled && (
              <div className={styles.fieldHint} style={{ marginTop: 8 }}>
                factory addresses not yet populated on {activeChain}. UI preview only.
              </div>
            )}

            {launchError && (
              <div className={styles.fieldHint} style={{ marginTop: 8, color: 'var(--pink-hot)' }}>
                {launchError.message.slice(0, 200)}
              </div>
            )}

            {isLaunched && (
              <div className={styles.fieldHint} style={{ marginTop: 8, color: 'var(--mint-hot)' }}>
                launched! check /discover for your new pair.
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
