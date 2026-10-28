'use client';

/// One swarm (docs/PLAN-agents-and-swarms.md §4): its vote, pot and stage, read from
/// chain through get_swarm, and the member's buttons (join, vote, leave, claim), each
/// built by swarm_action and sent from the connected wallet. The proposed name, ticker
/// and idea link were written by a stranger: shown as plain text, link only if it is
/// https or ipfs.

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatEther, isAddress } from 'viem';
import { useAccount } from 'wagmi';

import { callTool, ToolCallError, untrustedText, useToolTx, walletErrorText, type ToolTx } from '@/lib/agentToolClient';
import { shortAddr, STAGE_LABEL, timeLeft, trimEth } from '@/lib/swarmUi';
import cs from '../../create/create-studio.module.css';
import styles from '../swarms.module.css';

interface SwarmData {
  vault: string; creator: string; token: string;
  joinDeadline: number; launchDeadline: number; quorumPct: number;
  minPool: string; maxPool: string; minDeposit: string; pool: string; approvedEth: string;
  passed: boolean; joined: boolean; batchClaimed: boolean; creatorLaunched: boolean;
  stage: string; status: string;
  member: null | { deposit: string; approved: boolean; withdrawn: boolean; share: { tokens: string; eth: string } };
}

const eth = (wei: string) => trimEth(formatEther(BigInt(wei)));
const safeLink = (u: string) => (/^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(u) ? (u.startsWith('ipfs://') ? `/api/ipfs/${u.slice(7)}` : u) : null);

