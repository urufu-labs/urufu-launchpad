'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatEther } from 'viem';
import { useSignMessage } from 'wagmi';

import { fetchChat, postChat } from '@/lib/socialApi';

// ============================================================================
// Small effects + helpers used by the trade page. Kept here so the page file
// stays focused on data + layout.
// ============================================================================

/// Scrolling ticker of recent trades. Shows "BUY 0.5 ETH → 1.2M SYM ✿ 0x…" style
/// entries colored by side. If no trades yet, shows a friendly filler.
export function TradeTicker({
  trades,
  symbol,
}: {
  trades: Array<{ isBuy: boolean; eth: bigint; tokens: bigint; trader: `0x${string}` }>;
  symbol: string | undefined;
}) {
  const entries = useMemo(() => {
    if (trades.length === 0) {
      return [
        { key: 'idle-1', side: 'buy' as const, text: '~~ waiting for the first ape ~~' },
        { key: 'idle-2', side: 'sell' as const, text: '✿ tap tap launch ~ tap tap launch ✿' },
        { key: 'idle-3', side: 'buy' as const, text: '好き好き大好き ~ trade something!!' },
      ];
    }
    return trades.slice(0, 20).map((t, i) => {
      const eth = Number(formatEther(t.eth));
      const tok = Number(t.tokens) / 1e18;
      const short = `${t.trader.slice(0, 6)}…${t.trader.slice(-4)}`;
      const arrow = t.isBuy ? '→' : '←';
      const label = t.isBuy ? 'aped' : 'dumped';
      const sym = symbol ?? '';
      return {
        key: `trade-${i}-${t.trader}`,
        side: t.isBuy ? ('buy' as const) : ('sell' as const),
        text: `${short} ${label} ${eth.toFixed(4)} ETH ${arrow} ${fmtNum(tok)} ${sym}`,
      };
    });
  }, [trades, symbol]);

  // Duplicate the loop so the marquee wraps seamlessly (translateX(-50%)).
  const loop = [...entries, ...entries];

  return (
    <div className="uru-ticker uru-ticker-wrap" aria-hidden>
      <div className="uru-ticker-track">
        {loop.map((e, i) => (
          <span key={`${e.key}-${i}`} className={e.side === 'buy' ? 'uru-ticker-buy' : 'uru-ticker-sell'}>
            {e.side === 'buy' ? '● ' : '● '}{e.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/// Quick-amount chip row. Emits the picked amount as a decimal string suitable for
/// the input's onChange (so `0.05` stays `"0.05"`, matching typed input semantics).
export function QuickAmounts({
  side,
  walletBal,
  onPick,
}: {
  side: 'buy' | 'sell';
  walletBal: bigint | undefined;
  onPick: (amount: string) => void;
}) {
  if (side === 'buy') {
    const picks = ['0.05', '0.1', '0.5', '1'];
    return (
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        {picks.map((p) => (
          <button key={p} type="button" className="uru-chip" onClick={() => onPick(p)}>
            {p} ETH
          </button>
        ))}
      </div>
    );
  }
  // sell → percentages of wallet balance
  if (walletBal === undefined || walletBal === 0n) return null;
  const picks: Array<[string, number]> = [['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['max', 1]];
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
      {picks.map(([label, pct]) => (
        <button
          key={label}
          type="button"
          className="uru-chip"
          onClick={() => {
            const scaled = (walletBal * BigInt(Math.round(pct * 10_000))) / 10_000n;
            onPick(formatUnitsSafe(scaled, 18));
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/// One-tap copy button for a contract address. Flips label to "copied ✿" for 1.4s.
export function CopyCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — ignore silently */ }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="uru-chip"
      style={{ background: copied ? 'var(--mint)' : undefined }}
      aria-label="copy contract address"
    >
      {copied ? 'copied ✿' : `copy CA ⧉`}
    </button>
  );
}

/// Wraps a numeric display and flashes green/pink when the value ticks.
/// Reads BigInt as-is (comparing big-string is fine for equality).
export function FlashCell({
  value,
  children,
  className = '',
}: {
  value: bigint | number | string | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  const prevRef = useRef<typeof value>(value);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev !== undefined && value !== undefined && prev !== value) {
      const dir = cmp(value, prev) > 0 ? 'up' : 'down';
      setDirection(dir);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setDirection(null), 520);
    }
    prevRef.current = value;
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value]);

  const flashClass = direction === 'up' ? 'uru-flash-up' : direction === 'down' ? 'uru-flash-down' : '';
  return <span className={`${className} ${flashClass}`.trim()}>{children}</span>;
}

// ---------- chat drawer ----------

interface ChatMessage {
  id: string;
  sender: string;       // short wallet like "0x1234…abcd" or "guest_A9F2"
  text: string;
  ts: number;           // ms since epoch
}

const CHAT_MAX = 200;   // cap stored messages per token

function chatKey(tokenAddress: string): string {
  return `uru-chat-${tokenAddress.toLowerCase()}`;
}

function loadChat(tokenAddress: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(chatKey(tokenAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is ChatMessage => m && typeof m.text === 'string');
  } catch { return []; }
}

function saveChat(tokenAddress: string, msgs: ChatMessage[]) {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = msgs.slice(-CHAT_MAX);
    window.localStorage.setItem(chatKey(tokenAddress), JSON.stringify(trimmed));
  } catch { /* quota exceeded — ignore */ }
}

/// Per-token local chat panel. Persists via localStorage keyed by token address.
/// If no wallet connected, users post as a randomised "guest_XXXX". Meant as a
/// dopamine-heavy comment strip below the trade panel — swap the store for a real
/// backend later without touching the UI.
export function ChatDrawer({
  tokenAddress,
  chainId,
  wallet,
  seed,
}: {
  tokenAddress: string;
  /// Required for shared-chat mode. When set, the drawer pulls messages from the
  /// compile-service API + posts new messages there (wallet signature required).
  /// When absent, falls back to browser-local storage — used by MockTradeView / preview.
  chainId?: number;
  wallet?: `0x${string}` | undefined;
  /// Optional seed messages shown once when the store is empty. Used by preview/mock
  /// views to make the chat feel alive on first visit.
  seed?: Array<{ sender: string; text: string; minutesAgo: number }>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // Guest name is generated client-side only after mount so SSR + CSR agree on the first
  // paint (Math.random() would otherwise mismatch and trip Next's hydration checker).
  const [guestName, setGuestName] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const remoteMode = typeof chainId === 'number';
  const { signMessageAsync } = useSignMessage();
  useEffect(() => {
    if (wallet || guestName) return;
    const rand = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
    setGuestName(`guest_${rand}`);
  }, [wallet, guestName]);

  // Initial load + poll for new messages every 8s in remote mode.
  useEffect(() => {
    let cancelled = false;
    const hydrateFromRemote = async () => {
      if (!remoteMode) return;
      const remote = await fetchChat(chainId, tokenAddress as `0x${string}`, 100);
      if (cancelled) return;
      const mapped: ChatMessage[] = remote.map((r) => ({
        id: r.id,
        sender: `${r.senderAddress.slice(0, 6)}…${r.senderAddress.slice(-4)}`,
        text: r.text,
        ts: r.ts * 1000,
      }));
      setMessages(mapped);
    };

    // Local-first paint so the UI isn't blank while the remote fetch is in flight.
    const local = loadChat(tokenAddress);
    if (local.length > 0) {
      setMessages(local);
    } else if (seed && seed.length > 0) {
      const now = Date.now();
      const seeded: ChatMessage[] = seed.map((s, i) => ({
        id: `seed-${i}`,
        sender: s.sender,
        text: s.text,
        ts: now - s.minutesAgo * 60_000,
      }));
      setMessages(seeded);
      if (!remoteMode) saveChat(tokenAddress, seeded);
    }
    hydrateFromRemote();
    const id = remoteMode ? setInterval(hydrateFromRemote, 8_000) : null;
    return () => { cancelled = true; if (id) clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenAddress, chainId]);

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const senderName = wallet
    ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
    : guestName ?? 'guest_…';

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || text.length > 280) return;
    // Optimistic local append so the UI feels instant. Remote mode replaces the local
    // list on next poll with the server's canonical view.
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender: senderName,
      text,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
    setDraft('');

    if (remoteMode && wallet) {
      setPosting(true);
      try {
        await postChat(
          wallet,
          { chainId, tokenAddress: tokenAddress as `0x${string}`, text },
          ({ message }) => signMessageAsync({ message }),
        );
      } catch {
        // Signature declined or network hiccup — leave the optimistic message in the
        // local list so the user doesn't lose their draft, but don't retry silently.
      } finally {
        setPosting(false);
      }
    } else {
      // Offline / guest / preview mode — just persist locally.
      saveChat(tokenAddress, [...messages, msg]);
    }
  };

  return (
    <div className="uru-shell uru-shell-tight">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div className="uru-eyebrow">✿ chat</div>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          {messages.length} msg{messages.length === 1 ? '' : 's'} ~ ur {senderName}
        </span>
      </div>

      <div
        ref={listRef}
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          padding: 6,
          background: 'var(--cream-deep)',
          border: '1.5px dashed var(--anchor)',
          display: 'grid',
          gap: 4,
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 12,
          lineHeight: 1.35,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--anchor-soft)', fontFamily: 'var(--font-pixel), monospace', fontSize: 11 }}>
            no msgs yet ~~ break the silence ✿
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={m.id}
              className={i === messages.length - 1 ? 'uru-slide-in' : ''}
              style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}
            >
              <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--pink-hot)', flexShrink: 0 }}>
                {m.sender}
              </span>
              <span style={{ color: 'var(--anchor)', wordBreak: 'break-word', minWidth: 0 }}>{m.text}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)', flexShrink: 0 }}>
                {formatAgo(m.ts)}
              </span>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input
          className="uru-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder="say something ~"
          maxLength={280}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={send} className="uru-btn uru-btn-primary" style={{ padding: '4px 12px', fontSize: 12 }}>
          send ✿
        </button>
      </div>
    </div>
  );
}

// ---------- helpers ----------

function formatAgo(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}


function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatUnitsSafe(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

function cmp(a: bigint | number | string, b: bigint | number | string): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b ? 0 : a > b ? 1 : -1;
  const na = Number(a), nb = Number(b);
  return na === nb ? 0 : na > nb ? 1 : -1;
}
