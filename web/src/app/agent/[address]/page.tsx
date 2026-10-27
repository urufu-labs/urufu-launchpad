'use client';

/// Agent account page (docs/PLAN-agents-and-swarms.md 3.2): one autonomous agent
/// account, i.e. a Safe guarded by a Roles policy (lib/agentV2/agentPolicy.ts).
///
/// Data sources:
///  - get_agent_profile (agent API): owners, policy module, caps, Safe balance and
///    each Fair token the Safe launched with its creator-fee state. All read live
///    from chain; the indexer only says which tokens to look at.
///  - Ponder indexer: names of those tokens, and the Safe's trade history.

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatEther, formatUnits, isAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { fetchLaunchesByCreator, fetchTradesByTrader, fetchV4SwapsByTrader } from '@/lib/indexer';
import styles from '../../profile/profile.module.css';

interface AgentTokenView {
  token: Address;
  stage: 'batch' | 'curve' | 'graduated';
  safeBalance: string;
  creatorSold: boolean;
  status: string;
  pool: null | {
    floor: string;
    forfeited: boolean;
    fees: { pendingEth: string; claimableEth: string; pendingToken: string; claimableToken: string };
  };
}

interface AgentProfile {
  safe: Address;
  owners: Address[];
  threshold: string | null;
  roles: Address | null;
  policyActive: boolean;
  caps: { perDay: string; perTx: string } | null;
  safeBalance: string;
  forfeitDropBps: number | null;
  tokens: AgentTokenView[];
}

