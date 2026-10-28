'use client';

/// Swarm launches (docs/PLAN-agents-and-swarms.md §4): the newest swarms, read from
/// chain through the agent API's list_swarms. Names, tickers and idea links were
/// written by strangers: they are shown as plain text only.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { callTool, ToolCallError } from '@/lib/agentToolClient';
import { shortAddr as short, STAGE_LABEL, timeLeft } from '@/lib/swarmUi';
import cs from '../create/create-studio.module.css';
import styles from './swarms.module.css';

interface SwarmItem {
  vault: string;
  creator: string;
  joinDeadline: number;
  launchDeadline: number;
  quorumPct: number;
  minPool: string;
  pool: string;
  poolFormatted: string;
  stage: string;
  untrusted: { fields: Record<string, { text: string | null }> };
}

export default function SwarmsPage() {
  const q = useQuery({
    queryKey: ['swarms'],
    queryFn: async () => (await callTool<{ swarms: SwarmItem[] }>('list_swarms', {})).data.swarms,
    staleTime: 30_000,
    retry: (n, e) => !(e instanceof ToolCallError && e.status === 409) && n < 2,
  });
  const notLive = q.error instanceof ToolCallError && q.error.status === 409;

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>Launch · Swarm</p>
          <h1 className={cs.pageTitle}>Swarm launches</h1>
          <p className={cs.pageLede}>
            Pool ETH with other people (or AI agents) to back a coin at launch. If the vote passes, the pot buys in at the same opening price as
            everyone else and each member gets their share. If it doesn&apos;t go ahead, everyone takes their ETH back.
          </p>
        </div>
        {!notLive && (
          <Link href="/swarms/new" className="ui-btn" data-variant="primary">
            Start a swarm
          </Link>
        )}
      </header>

      {notLive && (
        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <p className={styles.muted}>Swarm launches are coming soon.</p>
          </div>
        </section>
      )}
      {q.isLoading && <p className={styles.muted}>Loading…</p>}
      {q.isError && !notLive && <p className={styles.muted}>Couldn&apos;t load swarms right now. Try again in a moment.</p>}
      {q.data && q.data.length === 0 && (
        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <p className={styles.muted}>No swarms yet. Start the first one.</p>
          </div>
        </section>
      )}
      {q.data && q.data.length > 0 && (
        <div className={styles.grid}>
          {q.data.map((s) => {
            const name = s.untrusted.fields.name?.text ?? '';
            const ticker = s.untrusted.fields.ticker?.text ?? '';
            const open = s.stage === 'joining';
            return (
              <Link key={s.vault} href={`/swarms/${s.vault}`} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.cardName}>{name || short(s.vault)}</span>
                  <span className="ui-badge" data-tone={open ? 'ok' : s.stage === 'failed' || s.stage === 'closed' ? undefined : 'info'}>
                    {STAGE_LABEL[s.stage] ?? s.stage}
                  </span>
                </div>
                {ticker && <span className={styles.ticker}>${ticker}</span>}
                <div className={styles.cardStats}>
                  <span>
                    <b>{Number(s.poolFormatted.replace(' ETH', '')).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH</b> pooled
                  </span>
                  <span>{open ? timeLeft(s.joinDeadline) : `${s.quorumPct}% to pass`}</span>
                </div>
                <span className={styles.muted}>Launched by {short(s.creator)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
