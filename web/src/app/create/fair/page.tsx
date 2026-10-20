'use client';

/// /create/fair: the Fair launch lane (docs/SPEC-fair-launch.md). Shown so people
/// can read the rules, but NOT launchable: the contracts are built and fork-tested
/// and wait for an audit + the Uniswap hook allowlist. The form stays disabled
/// until FAIR_LAUNCHES_ENABLED and FAIR_LAUNCHES are both set for the chain.

import Link from 'next/link';

import { useActiveChain } from '@/components/ChainSwitcher';
import { FAIR_LAUNCHES, FAIR_LAUNCHES_ENABLED } from '@/lib/config';
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

      <section className={styles.panel} aria-labelledby="fair-form" style={{ opacity: live ? 1 : 0.55 }}>
        <div className={styles.panelHead}>
          <h2 id="fair-form" className={styles.panelTitle}>
            Launch
          </h2>
          <span className={styles.panelAside}>{live ? '' : 'Not open yet'}</span>
        </div>
        <div className={styles.panelBody}>
          <fieldset disabled={!live} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            <label className="ui-field-label">
              Name
              <input className="ui-input" placeholder="My Token" />
            </label>
            <label className="ui-field-label">
              Ticker
              <input className="ui-input" placeholder="MYTKN" />
            </label>
            <label className="ui-field-label">
              Your first deposit (ETH, optional)
              <input className="ui-input" inputMode="decimal" placeholder="0.1" />
            </label>
            <p className={styles.hint}>
              Your deposit goes into the opening batch at the same price as everyone else.
            </p>
            <button type="button" className="ui-btn" data-variant="primary" disabled>
              {live ? 'Launch' : 'Coming after audit'}
            </button>
          </fieldset>
          <Link href="/create" className={styles.link}>
            Or launch a normal token now
          </Link>
        </div>
      </section>
    </div>
  );
}
