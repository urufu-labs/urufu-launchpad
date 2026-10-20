'use client';

/// /create/fair: the Fair launch lane (docs/SPEC-fair-launch.md), laid out like the
/// token create page (steps rail, form panels, sticky preview + launch rail).
/// Submit = FairLaunchFactory.launch (fee in ETH) or launchWithURU (fee in URU),
/// with the creator's first opening-batch deposit attached. After the tx lands,
/// artwork and links are pinned and saved the same way the token lane does it.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatEther, parseEther, type Address } from 'viem';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { useActiveChain } from '@/components/ChainSwitcher';
import { erc20TokenAbi, fairLaunchFactoryAbi } from '@/lib/abis';
import { CHAIN_LABELS, FAIR_LAUNCHES, FAIR_LAUNCHES_ENABLED } from '@/lib/config';
import { persistMetadata, readFileAsDataUrl, safeBackgroundImage, type TokenMetadata } from '@/lib/metadata';
import { saveTokenMetadata } from '@/lib/socialApi';
import { CHAIN_KEY_TO_ID, explorerAddressUrl, explorerTxUrl, type WagmiChainId } from '@/lib/wagmi';
import styles from '../create-studio.module.css';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

type Meta = Omit<TokenMetadata, 'savedAt' | 'cid' | 'gatewayUrl'>;

/// Fixed for every Fair launch. Shown as a plain label / value list like the
/// cost and technical details elsewhere on the site.
const RULES: Array<[label: string, value: string]> = [
  ['Opening batch', '60 sec, one price'],
  ['Batch cap', '25% of the curve'],
  ['Sniper tax', '20% to 0% in 5 min'],
  ['Creator fee', '1% while you hold'],
  ['Dev sells 10%+', 'Fee is burned'],
  ['Token tax', 'None, no owner'],
]