export default function SwarmPage({ params }: { params: Promise<{ vault: string }> }) {
  const raw = use(params).vault;
  const valid = isAddress(raw);
  const { address } = useAccount();
  const qc = useQueryClient();
  const send = useToolTx();
  const [amount, setAmount] = useState('0.01');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['swarm', raw, address],
    queryFn: () => callTool<SwarmData>('get_swarm', { vault: raw, ...(address ? { member: address } : {}) }),
    enabled: valid,
    refetchInterval: 15_000,
    retry: (n, e) => !(e instanceof ToolCallError && (e.status === 404 || e.status === 409)) && n < 2,
  });

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!address) return setError('Connect your wallet first.');
    setError(null);
    setBusy(action);
    try {
      const { data } = await callTool<{ transactions: ToolTx[]; errors: string[]; canBroadcast: boolean }>('swarm_action', { vault: raw, member: address, action, ...extra });
      if (!data.canBroadcast) throw new Error(data.errors.join(' '));
      for (const tx of data.transactions) await send(tx);
      await qc.invalidateQueries({ queryKey: ['swarm', raw] });
    } catch (e) {
      setError(walletErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!valid || (q.error instanceof ToolCallError && q.error.status === 404)) {
    return (
      <div className={cs.studio}>
        <p className={styles.muted}>That isn&apos;t a swarm. <Link href="/swarms">See all swarms</Link>.</p>
      </div>
    );
  }
  if (q.error instanceof ToolCallError && q.error.status === 409) {
    return (
      <div className={cs.studio}>
        <p className={styles.muted}>Swarm launches are coming soon.</p>
      </div>
    );
  }
  if (!q.data) return <div className={cs.studio}><p className={styles.muted}>{q.isError ? 'Couldn’t load this swarm. Try again in a moment.' : 'Loading…'}</p></div>;

  const s = q.data.data;
  const name = untrustedText(q.data, 'name');
  const ticker = untrustedText(q.data, 'ticker');
  const pool = BigInt(s.pool);
  const yesPct = pool > 0n ? Number((BigInt(s.approvedEth) * 10_000n) / pool) / 100 : 0;
  const minPool = BigInt(s.minPool);
  const fillPct = minPool > 0n ? Math.min(100, Number((pool * 100n) / minPool)) : 100;
  const m = s.member;
  const inPot = m && BigInt(m.deposit) > 0n;
  const isCreator = !!address && address.toLowerCase() === s.creator.toLowerCase();
  const open = s.stage === 'joining';

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>Swarm · {STAGE_LABEL[s.stage] ?? s.stage}</p>
          <h1 className={cs.pageTitle}>{name || shortAddr(s.vault)}</h1>
          <p className={cs.pageLede}>
            {ticker && <>${ticker} · </>}launched by <Link href={`/profile/${s.creator}`}>{shortAddr(s.creator)}</Link>. {s.status}
          </p>
        </div>
      </header>

      <div className={styles.layout}>
        <div className={styles.stack}>
          <section className={cs.panel}>
            <div className={cs.panelHead}><h2 className={cs.panelTitle}>The pot</h2></div>
            <div className={cs.panelBody}>
              <div className={styles.stats}>
                <div className={styles.stat}><span className={styles.statLabel}>Pooled</span><span className={styles.statValue}>{eth(s.pool)} ETH</span></div>
                <div className={styles.stat}><span className={styles.statLabel}>Voted yes</span><span className={styles.statValue}>{yesPct}% / {s.quorumPct}%</span></div>
                <div className={styles.stat}><span className={styles.statLabel}>Vote closes</span><span className={styles.statValue}>{timeLeft(s.joinDeadline)}</span></div>
                <div className={styles.stat}><span className={styles.statLabel}>Launch by</span><span className={styles.statValue}>{timeLeft(s.launchDeadline)}</span></div>
              </div>
              <div>
                <span className={styles.statLabel}>Towards the smallest pot ({eth(s.minPool)} ETH)</span>
                <div className={styles.bar}><div className={styles.barFill} style={{ width: `${fillPct}%` }} /></div>
              </div>
              {s.creatorLaunched && (
                <p className={styles.muted}>The coin is launched: <Link href={`/trade/${s.token}`}>open its trade page</Link>.</p>
              )}
            </div>
          </section>

          <section className={cs.panel}>
            <div className={cs.panelHead}><h2 className={cs.panelTitle}>You</h2></div>
            <div className={cs.panelBody}>
              {!address ? (
                <p className={styles.muted}>Connect your wallet (top right) to join.</p>
              ) : (
                <>
                  <p className={styles.muted}>
                    {inPot
                      ? <>You have <b>{eth(m!.deposit)} ETH</b> in the pot{m!.approved ? ' and voted yes.' : ' and have not voted yes.'}</>
                      : 'You are not in this swarm.'}
                  </p>
                  {open && (
                    <div className={styles.row}>
                      <input className="ui-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" style={{ maxWidth: 140 }} aria-label="ETH to put in" />
                      <button type="button" className="ui-btn" data-variant="primary" disabled={!!busy || !/^\d*\.?\d+$/.test(amount)} onClick={() => act('join', { ethIn: amount })}>
                        {busy === 'join' ? 'Confirm in wallet…' : 'Put in ETH'}
                      </button>
                      {inPot && !m!.approved && (
                        <button type="button" className="ui-btn" disabled={!!busy} onClick={() => act('approve')}>{busy === 'approve' ? 'Confirm…' : 'Vote yes'}</button>
                      )}
                      {inPot && m!.approved && (
                        <button type="button" className="ui-btn" data-variant="ghost" disabled={!!busy} onClick={() => act('unapprove')}>{busy === 'unapprove' ? 'Confirm…' : 'Take back my vote'}</button>
                      )}
                    </div>
                  )}
                  {inPot && !s.joined && (
                    <div className={styles.row}>
                      <button type="button" className="ui-btn" data-variant="ghost" disabled={!!busy} onClick={() => act('leave')}>
                        {busy === 'leave' ? 'Confirm…' : `Leave and take back ${eth(m!.deposit)} ETH`}
                      </button>
                    </div>
                  )}
                  {inPot && s.joined && !m!.withdrawn && (
                    <div className={styles.row}>
                      <button type="button" className="ui-btn" data-variant="primary" disabled={!!busy} onClick={() => act('claim')}>
                        {busy === 'claim' ? 'Confirm…' : 'Collect my share'}
                      </button>
                    </div>
                  )}
                  {m?.withdrawn && <p className={styles.muted}>You collected your share.</p>}
                  {s.stage === 'ready_to_join_batch' && (
                    <div className={styles.row}>
                      <button type="button" className="ui-btn" disabled={!!busy} onClick={() => act('join_batch')}>
                        {busy === 'join_batch' ? 'Confirm…' : 'Put the pot into the launch now'}
                      </button>
                    </div>
                  )}
                </>
              )}
              {error && <p className="ui-error">{error}</p>}
            </div>
          </section>

          {isCreator && !s.creatorLaunched && (
            <section className={cs.panel}>
              <div className={cs.panelHead}><h2 className={cs.panelTitle}>You are the creator</h2></div>
              <div className={cs.panelBody}>
                <p className={styles.muted}>
                  Launch on the <Link href="/create/fair">Fair lane</Link> with exactly this name and ticker, after the vote closes ({timeLeft(s.joinDeadline)}) and
                  before {new Date(s.launchDeadline * 1000).toLocaleString()}. The pot joins your launch automatically within seconds.
                </p>
              </div>
            </section>
          )}
        </div>

        <aside className={styles.stack}>
          <section className={cs.panel}>
            <div className={cs.panelHead}><h2 className={cs.panelTitle}>How it works</h2></div>
            <div className={cs.panelBody}>
              <p className={styles.muted}>Put in ETH and vote yes if you want it to go ahead. You can leave and take it all back until the pot joins the launch.</p>
              <p className={styles.muted}>If {s.quorumPct}% of the pot votes yes and it reaches {eth(s.minPool)} ETH, the whole pot goes in, including members who did not vote yes. Leave before then if you change your mind.</p>
              <p className={styles.muted}>The pot buys at the same opening price as everyone else. Afterwards each member collects their share of the coins and any refund.</p>
              {(() => {
                const idea = untrustedText(q.data, 'idea');
                const href = idea ? safeLink(idea) : null;
                return href ? <p className={styles.muted}><a href={href} target="_blank" rel="noopener noreferrer nofollow">The proposer&apos;s idea ↗</a> (written by them, not urufu)</p> : null;
              })()}
              <p className={styles.addr}>Vault {s.vault}</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

