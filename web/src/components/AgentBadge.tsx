'use client';

/// Agent badge: marks wallets registered as AI agents on urufu (ERC-8004 + owner
/// link, docs/PLAN-agents-and-swarms.md 2.3). One batched lookup per list.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { fetchAgents, type RemoteAgent } from '@/lib/socialApi';

/// Map of lower-cased wallet -> agent record for every agent among `wallets`.
export function useAgentWallets(wallets: string[]): Map<string, RemoteAgent> {
  const key = [...new Set(wallets.map((w) => w.toLowerCase()))].sort();
  const q = useQuery({
    queryKey: ['agents', key.join(',')],
    queryFn: () => fetchAgents(key),
    enabled: key.length > 0,
    staleTime: 60_000,
  });
  return new Map((q.data ?? []).map((a) => [a.agentWallet.toLowerCase(), a]));
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// Small "Agent" pill. With `showOwner`, also links to the owner's profile.
export function AgentBadge({ agent, showOwner = false }: { agent: RemoteAgent; showOwner?: boolean }) {
  const title = `AI agent${agent.name ? ` "${agent.name}"` : ''}, run by ${agent.owner}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="ui-badge" data-tone="info" title={title}>Agent</span>
      {showOwner && (
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          run by <Link href={`/profile/${agent.owner}`}>{short(agent.owner)}</Link>
        </span>
      )}
    </span>
  );
}