export default function FairLaunchPage() {
  const chain = useActiveChain();
  const set = FAIR_LAUNCHES[chain];
  const live = FAIR_LAUNCHES_ENABLED[chain] === true && set !== null;
  const targetChainId = CHAIN_KEY_TO_ID[chain] as WagmiChainId;

  const { address: wallet, chainId: walletChainId, isConnected } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [deposit, setDeposit] = useState('');
  const [payIn, setPayIn] = useState<'ETH' | 'URU'>('ETH');
  const [metadata, setMetadata] = useState<Meta>({});
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoNotice, setLogoNotice] = useState<string | null>(null);

  const cleanName = name.trim();
  const cleanTicker = ticker.trim().toUpperCase();
  const depositWei = (() => {
    try {
      return deposit ? parseEther(deposit) : 0n;
    } catch {
      return null;
    }
  })();

  // ---------------------------------------------------------------- fees
  const user = wallet ?? ZERO;
  const feeReads = useReadContracts({
    allowFailure: true,
    contracts: set
      ? [
          { abi: fairLaunchFactoryAbi, address: set.LaunchFactory, functionName: 'ethFeeFor', args: [user], chainId: targetChainId },
          { abi: fairLaunchFactoryAbi, address: set.LaunchFactory, functionName: 'minUruFeeFor', args: [user], chainId: targetChainId },
          { abi: fairLaunchFactoryAbi, address: set.LaunchFactory, functionName: 'ethLaunchFee', chainId: targetChainId },
          { abi: fairLaunchFactoryAbi, address: set.LaunchFactory, functionName: 'minUruFee', chainId: targetChainId },
          { abi: fairLaunchFactoryAbi, address: set.LaunchFactory, functionName: 'uru', chainId: targetChainId },
        ]
      : [],
    query: { enabled: !!set, refetchInterval: 30_000 },
  });
  const ethFee = feeReads.data?.[0]?.result as bigint | undefined;
  const uruFee = feeReads.data?.[1]?.result as bigint | undefined;
  const ethGross = feeReads.data?.[2]?.result as bigint | undefined;
  const uruGross = feeReads.data?.[3]?.result as bigint | undefined;
  const uruToken = feeReads.data?.[4]?.result as Address | undefined;
  const uruEnabled = !!uruToken && uruToken !== ZERO && uruFee !== undefined && uruFee > 0n;
  const fee = payIn === 'ETH' ? ethFee : uruFee;
  const gross = payIn === 'ETH' ? ethGross : uruGross;
  const discountPct = fee !== undefined && gross !== undefined && gross > 0n ? Number(((gross - fee) * 100n) / gross) : 0;

  const allowance = useReadContract({
    abi: erc20TokenAbi,
    address: uruEnabled ? uruToken : undefined,
    functionName: 'allowance',
    args: wallet && set ? [wallet, set.LaunchFactory] : undefined,
    chainId: targetChainId,
    query: { enabled: live && payIn === 'URU' && uruEnabled && !!wallet },
  });
  const needsApprove = payIn === 'URU' && uruFee !== undefined && ((allowance.data as bigint | undefined) ?? 0n) < uruFee;

  // Predicted token address, so we know which token the launch tx created.
  const predicted = useReadContract({
    abi: fairLaunchFactoryAbi,
    address: set?.LaunchFactory,
    functionName: 'predictAddresses',
    args: wallet && cleanName && cleanTicker ? [wallet, cleanName, cleanTicker] : undefined,
    chainId: targetChainId,
    query: { enabled: live && !!wallet && !!cleanName && !!cleanTicker },
  });
  const predictedToken = (predicted.data as readonly [Address, Address, Address] | undefined)?.[0];

  // ---------------------------------------------------------------- tx
  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId: targetChainId });
  const [approving, setApproving] = useState(false);
  const [pendingToken, setPendingToken] = useState<Address | null>(null);
  const [launchedToken, setLaunchedToken] = useState<Address | null>(null);
  useEffect(() => {
    if (!isSuccess) return;
    if (approving) {
      setApproving(false);
      void allowance.refetch();
      reset();
      return;
    }
    if (pendingToken) setLaunchedToken(pendingToken);
  }, [isSuccess, approving, allowance, reset, pendingToken]);

  const wrongChain = isConnected && walletChainId !== targetChainId;
  const busy = isPending || confirming;
  const reason = !live
    ? 'Fair launch is not open on this chain yet.'
    : !wallet
      ? 'Connect a wallet to launch.'
      : wrongChain
        ? `Switch to ${CHAIN_LABELS[chain]} to launch.`
        : !cleanName
          ? 'Give it a name.'
          : !cleanTicker
            ? 'Give it a ticker.'
            : depositWei === null
              ? 'That deposit amount is not a number.'
              : fee === undefined
                ? 'Loading the launch fee...'
                : null;

  const launch = () => {
    if (!set || depositWei === null || fee === undefined) return;
    reset();
    if (payIn === 'URU') {
      if (!uruToken) return;
      if (needsApprove) {
        setApproving(true);
        writeContract({ abi: erc20TokenAbi, address: uruToken, functionName: 'approve', args: [set.LaunchFactory, fee], chainId: targetChainId });
        return;
      }
      setPendingToken(predictedToken ?? null);
      writeContract({
        abi: fairLaunchFactoryAbi,
        address: set.LaunchFactory,
        functionName: 'launchWithURU',
        args: [cleanName, cleanTicker, fee],
        value: depositWei,
        chainId: targetChainId,
      });
      return;
    }
    setPendingToken(predictedToken ?? null);
    writeContract({
      abi: fairLaunchFactoryAbi,
      address: set.LaunchFactory,
      functionName: 'launch',
      args: [cleanName, cleanTicker],
      value: depositWei + fee,
      chainId: targetChainId,
    });
  };

  // ---------------------------------------------------------------- artwork save
  // Same two-step save as the token lane: pin to IPFS, then a signed POST to the
  // compile service. The service only accepts it once the indexer has the launch,
  // so INDEXER_PENDING is retried for a while before showing a retry button.
  const [metaState, setMetaState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaTick, setMetaTick] = useState(0);
  useEffect(() => {
    if (!launchedToken || !wallet) return;
    const hasAny = metadata.logoDataUrl || metadata.description || metadata.website || metadata.twitter
      || metadata.telegram || metadata.discord || metadata.tiktok;
    if (!hasAny || metaState === 'saved') return;
    let cancelled = false;
    (async () => {
      setMetaState('saving');
      setMetaError(null);
      try {
        const pinned = await persistMetadata(targetChainId, launchedToken, metadata);
        for (let attempt = 0; attempt < 12 && !cancelled; attempt++) {
          const res = await saveTokenMetadata(
            wallet,
            {
              chainId: targetChainId,
              tokenAddress: launchedToken,
              imageUrl: pinned.gatewayUrl ?? null,
              description: metadata.description ?? null,
              website: metadata.website ?? null,
              twitter: metadata.twitter ?? null,
              telegram: metadata.telegram ?? null,
              discord: metadata.discord ?? null,
              tiktok: metadata.tiktok ?? null,
            },
            ({ message }) => signMessageAsync({ message }),
          );
          if (res.ok) {
            if (!cancelled) setMetaState('saved');
            return;
          }
          if (res.error !== 'INDEXER_PENDING') throw new Error(res.error);
          await new Promise((r) => setTimeout(r, 5_000));
        }
        throw new Error('The indexer has not picked up the launch yet.');
      } catch (err) {
        if (cancelled) return;
        setMetaState('error');
        setMetaError(err instanceof Error ? err.message.split('\n')[0] ?? 'Could not save' : 'Could not save');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchedToken, wallet, metaTick]);

  async function onPickLogo(file: File | undefined) {
    setLogoError(null);
    setLogoNotice(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLogoError('Please choose an image file.');
      return;
    }
    try {
      const result = await readFileAsDataUrl(file);
      setMetadata((prev) => ({ ...prev, logoDataUrl: result.dataUrl }));
      if (result.optimized) {
        setLogoNotice(
          `Optimized from ${Math.ceil(result.originalBytes / 1024)} KB to ${Math.ceil(result.outputBytes / 1024)} KB for launch.`,
        );
      }
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not read that file.');
    }
  }

  const fmt = (wei: bigint | undefined) => {
    if (wei === undefined) return '...';
    const [i, f = ''] = formatEther(wei).split('.');
    const t = f.slice(0, 4).replace(/0+$/, '');
    return t ? `${i}.${t}` : (i as string);
  };
  const totalEth = payIn === 'ETH' ? (ethFee ?? 0n) + (depositWei ?? 0n) : depositWei ?? 0n;
  const buttonLabel = !live
    ? 'Not open yet'
    : busy
      ? approving
        ? 'Approving URU...'
        : 'Launching...'
      : needsApprove
        ? `Approve URU (${fmt(uruFee)})`
        : 'Launch';

  return (
    <div className={styles.studio}>
      {wrongChain && live && (
        <div className={`${styles.banner} ${styles.bannerAccent}`}>
          <div>
            <div className={styles.bannerTitle}>Wrong network</div>
            <div className={styles.bannerText}>Please switch to {CHAIN_LABELS[chain]} to launch.</div>
          </div>
          <button type="button" className="ui-btn" data-variant="primary" disabled={switching} onClick={() => switchChain({ chainId: targetChainId })}>
            {switching ? 'Switching...' : 'Switch network'}
          </button>
        </div>
      )}

      <header className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>Launch · Fair launch</p>
          <h1 className={styles.pageTitle}>Fair launch</h1>
          <p className={styles.pageLede}>
            A token where snipers and bundles get no edge, and the dev only earns while they hold. It trades
            on a bonding curve, then moves to Uniswap v4 with liquidity locked forever.
          </p>
        </div>
      </header>

      <div className={styles.workbench}>
        <nav className={styles.progressRail} aria-label="Create progress">
          <span className={styles.railLabel}>Steps</span>
          <a href="#fair-details">
            <b>01</b>
            <span>Token details</span>
          </a>
          <a href="#fair-media">
            <b>02</b>
            <span>Artwork and links</span>
          </a>
          <a href="#fair-settings">
            <b>03</b>
            <span>Launch settings</span>
          </a>
          <a href="#fair-review">
            <b>04</b>
            <span>Review and launch</span>
          </a>
        </nav>

        <div className={styles.mainStack}>
          <section id="fair-details" className={`${styles.identityPanel} ${styles.panel}`}>
            <PanelHead step="01" title="Token details" />
            <div className={styles.panelBody}>
              <div className={styles.fieldGrid}>
                <Field label="Name">
                  <input
                    className="ui-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="urufu labs coin"
                    maxLength={32}
                    disabled={busy}
                  />
                </Field>
                <Field label="Ticker">
                  <input
                    className="ui-input uppercase"
                    data-mono="true"
                    value={ticker}
                    onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="URUFU"
                    maxLength={10}
                    disabled={busy}
                  />
                </Field>
              </div>
              <div className={styles.infoNote}>
                Supply is fixed at <b className={styles.mono}>800,000,000</b>. All of it goes to the bonding curve and
                the token has no owner, so nobody can mint more or add a tax.
              </div>
            </div>
          </section>

          <section id="fair-media" className={`${styles.metadataPanel} ${styles.panel}`}>
            <PanelHead step="02" title="Artwork and links" aside="Optional" />
            <div className={styles.panelBody}>
              <p className={styles.hint}>
                Images are pinned to IPFS through our Pinata gateway, so your token&apos;s artwork travels with it
                wherever it&apos;s shown. You sign once after launch to save it.
              </p>
              <Field label="Logo">
                <div className={styles.logoRow}>
                  <div className={styles.logoThumb} style={{ background: safeBackgroundImage(metadata.logoDataUrl) }}>
                    {!metadata.logoDataUrl && <span>No logo</span>}
                  </div>
                  <div className={styles.logoMeta}>
                    <div className={styles.logoActions}>
                      <label className="ui-btn" data-size="sm">
                        {metadata.logoDataUrl ? 'Change logo' : 'Upload logo'}
                        <input type="file" accept="image/*" onChange={(e) => onPickLogo(e.target.files?.[0])} style={{ display: 'none' }} />
                      </label>
                      {metadata.logoDataUrl && (
                        <button
                          type="button"
                          className="ui-btn"
                          data-variant="ghost"
                          data-size="sm"
                          onClick={() => {
                            setMetadata({ ...metadata, logoDataUrl: undefined });
                            setLogoError(null);
                            setLogoNotice(null);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className={styles.hint}>PNG, JPG, WebP or SVG up to 10 MB. Larger images are resized for launch.</div>
                    {logoNotice && <div className={styles.hint}>{logoNotice}</div>}
                    {logoError && <div className="ui-error">{logoError}</div>}
                  </div>
                </div>
              </Field>
              <Field label="Description">
                <textarea
                  className="ui-input"
                  rows={3}
                  maxLength={500}
                  value={metadata.description ?? ''}
                  onChange={(e) => setMetadata({ ...metadata, description: e.target.value })}
                  placeholder="What is this token? Tell people about it."
                />
              </Field>
              <div className={styles.fieldGrid}>
                <Field label="Website">
                  <input className="ui-input" value={metadata.website ?? ''} onChange={(e) => setMetadata({ ...metadata, website: e.target.value })} placeholder="https://..." />
                </Field>
                <Field label="X (Twitter)">
                  <input className="ui-input" value={metadata.twitter ?? ''} onChange={(e) => setMetadata({ ...metadata, twitter: e.target.value })} placeholder="https://x.com/..." />
                </Field>
                <Field label="Telegram">
                  <input className="ui-input" value={metadata.telegram ?? ''} onChange={(e) => setMetadata({ ...metadata, telegram: e.target.value })} placeholder="https://t.me/..." />
                </Field>
                <Field label="Discord">
                  <input className="ui-input" value={metadata.discord ?? ''} onChange={(e) => setMetadata({ ...metadata, discord: e.target.value })} placeholder="https://discord.gg/..." />
                </Field>
                <Field label="TikTok">
                  <input className="ui-input" value={metadata.tiktok ?? ''} onChange={(e) => setMetadata({ ...metadata, tiktok: e.target.value })} placeholder="https://tiktok.com/@..." />
                </Field>
              </div>
            </div>
          </section>

          <section id="fair-settings" className={`${styles.contractPanel} ${styles.panel}`}>
            <PanelHead step="03" title="Launch settings" aside="Fixed for every Fair launch" />
            <div className={styles.panelBody}>
              <dl className={styles.costList}>
                {RULES.map(([label, value]) => (
                  <div key={label} className="ui-kv">
                    <dt>{label}</dt>
                    <dd className="ui-num">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className={styles.hint}>
                Everyone in the first minute pays the same price, so splitting across wallets or getting in first
                earns nothing extra. The sniper tax (first 5 minutes after graduation) and any fee you forfeit are burned, never paid to anyone.
              </p>
              <label className="ui-field">
                <span className="ui-field-label">
                  Your first deposit <span className="ui-field-aside">Recommended</span>
                </span>
                <div className={styles.suffixWrap}>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value.replace(/[^0-9.]/g, ''))}
                    disabled={busy}
                    className="ui-input"
                    data-mono="true"
                  />
                  <span className={styles.suffix}>ETH</span>
                </div>
                <span className={styles.hint}>
                  Goes into the opening batch at the same price as everyone else. You only earn the creator fee
                  while you hold, so a launch with no deposit earns you nothing.
                </span>
              </label>
              <p className={styles.hint}>
                What it can&apos;t catch: the rules track the launch wallet. The trade page flags early buyers that
                got ETH or tokens straight from your wallet, but funding through an exchange gets past that.
              </p>
            </div>
          </section>
        </div>

        <aside id="fair-review" className={styles.launchRail}>
          <section className={styles.previewPanel} aria-label="Token preview">
            <div className={styles.previewTopline}>
              <span>Token preview</span>
              <b>{cleanTicker ? `$${cleanTicker}` : '$TICKER'}</b>
            </div>
            <div
              className={styles.previewArt}
              style={metadata.logoDataUrl ? { background: safeBackgroundImage(metadata.logoDataUrl) } : undefined}
              aria-hidden="true"
            >
              {!metadata.logoDataUrl && <span>urufu</span>}
            </div>
            <div className={styles.previewTicket}>
              <b>{cleanName || 'New token'}</b>
              <p>{metadata.description || 'Your token description appears here once you write it.'}</p>
            </div>
          </section>

          <div className={styles.statusNote}>
            {launchedToken ? <>Your token is live. The opening batch is open for 60 seconds.</> : <>Fair launch: the rules in step 03 apply to every launch.</>}
          </div>

          <div className={`${styles.panel} ${styles.costPanel}`}>
            <div className={styles.costHead}>
              <div className={styles.costLabel}>Launch cost</div>
              <div className={styles.costTotal}>
                {fmt(fee)}
                <span className={styles.costUnit}>{payIn}</span>
              </div>
            </div>

            {uruEnabled && (
              <div className="ui-seg" data-block="true" role="group" aria-label="Pay launch fee in">
                {(['ETH', 'URU'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setPayIn(t)} aria-pressed={payIn === t} disabled={busy}>
                    Pay in {t}
                  </button>
                ))}
              </div>
            )}

            <dl className={styles.costList}>
              <div className="ui-kv">
                <dt>Launch fee</dt>
                <dd className={`ui-num ${discountPct > 0 ? styles.strike : ''}`}>
                  {fmt(gross)} {payIn}
                </dd>
              </div>
              {discountPct > 0 && (
                <div className="ui-kv">
                  <dt>Holder discount (urufu gemu nft and URU)</dt>
                  <dd className={`ui-num ${styles.discount}`}>−{discountPct}%</dd>
                </div>
              )}
              <div className="ui-kv">
                <dt>Your opening-batch deposit</dt>
                <dd className="ui-num">{fmt(depositWei ?? 0n)} ETH</dd>
              </div>
              <div className="ui-kv">
                <dt>ETH sent</dt>
                <dd className="ui-num">{fmt(totalEth)} ETH</dd>
              </div>
            </dl>

            <button
              type="button"
              className="ui-btn"
              data-variant="primary"
              data-size="lg"
              data-block="true"
              disabled={!!reason || busy || !!launchedToken}
              onClick={launch}
            >
              {launchedToken ? 'Launched' : buttonLabel}
            </button>
            {reason && !launchedToken && <p className={styles.hint}>{reason}</p>}
            {error && <div className={styles.errorNote}>{error.message.split('\n')[0]}</div>}

            {txHash && (
              <div className={styles.txLine}>
                Transaction{' '}
                <Link href={explorerTxUrl(chain, txHash)} target="_blank" className={styles.link}>
                  {short(txHash)}
                </Link>
              </div>
            )}

            {launchedToken && (
              <div className={`uru-pop ${styles.successNote}`}>
                <div className={styles.subTitle}>Token deployed</div>
                <div className={styles.txLine}>
                  Address{' '}
                  <Link href={explorerAddressUrl(chain, launchedToken)} target="_blank" className={styles.link}>
                    {short(launchedToken)}
                  </Link>
                </div>
                {metaState === 'saving' && <div className={styles.hint}>Saving artwork and links...</div>}
                {metaState === 'saved' && <div className={styles.hint}>Artwork and links saved.</div>}
                {metaState === 'error' && (
                  <div className={styles.hint}>
                    Artwork not saved yet ({metaError}).{' '}
                    <button type="button" className={styles.link} onClick={() => setMetaTick((t) => t + 1)}>
                      Try again
                    </button>
                  </div>
                )}
                <Link href={`/trade/${launchedToken}`} className="ui-btn" data-variant="primary" data-block="true">
                  Open the opening batch →
                </Link>
              </div>
            )}
          </div>

          <div className={`hidden lg:block ${styles.panel} ${styles.sidePanel}`}>
            <div className={styles.sectionLabel}>Launch details</div>
            <ul className={styles.checkList}>
              <li>Same launch fee and holder discount as a normal token</li>
              <li>LP is locked forever after graduation</li>
              <li>Sniper tax and forfeited fees are burned, never paid out</li>
              <li>Claim creator fees from the trade page while you hold</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PanelHead({ step, title, aside }: { step?: string; title: string; aside?: string }) {
  return (
    <div className={styles.panelHead}>
      <h2 className={styles.panelTitle}>
        {step && <span className={styles.panelStep}>{step}</span>}
        {title}
      </h2>
      {aside && <span className={styles.panelAside}>{aside}</span>}
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      {children}
    </label>
  );
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
