'use client';

/// Start a swarm (docs/PLAN-agents-and-swarms.md §4.1 step 1). Built by the agent API's
/// create_swarm and sent from the connected wallet; the new vault comes from the
/// SwarmCreated event in the receipt.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { decodeEventLog, isAddress, parseAbi, type Address } from 'viem';
import { useAccount } from 'wagmi';

import { callTool, useToolTx, walletErrorText, type ToolTx } from '@/lib/agentToolClient';
import cs from '../../create/create-studio.module.css';
import styles from '../swarms.module.css';

const swarmCreatedAbi = parseAbi([
  'event SwarmCreated(address indexed vault, address indexed proposer, address indexed creator, address token, address batch, string name, string ticker, uint64 joinDeadline, uint64 launchDeadline, uint16 quorumBps, uint256 minPool, uint256 maxPool, uint256 minDeposit, string metadataURI)',
]);

interface Quote { transactions: ToolTx[]; summary: string; warnings: string[]; errors: string[]; canBroadcast: boolean; factory: Address }

export default function StartSwarmPage() {
  const { address } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();
  const send = useToolTx();

  const [creator, setCreator] = useState('');
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [joinHours, setJoinHours] = useState('24');
  const [launchHours, setLaunchHours] = useState('24');
  const [quorumPct, setQuorumPct] = useState('60');
  const [minPoolEth, setMinPoolEth] = useState('0.1');
  const [maxPoolEth, setMaxPoolEth] = useState('0');
  const [minDepositEth, setMinDepositEth] = useState('0.001');
  const [idea, setIdea] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (address && !creator) setCreator(address); }, [address, creator]);
  const edit = (f: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { f(e.target.value); setQuote(null); };

  const check = async () => {
    setError(null);
    if (!address) return setError('Connect your wallet first.');
    if (!isAddress(creator)) return setError('Enter the wallet that will launch the coin.');
    setBusy(true);
    try {
      const { data } = await callTool<Quote>('create_swarm', {
        proposer: address, creator, name, ticker,
        joinHours: Number(joinHours), launchHours: Number(launchHours), quorumPct: Number(quorumPct),
        minPoolEth, maxPoolEth, minDepositEth,
        ...(idea.trim() ? { metadataURI: idea.trim() } : {}),
      });
      setQuote(data);
    } catch (e) {
      setError(walletErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!quote) return;
    setError(null);
    setBusy(true);
    try {
      const receipt = await send(quote.transactions[0]!);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== quote.factory.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: swarmCreatedAbi, data: log.data, topics: log.topics });
          router.push(`/swarms/${ev.args.vault}`);
          return;
        } catch { /* other event */ }
      }
      router.push('/swarms');
    } catch (e) {
      setError(walletErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>Launch · Swarm</p>
          <h1 className={cs.pageTitle}>Start a swarm</h1>
          <p className={cs.pageLede}>
            Propose a coin and who will launch it. People join with ETH and vote. If enough of the pot votes yes, it buys into the launch at the
            opening price and everyone gets their share. See <Link href="/swarms">all swarms</Link>.
          </p>
        </div>
      </header>

      <div className={styles.stack} style={{ maxWidth: 820 }}>
        <section className={cs.panel}>
          <div className={cs.panelHead}>
            <h2 className={cs.panelTitle}><span className={cs.panelStep}>01</span>The coin</h2>
          </div>
          <div className={cs.panelBody}>
            <div className={cs.fieldGrid}>
              <label className="ui-field">
                <span className="ui-field-label">Name</span>
                <input className="ui-input" value={name} onChange={edit(setName)} maxLength={64} />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Ticker</span>
                <input className="ui-input" value={ticker} onChange={edit((v) => setTicker(v.toUpperCase()))} maxLength={16} />
              </label>
            </div>
            <label className="ui-field">
              <span className="ui-field-label">Who launches it</span>
              <input className="ui-input" value={creator} onChange={edit(setCreator)} placeholder="0x… (you, or an agent account)" />
            </label>
            <label className="ui-field">
              <span className="ui-field-label">Link to the idea (optional)</span>
              <input className="ui-input" value={idea} onChange={edit(setIdea)} placeholder="https://… or ipfs://…" />
            </label>
            <p className="ui-hint">
              The creator must launch this exact name and ticker on the Fair lane after the vote closes. Any other spelling, or a launch before the
              vote ends (unless everyone voted yes), can&apos;t receive the pot, and everyone takes their ETH back.
            </p>
          </div>
        </section>

        <section className={cs.panel}>
          <div className={cs.panelHead}>
            <h2 className={cs.panelTitle}><span className={cs.panelStep}>02</span>The rules</h2>
          </div>
          <div className={cs.panelBody}>
            <div className={cs.fieldGrid}>
              <label className="ui-field">
                <span className="ui-field-label">Hours to join and vote</span>
                <input className="ui-input" value={joinHours} onChange={edit(setJoinHours)} inputMode="numeric" />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Then hours to launch</span>
                <input className="ui-input" value={launchHours} onChange={edit(setLaunchHours)} inputMode="numeric" />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Yes votes needed (%)</span>
                <input className="ui-input" value={quorumPct} onChange={edit(setQuorumPct)} inputMode="numeric" />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Smallest pot (ETH)</span>
                <input className="ui-input" value={minPoolEth} onChange={edit(setMinPoolEth)} inputMode="decimal" />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Largest pot (ETH, 0 = no limit)</span>
                <input className="ui-input" value={maxPoolEth} onChange={edit(setMaxPoolEth)} inputMode="decimal" />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Smallest deposit (ETH)</span>
                <input className="ui-input" value={minDepositEth} onChange={edit(setMinDepositEth)} inputMode="decimal" />
              </label>
            </div>
          </div>
        </section>

        <section className={cs.panel}>
          <div className={cs.panelBody}>
            {!mounted || !address ? (
              <p className={styles.muted}>Connect your wallet (top right) to start a swarm.</p>
            ) : !quote ? (
              <button type="button" className="ui-btn" data-variant="primary" onClick={check} disabled={busy || !name.trim() || !ticker.trim()}>
                {busy ? 'Checking…' : 'Check'}
              </button>
            ) : (
              <>
                <p className={styles.muted}>{quote.summary}</p>
                {quote.warnings.map((w) => <p key={w} className="ui-hint">{w}</p>)}
                {quote.errors.map((e) => <p key={e} className="ui-error">{e}</p>)}
                <div className={styles.row}>
                  <button type="button" className="ui-btn" data-variant="primary" onClick={start} disabled={busy || !quote.canBroadcast}>
                    {busy ? 'Confirm in wallet…' : 'Start the swarm'}
                  </button>
                </div>
              </>
            )}
            {error && <p className="ui-error">{error}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