async function fetchAgentProfile(safe: string): Promise<AgentProfile | 'not-found'> {
  const res = await fetch(`/api/agent/v2/get_agent_profile?safe=${safe}`);
  if (res.status === 404) return 'not-found';
  const body = (await res.json()) as { ok?: boolean; data?: AgentProfile; error?: { message?: string } };
  if (!res.ok || !body.data) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

interface HistoryEntry { kind: string; label: string; failed: boolean; txHash: string | null; timestamp: number | null }
interface AgentHistory { fundedEth: string; ownerWithdrewEth: string; ownerSpentEth: string; tokenWithdrawals: Array<{ token: Address; amount: string }>; entries: HistoryEntry[]; complete: boolean }

async function fetchAgentHistory(safe: string): Promise<AgentHistory | null> {
  const res = await fetch(`/api/agent/v2/get_agent_history?safe=${safe}`);
  if (res.status === 404) return null;
  const body = (await res.json()) as { data?: AgentHistory; error?: { message?: string } };
  if (!res.ok || !body.data) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

const EXPLORER = 'https://robinhoodchain.blockscout.com';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: string | bigint) => trim(formatEther(BigInt(wei)));
const tokens = (wei: string | bigint) => Number(formatUnits(BigInt(wei), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });

function trim(v: string): string {
  const [whole, frac = ''] = v.split('.');
  const f = frac.slice(0, 6).replace(/0+$/, '');
  return f ? `${whole}.${f}` : whole;
}

const STAGE: Record<AgentTokenView['stage'], string> = { batch: 'Opening batch', curve: 'On the curve', graduated: 'Uniswap pool' };

export default function AgentPage({ params }: { params: Promise<{ address: string }> }) {
  const raw = use(params).address;
  const valid = isAddress(raw);
  const safe = (valid ? raw : '0x0000000000000000000000000000000000000000') as Address;

  const profile = useQuery({ queryKey: ['agent-profile', safe], queryFn: () => fetchAgentProfile(safe), enabled: valid, staleTime: 15_000 });
  const launches = useQuery({ queryKey: ['agent-launches', safe], queryFn: () => fetchLaunchesByCreator(safe, 40), enabled: valid, staleTime: 60_000 });
  const history = useQuery({ queryKey: ['agent-history', safe], queryFn: () => fetchAgentHistory(safe), enabled: valid, staleTime: 60_000 });
  const trades = useQuery({
    queryKey: ['agent-trades', safe],
    queryFn: async () => {
      const [curve, v4] = await Promise.all([fetchTradesByTrader(safe, 50), fetchV4SwapsByTrader(safe, 50)]);
      const rows = [
        ...(curve ?? []).map((t) => ({ id: t.id, token: t.tokenAddress, isBuy: t.isBuy, eth: t.ethAmount, ts: t.blockTimestamp })),
        ...(v4 ?? []).map((s) => ({ id: s.id, token: s.tokenAddress, isBuy: s.isBuy, eth: s.isBuy ? s.amountIn : s.amountOut, ts: s.blockTimestamp })),
      ];
      return rows.sort((a, b) => Number(BigInt(b.ts) - BigInt(a.ts))).slice(0, 30);
    },
    enabled: valid,
    staleTime: 30_000,
  });

  const names = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of launches.data ?? []) m[l.tokenAddress.toLowerCase()] = l.ticker ? `$${l.ticker}` : l.name;
    return m;
  }, [launches.data]);
  const label = (a: string) => names[a.toLowerCase()] ?? short(a);

  const data = profile.data;
  if (!valid || data === 'not-found') {
    return (
      <div className={styles.badAddress}>
        <Mascot size={72} mood="confused" />
        <h1 className={styles.badTitle}>{valid ? 'Not an agent account' : 'That address isn’t valid'}</h1>
        <p className={styles.badCopy}>
          Agent accounts are Safe wallets set up through the agent tools. See <Link href="/docs#agents">Using an AI agent</Link>.
        </p>
      </div>
    );
  }

  const p: AgentProfile | null = data && data !== 'not-found' ? data : null;
  return (
    <div className={styles.profileFrame}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <p className={styles.eyebrow}>Agent account</p>
          <h1 className={styles.name}>{short(safe)}</h1>
          <div className={styles.addressRow}>
            <span className={styles.address} title={safe}>{safe}</span>
          </div>
          {p && (
            <div className={styles.socials}>
              <span className="ui-badge" data-tone={p.policyActive ? 'info' : undefined}>
                {p.policyActive ? 'Limits on' : 'No agent limits'}
              </span>
              <span className={styles.socialMuted}>
                Owned by{' '}
                {p.owners.map((o, i) => (
                  <span key={o}>
                    {i > 0 && ', '}
                    <Link href={`/profile/${o}`}>{short(o)}</Link>
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      </header>

      {profile.isError && <div className={styles.empty}>Couldn’t load this account right now. Try again in a moment.</div>}
      {profile.isLoading && <div className={styles.empty}>Loading…</div>}

      {p && (
        <>
          <dl className={styles.statGrid}>
            <div className={`ui-stat ${styles.statTile}`}>
              <dt className="ui-label">Balance</dt>
              <dd className="ui-stat-value">{eth(p.safeBalance)} Ξ</dd>
            </div>
            <div className={`ui-stat ${styles.statTile}`}>
              <dt className="ui-label">Max per trade</dt>
              <dd className="ui-stat-value">{p.caps ? `${eth(p.caps.perTx)} Ξ` : '–'}</dd>
            </div>
            <div className={`ui-stat ${styles.statTile}`}>
              <dt className="ui-label">Max per day</dt>
              <dd className="ui-stat-value">{p.caps ? `${eth(p.caps.perDay)} Ξ` : '–'}</dd>
            </div>
            <div className={`ui-stat ${styles.statTile}`}>
              <dt className="ui-label">Own tokens</dt>
              <dd className="ui-stat-value">{p.tokens.length}</dd>
            </div>
          </dl>
          <p className={styles.statNote}>
            {p.policyActive
              ? 'The agent can only trade urufu tokens its owner listed, within these limits, and everything it buys stays in this account. Limits are enforced on chain.'
              : 'This Safe has no agent limits set up. Anything here is controlled by its owners only.'}
          </p>

          <div className={styles.body}>
            <div className={styles.main}>
              <section className={styles.panel}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>Its tokens</h2>
                  <span className={styles.panelCount}>{p.tokens.length}</span>
                </div>
                {p.tokens.length === 0 && <div className={styles.empty}>This agent hasn’t launched a token.</div>}
                {p.tokens.length > 0 && (
                  <ul className={styles.tableList}>
                    {p.tokens.map((t) => (
                      <li key={t.token} className={styles.trow} style={{ display: 'block' }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Link href={`/trade/${t.token}`} className={styles.tokenLink} title={t.token}>{label(t.token)}</Link>
                          <span className="ui-badge">{STAGE[t.stage]}</span>
                          {t.pool?.forfeited && <span className="ui-badge" data-tone="bad">Fee burned</span>}
                        </div>
                        <p className={styles.muted} style={{ margin: '6px 0 0' }}>{t.status}</p>
                        <p className={styles.num} style={{ margin: '4px 0 0' }}>
                          Holds {tokens(t.safeBalance)}
                          {t.pool && !t.pool.forfeited && <> · must stay above {tokens(t.pool.floor)}</>}
                          {t.pool && (
                            <> · fees ready {eth(t.pool.fees.claimableEth)} Ξ, waiting {eth(t.pool.fees.pendingEth)} Ξ</>
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>Money in and out</h2>
                </div>
                {history.isLoading && <div className={styles.empty}>Loading…</div>}
                {history.isError && <div className={styles.empty}>Couldn’t load this right now.</div>}
                {history.data && (
                  <>
                    <p className={styles.statNote}>
                      Put in <span>{eth(history.data.fundedEth)} ETH</span>. The owner took out <span>{eth(history.data.ownerWithdrewEth)} ETH</span>
                      {history.data.tokenWithdrawals.length > 0 && <> and moved out {history.data.tokenWithdrawals.length} kind(s) of token</>}
                      {BigInt(history.data.ownerSpentEth) > 0n && <>, and spent <span>{eth(history.data.ownerSpentEth)} ETH</span> directly</>}.
                      {!history.data.complete && ' Only recent history is shown.'}
                    </p>
                    {history.data.entries.length === 0 ? (
                      <div className={styles.empty}>Nothing yet.</div>
                    ) : (
                      <ul className={styles.tableList}>
                        {history.data.entries.map((e, i) => (
                          <li key={`${e.txHash}-${i}`} className={`${styles.trow} ${styles.activityCols}`}>
                            <span className={styles.cell} style={{ gridColumn: 'span 3' }}>
                              {e.label}
                              {e.failed && <> <span className="ui-badge" data-tone="bad">Failed</span></>}
                              {e.kind === 'withdrew_eth' || e.kind === 'withdrew_token' ? <> <span className="ui-badge" data-tone="warn">Owner</span></> : null}
                            </span>
                            <span className={`${styles.num} ${styles.right} ${styles.muted}`}>
                              {e.txHash ? (
                                <a href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">
                                  {e.timestamp ? new Date(e.timestamp * 1000).toLocaleDateString() : 'tx'}
                                </a>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>Trades</h2>
                  <span className={styles.panelCount}>{trades.data?.length ?? 0}</span>
                </div>
                {trades.isLoading && <div className={styles.empty}>Loading…</div>}
                {trades.data && trades.data.length === 0 && <div className={styles.empty}>No trades yet.</div>}
                {trades.data && trades.data.length > 0 && (
                  <ul className={styles.tableList}>
                    {trades.data.map((t) => (
                      <li key={t.id} className={`${styles.trow} ${styles.activityCols}`}>
                        <span className={styles.cell}>
                          <Link href={`/trade/${t.token}`} className={styles.tokenLink} title={t.token}>{label(t.token)}</Link>
                        </span>
                        <span className={t.isBuy ? styles.sideBuy : styles.sideSell}>{t.isBuy ? 'Buy' : 'Sell'}</span>
                        <span className={`${styles.num} ${styles.right}`}>{eth(t.eth)} Ξ</span>
                        <span className={`${styles.num} ${styles.right} ${styles.muted}`}>{new Date(Number(t.ts) * 1000).toLocaleDateString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <aside className={styles.side}>
              <section className={styles.panel}>
                <div className={styles.panelHead}>
                  <h2 className={styles.panelTitle}>How this works</h2>
                </div>
                <div className={styles.panelBody}>
                  <p className={styles.hiddenCopy}>
                    The money sits in a Safe that only its owner controls. The agent has its own key and can only do what the owner allowed.
                  </p>
                  <p className={styles.hiddenCopy}>
                    It can never sell or move its own token. On the Fair lane the creator fee is burned for good if the creator’s holdings drop more than {p.forfeitDropBps !== null ? `${p.forfeitDropBps / 100}%` : 'the lane allows'}.
                  </p>
                  {p.roles && (
                    <p className={styles.hiddenCopy}>
                      Limits module <span className={styles.num} title={p.roles}>{short(p.roles)}</span>
                    </p>
                  )}
                </div>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
