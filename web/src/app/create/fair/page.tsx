'use client';

/// /create/fair: the Fair launch lane (docs/SPEC-fair-launch.md). Shows the rules
/// always; the form only submits once FAIR_LAUNCHES_ENABLED and FAIR_LAUNCHES are
/// both set for the chain (contracts await an audit + the Uniswap hook allowlist).
/// Submit = FairLaunchFactory.launch(name, symbol) with the creator's first batch
/// deposit attached, then a jump to the new token's trade page.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseEther, type Address } from 'viem';
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { useActiveChain } from '@/components/ChainSwitcher';
import { fairLaunchFactoryAbi } from '@/lib/abis';
import { FAIR_LAUNCHES, FAIR_LAUNCHES_ENABLED, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID, type WagmiChainId } from '@/lib/wagmi';
import styles from '../create-studio.module.css';

const RULES: Array<{ title: string; body: string }> = [
  {
    title: 'Opening batch, one price for everyone',
    body:
      'For the first 60 seconds, buys go into one pot. When the minute ends, the whole pot buys at once and everyone pays the same price. Your tokens are your share of the pot, so splitting across 50 wallets or being first gets you nothing extra.',
  },
  {
    title: 'The batch can only take 25%',
    body:
      'The opening batch can buy at most a quarter of the curve. If more ETH comes in than that costs, everyone is filled by their share and the extra ETH comes back when you claim.',
  },
  {
    title: 'Sniper tax that burns',
    body:
      'When the token moves to Uniswap, trades pay an extra 20% that drops to 0 over 5 minutes. That tax is burned. Nobody gets it, not the platform and not the dev. For those 5 minutes nobody else can add liquidity either, so the tax cannot be dodged.',
  },
  {
    title: 'Dev sells, dev loses fees',
    body:
      'The dev earns 1% of trades only while they hold. A dev who holds nothing at graduation earns nothing. If the launch wallet sells, or moves more than 10% of its tokens away, its fee switches to buy and burn for good, including the fee from the selling trade itself.',
  },
  {
    title: 'No token tax',
    body:
      'The token itself is a plain coin. Wallet transfers move the exact amount, and the token has no owner who could add a tax later.',
  },
  {
    title: 'Same fees as a normal token',
    body:
      'Normal trades pay the usual platform and creator fee, so urufu gemu nft holders and URU buybacks get their share like every other launch. ETH pairs only for now.',
  },
];

export default function FairLaunchPage() {
  const chain = useActiveChain();
  const live = FAIR_LAUNCHES_ENABLED[chain] === true && FAIR_LAUNCHES[chain] !== null;

  return (
    <div className={styles.studio}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>Launch · Fair launch {live ? '' : '· soon'}</p>
          <h1 className={styles.pageTitle}>Fair launch</h1>
          <p className={styles.pageLede}>
            No sniper edge, no bundle edge, and the dev only earns while they hold.
          </p>
        </div>
      </header>

      <section className={styles.panel} aria-labelledby="fair-rules">
        <div className={styles.panelHead}>
          <h2 id="fair-rules" className={styles.panelTitle}>
            How it works
          </h2>
          <span className={styles.panelAside}>Built and tested, waiting on an audit</span>
        </div>
        <div className={styles.panelBody}>
          {RULES.map((r) => (
            <div key={r.title}>
              <p className={styles.subTitle}>{r.title}</p>
              <p className={styles.hint}>{r.body}</p>
            </div>
          ))}
          <p className={styles.infoNote}>
            <b>What it can&apos;t catch:</b> the rules only track the launch wallet. A dev who also buys
            from other wallets can&apos;t be stopped on-chain, so the trade page flags early buyers
            that got ETH or tokens straight from the dev wallet. Funding through an exchange or a
            second wallet still gets past that check.
          </p>
        </div>
      </section>

      <LaunchForm chain={chain} live={live} />
    </div>
  );
}

function LaunchForm({ chain, live }: { chain: ChainKey; live: boolean }) {
  const set = FAIR_LAUNCHES[chain];
  const targetChainId = CHAIN_KEY_TO_ID[chain] as WagmiChainId;
  const router = useRouter();
  const { address: wallet, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [deposit, setDeposit] = useState('');

  const cleanName = name.trim();
  const cleanTicker = ticker.trim().toUpperCase();
  const depositWei = (() => {
    try {
      return deposit ? parseEther(deposit) : 0n;
    } catch {
      return null;
    }
  })();

  // Predicted token address, so we can open its trade page right after the tx.
  const predicted = useReadContract({
    abi: fairLaunchFactoryAbi,
    address: set?.LaunchFactory,
    functionName: 'predictAddresses',
    args: wallet && cleanName && cleanTicker ? [wallet, cleanName, cleanTicker] : undefined,
    chainId: targetChainId,
    query: { enabled: live && !!set && !!wallet && !!cleanName && !!cleanTicker },
  });
  const token = (predicted.data as readonly [Address, Address, Address] | undefined)?.[0];

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId: targetChainId });
  useEffect(() => {
    if (isSuccess && token) router.push(`/trade/${token}`);
  }, [isSuccess, token, router]);

  const wrongChain = !!wallet && walletChainId !== targetChainId;
  const busy = isPending || confirming;
  const reason = !live
    ? null
    : !wallet
      ? 'Connect a wallet to launch.'
      : !cleanName
        ? 'Give it a name.'
        : !cleanTicker
          ? 'Give it a ticker.'
          : depositWei === null
            ? 'That deposit amount is not a number.'
            : null;

  const launch = () => {
    if (!set || depositWei === null) return;
    reset();
    writeContract({
      abi: fairLaunchFactoryAbi,
      address: set.LaunchFactory,
      functionName: 'launch',
      args: [cleanName, cleanTicker],
      value: depositWei,
      chainId: targetChainId,
    });
  };

  return (
    <section className={styles.panel} aria-labelledby="fair-form" style={{ opacity: live ? 1 : 0.55 }}>
      <div className={styles.panelHead}>
        <h2 id="fair-form" className={styles.panelTitle}>
          Launch
        </h2>
        <span className={styles.panelAside}>{live ? '' : 'Not open yet'}</span>
      </div>
      <div className={styles.panelBody}>
        <fieldset disabled={!live || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          <label className="ui-field-label">
            Name
            <input className="ui-input" placeholder="My Token" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ui-field-label">
            Ticker
            <input className="ui-input" placeholder="MYTKN" value={ticker} maxLength={12} onChange={(e) => setTicker(e.target.value)} />
          </label>
          <label className="ui-field-label">
            Your first deposit (ETH)
            <input
              className="ui-input"
              inputMode="decimal"
              placeholder="0.1"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </label>
          <p className={styles.hint}>
            Your deposit goes into the opening batch at the same price as everyone else. You only earn
            the 1% creator fee while you hold, so a launch with no deposit earns you nothing.
          </p>
          {wrongChain ? (
            <button type="button" className="ui-btn" disabled={switching} onClick={() => switchChain({ chainId: targetChainId })}>
              {switching ? 'Switching...' : 'Switch network'}
            </button>
          ) : (
            <button type="button" className="ui-btn" data-variant="primary" disabled={!live || !!reason || busy} onClick={launch}>
              {!live ? 'Coming after audit' : busy ? 'Launching...' : 'Launch'}
            </button>
          )}
          {reason && <p className={styles.hint}>{reason}</p>}
          {error && <p className={styles.errorNote}>{error.message.split('\n')[0]}</p>}
        </fieldset>
        <Link href="/create" className={styles.link}>
          Or launch a normal token now
        </Link>
      </div>
    </section>
  );
}
