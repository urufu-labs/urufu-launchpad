'use client';

/// "Launch an agent" (docs/PLAN-agents-and-swarms.md 3.2): one page for the owner to
/// set up an agent account, optionally launch the agent's own Fair coin, and
/// optionally give its wallet the Agent badge. Every step is built by the agent API
/// (setup_agent_account, launch_agent_token, register_agent) and signed or sent by
/// the owner's own wallet; nothing here holds a key.
///
/// The badge needs one signature from the AGENT's wallet, which the owner's browser
/// usually doesn't have: the page shows the message, the agent signs it with its own
/// tools, and the owner pastes the signature back.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isAddress, type Address, type Hex } from 'viem';
import { useAccount, useChainId, usePublicClient, useSendTransaction, useSignTypedData, useSwitchChain } from 'wagmi';

import cs from '../../create/create-studio.module.css';
import styles from '../../profile/profile.module.css';
import agentStyles from '../agent.module.css';

const CHAIN_ID = 4663;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface ToolTx { step: number; purpose: string; to: Address; data: Hex; value: string; valueFormatted: string; summary: string }

async function callTool<T>(tool: string, input: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/agent/v2/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: { message?: string } };
  if (!res.ok || !body.data) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  return body.data;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errText = (e: unknown) => {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return /rejected|denied/i.test(m) ? 'You cancelled it in your wallet.' : m;
};

/// Saved per owner in this browser so a reload resumes the setup where it stopped.
interface SavedAccount { agent: Address; safe: Address; roles: Address; tokenList: string; txs: ToolTx[]; sent: number; total: number }

const storeKey = (owner: string) => `urufu-agent-setup:${owner.toLowerCase()}`;
function loadSaved(owner: string): SavedAccount | null {
  try {
    const raw = localStorage.getItem(storeKey(owner));
    return raw ? (JSON.parse(raw) as SavedAccount) : null;
  } catch {
    return null;
  }
}
function save(owner: string, v: SavedAccount | null) {
  try {
    if (v) localStorage.setItem(storeKey(owner), JSON.stringify(v));
    else localStorage.removeItem(storeKey(owner));
  } catch { /* private window: the page still works, it just won't remember */ }
}

/// Sends `txs` one at a time from the connected wallet, waiting for each to confirm.
function useTxRunner() {
  const { sendTransactionAsync } = useSendTransaction();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  return async (tx: ToolTx) => {
    if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID });
    const hash = await sendTransactionAsync({ chainId: CHAIN_ID, to: tx.to, data: tx.data, value: BigInt(tx.value) });
    const receipt = await client!.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction failed on chain.');
    return receipt;
  };
}

export default function LaunchAgentPage() {
  const { address: owner } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>Launch · Agent</p>
          <h1 className={cs.pageTitle}>Launch an agent</h1>
          <p className={cs.pageLede}>
            Give an AI agent its own account with spending limits set on chain, a coin of its own if you want one, and the
            Agent badge. You sign every step from your wallet. See <Link href="/docs#agents">Using an AI agent</Link> first.
          </p>
        </div>
      </header>
      {!mounted || !owner ? (
        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <p className={styles.hiddenCopy}>Connect your wallet (top right) to start. It becomes the owner of the agent account.</p>
          </div>
        </section>
      ) : (
        <Steps owner={owner} />
      )}
    </div>
  );
}

function Steps({ owner }: { owner: Address }) {
  const [account, setAccount] = useState<SavedAccount | null>(null);
  useEffect(() => { setAccount(loadSaved(owner)); }, [owner]);
  const update = (v: SavedAccount | null) => { setAccount(v); save(owner, v); };
  const ready = !!account && account.sent >= account.total;

  return (
    <div className={agentStyles.steps}>
      <AccountStep owner={owner} account={account} onChange={update} />
      <CoinStep owner={owner} account={ready ? account : null} onListed={(tokenList) => account && update({ ...account, tokenList })} />
      <BadgeStep owner={owner} defaultAgent={account?.agent} />
    </div>
  );
}

// ---------------------------------------------------------------- 1. account

function AccountStep({ owner, account, onChange }: { owner: Address; account: SavedAccount | null; onChange: (v: SavedAccount | null) => void }) {
  const [agent, setAgent] = useState('');
  const [dailyEth, setDailyEth] = useState('0.25');
  const [perTradeEth, setPerTradeEth] = useState('0.05');
  const [fundEth, setFundEth] = useState('0.3');
  const txs = account && account.sent < account.total ? account.txs : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useTxRunner();

  const prepare = async () => {
    setError(null);
    if (!isAddress(agent)) return setError('Enter the agent’s wallet address.');
    setBusy(true);
    try {
      const d = await callTool<{ safe: Address; roles: Address; tokenList: string; transactions: ToolTx[] }>('setup_agent_account', { owner, agent, dailyEth, perTradeEth, fundEth });
      onChange({ agent: agent as Address, safe: d.safe, roles: d.roles, tokenList: d.tokenList, txs: d.transactions, sent: 0, total: d.transactions.length });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const sendNext = async () => {
    if (!txs || !account) return;
    setError(null);
    setBusy(true);
    try {
      await run(txs[account.sent]!);
      onChange({ ...account, sent: account.sent + 1 });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const done = !!account && account.sent >= account.total;

  return (
    <section className={cs.panel}>
      <PanelHead step="01" title="Agent account" />
      <div className={cs.panelBody}>
        {done ? (
          <>
            <p className={styles.hiddenCopy}>
              Ready. The agent’s account is <Link href={`/agent/${account.safe}`}>{short(account.safe)}</Link> and it can trade with{' '}
              <span className={styles.num}>{short(account.agent)}</span>. Give your agent the account and limits module addresses:
            </p>
            <p className={styles.num} style={{ wordBreak: 'break-all' }}>safe {account.safe}<br />roles {account.roles}</p>
            <button type="button" className="ui-btn" data-variant="ghost" data-size="sm" onClick={() => onChange(null)}>Set up another</button>
          </>
        ) : (
          <>
            <p className={styles.hiddenCopy}>
              The money sits in a Safe that only you own. The agent uses its own wallet and can only trade urufu coins, within the limits below.
            </p>
            <label className="ui-field">
              <span className="ui-field-label">Agent’s wallet address</span>
              <input className="ui-input" value={txs ? account!.agent : agent} onChange={(e) => setAgent(e.target.value.trim())} placeholder="0x… (not your own wallet)" disabled={!!txs} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <label className="ui-field">
                <span className="ui-field-label">Max per trade (ETH)</span>
                <input className="ui-input" value={perTradeEth} onChange={(e) => setPerTradeEth(e.target.value)} inputMode="decimal" disabled={!!txs} />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Max per day (ETH)</span>
                <input className="ui-input" value={dailyEth} onChange={(e) => setDailyEth(e.target.value)} inputMode="decimal" disabled={!!txs} />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Put in now (ETH)</span>
                <input className="ui-input" value={fundEth} onChange={(e) => setFundEth(e.target.value)} inputMode="decimal" disabled={!!txs} />
              </label>
            </div>
            {!txs ? (
              <button type="button" className="ui-btn" data-variant="primary" onClick={prepare} disabled={busy}>
                {busy ? 'Preparing…' : 'Prepare'}
              </button>
            ) : (
              <>
                <TxList txs={txs} sent={account?.sent ?? 0} busy={busy} onSend={sendNext} />
                {account!.sent === 0 && (
                  <div>
                    <button type="button" className="ui-btn" data-variant="ghost" data-size="sm" onClick={() => onChange(null)} disabled={busy}>Change the details</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {error && <p className="ui-error">{error}</p>}
      </div>
    </section>
  );
}

/// Short titles for the setup txs (by the tool's `purpose`); the tool's own summary,
/// with addresses shortened, is the line under each.
const TX_TITLES: Record<string, string> = {
  createSafe: 'Create the Safe',
  deployRoles: 'Add the limits module',
  armPolicy: 'Turn on the limits',
  fund: 'Put in ETH',
};
const shortenAddresses = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a));

function TxList({ txs, sent, busy, onSend }: { txs: ToolTx[]; sent: number; busy: boolean; onSend: () => void }) {
  return (
    <ol className={agentStyles.txList}>
      {txs.map((t, i) => {
        const state = i < sent ? 'done' : i === sent ? 'next' : 'later';
        return (
          <li key={t.step} className={agentStyles.txRow} data-state={state}>
            <span className={agentStyles.txNum}>{i < sent ? '✓' : i + 1}</span>
            <div className={agentStyles.txText}>
              <span className={agentStyles.txTitle}>{TX_TITLES[t.purpose] ?? t.purpose}</span>
              <span className={agentStyles.txDesc}>{shortenAddresses(t.summary)}</span>
            </div>
            <div className={agentStyles.txAction}>
              {state === 'done' && <span className="ui-badge" data-tone="ok">Done</span>}
              {state === 'next' && (
                <button type="button" className="ui-btn" data-variant="primary" data-size="sm" onClick={onSend} disabled={busy}>
                  {busy ? 'Confirm in wallet…' : BigInt(t.value) > 0n ? `Send ${t.valueFormatted}` : 'Send'}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- 2. coin

interface LaunchQuote { transactions: ToolTx[]; tokenList: string; predicted: { token: Address }; errors: string[]; warnings: string[]; canBroadcast: boolean; summary: string; creatorFeeRule: string }

function CoinStep({ owner, account, onListed }: { owner: Address; account: SavedAccount | null; onListed: (tokenList: string) => void }) {
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [depositEth, setDepositEth] = useState('0.05');
  const [quote, setQuote] = useState<LaunchQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Address | null>(null);
  const run = useTxRunner();

  const prepare = async () => {
    if (!account) return;
    setError(null);
    setBusy(true);
    try {
      setQuote(await callTool<LaunchQuote>('launch_agent_token', {
        owner, safe: account.safe, roles: account.roles, name, ticker, depositEth,
        ...(account.tokenList ? { listedTokens: account.tokenList } : {}),
      }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!quote) return;
    setError(null);
    setBusy(true);
    try {
      await run(quote.transactions[0]!);
      setLaunched(quote.predicted.token);
      onListed(quote.tokenList);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={cs.panel}>
      <PanelHead step="02" title="Its own coin" aside="Optional" />
      <div className={cs.panelBody}>
        {!account ? (
          <p className={styles.hiddenCopy}>Finish step 1 first.</p>
        ) : launched ? (
          <p className={styles.hiddenCopy}>
            Launched. <Link href={`/trade/${launched}`}>Open its trade page</Link>. The creator fee goes to the agent’s account while it keeps holding.
          </p>
        ) : (
          <>
            <p className={styles.hiddenCopy}>
              A Fair lane coin with the agent’s account as creator, paid from the account. The agent can buy it and collect its fees but can never sell
              or move it, because on the Fair lane the creator fee is burned for good if the creator sells.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <label className="ui-field">
                <span className="ui-field-label">Name</span>
                <input className="ui-input" value={name} onChange={(e) => { setName(e.target.value); setQuote(null); }} maxLength={64} />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Ticker</span>
                <input className="ui-input" value={ticker} onChange={(e) => { setTicker(e.target.value.toUpperCase()); setQuote(null); }} maxLength={16} />
              </label>
              <label className="ui-field">
                <span className="ui-field-label">Its first buy (ETH)</span>
                <input className="ui-input" value={depositEth} onChange={(e) => { setDepositEth(e.target.value); setQuote(null); }} inputMode="decimal" />
              </label>
            </div>
            {!quote ? (
              <button type="button" className="ui-btn" data-variant="primary" onClick={prepare} disabled={busy || !name.trim() || !ticker.trim()}>
                {busy ? 'Checking…' : 'Check'}
              </button>
            ) : (
              <>
                <p className={styles.hiddenCopy}>{quote.summary}</p>
                <p className="ui-hint">{quote.creatorFeeRule}</p>
                {quote.warnings.map((w) => <p key={w} className="ui-hint">{w}</p>)}
                {quote.errors.map((e) => <p key={e} className="ui-error">{e}</p>)}
                <button type="button" className="ui-btn" data-variant="primary" onClick={send} disabled={busy || !quote.canBroadcast}>
                  {busy ? 'Waiting for your wallet…' : 'Launch'}
                </button>
              </>
            )}
          </>
        )}
        {error && <p className="ui-error">{error}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 3. badge

interface TypedDataOut { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

function BadgeStep({ owner, defaultAgent }: { owner: Address; defaultAgent?: Address }) {
  const [agent, setAgent] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [walletMsg, setWalletMsg] = useState<{ deadline: number; typedData: TypedDataOut } | null>(null);
  const [pasted, setPasted] = useState('');
  const [phase, setPhase] = useState<'start' | 'sign' | 'link' | 'done'>('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useTxRunner();
  const { signTypedDataAsync } = useSignTypedData();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  useEffect(() => { if (defaultAgent && !agent) setAgent(defaultAgent); }, [defaultAgent, agent]);

  const step = async <T,>(fn: () => Promise<T>) => {
    setError(null);
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const register = () => step(async () => {
    if (!isAddress(agent)) throw new Error('Enter the agent’s wallet address.');
    const d = await callTool<{ transactions: ToolTx[] }>('register_agent', { step: 'register', owner, agentWallet: agent });
    const tx = d.transactions[0]!;
    const receipt = await run(tx);
    // The registry mints the agent NFT to the owner: its id is the Transfer token id.
    const mint = receipt.logs.find((l) => l.address.toLowerCase() === tx.to.toLowerCase() && l.topics[0] === TRANSFER_TOPIC);
    if (!mint?.topics[3]) throw new Error('Registered, but the agent number wasn’t found in the receipt. Check it with verify_tx.');
    const id = BigInt(mint.topics[3]).toString();
    setAgentId(id);
    await newMessage(id);
  });

  const newMessage = async (id = agentId) => {
    const d = await callTool<{ deadline: number; typedData: TypedDataOut }>('register_agent', { step: 'wallet_message', owner, agentWallet: agent, agentId: id });
    setWalletMsg(d);
    setPasted('');
    setPhase('sign');
  };

  const setWallet = () => step(async () => {
    const sig = pasted.trim();
    if (!/^0x[0-9a-fA-F]{130,}$/.test(sig)) throw new Error('Paste the agent’s signature (0x followed by 130 hex characters).');
    const d = await callTool<{ transactions: ToolTx[]; errors: string[] }>('register_agent', { step: 'set_wallet', owner, agentWallet: agent, agentId, deadline: walletMsg!.deadline, signature: sig });
    if (d.errors.length) throw new Error(d.errors.join(' '));
    await run(d.transactions[0]!);
    setPhase('link');
  });

  const link = () => step(async () => {
    const m = await callTool<{ nonce: Hex; expiry: number; name: string; typedData: TypedDataOut }>('register_agent', { step: 'link_message', owner, agentWallet: agent, agentId, name: agentName });
    if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID });
    const signature = await signTypedDataAsync(m.typedData as Parameters<typeof signTypedDataAsync>[0]);
    await callTool('register_agent', { step: 'link', owner, agentWallet: agent, agentId, name: m.name, nonce: m.nonce, expiry: m.expiry, signature });
    setPhase('done');
  });

  return (
    <section className={cs.panel}>
      <PanelHead step="03" title="Agent badge" aside="Optional" />
      <div className={cs.panelBody}>
        {phase === 'done' ? (
          <p className={styles.hiddenCopy}>
            Done. The agent’s wallet now shows an Agent badge linked to you. <Link href={`/profile/${agent}`}>See it</Link>.
          </p>
        ) : (
          <>
            <p className={styles.hiddenCopy}>
              Marks the agent’s wallet as an AI agent run by you, using the public agent registry on Robinhood Chain. You send two transactions and sign
              once; the agent signs once with its own wallet.
            </p>
            <label className="ui-field">
              <span className="ui-field-label">Agent’s wallet address</span>
              <input className="ui-input" value={agent} onChange={(e) => setAgent(e.target.value.trim())} disabled={phase !== 'start'} />
            </label>
            {phase === 'start' && (
              <button type="button" className="ui-btn" data-variant="primary" onClick={register} disabled={busy}>
                {busy ? 'Waiting for your wallet…' : 'Register (1 transaction)'}
              </button>
            )}
            {phase === 'sign' && walletMsg && (
              <>
                <p className={styles.hiddenCopy}>
                  Agent #{agentId} is registered. Now the AGENT must sign this message with its own wallet (eth_signTypedData_v4) before{' '}
                  {new Date(walletMsg.deadline * 1000).toLocaleTimeString()}. Give it to your agent, then paste its signature here.
                </p>
                <textarea className="ui-input" readOnly rows={6} value={JSON.stringify(walletMsg.typedData, null, 2)} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} />
                <button type="button" className="ui-btn" data-size="sm" onClick={() => navigator.clipboard?.writeText(JSON.stringify(walletMsg.typedData)).catch(() => {})}>
                  Copy message
                </button>
                <label className="ui-field">
                  <span className="ui-field-label">Agent’s signature</span>
                  <input className="ui-input" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="ui-btn" data-variant="primary" onClick={setWallet} disabled={busy}>
                    {busy ? 'Waiting for your wallet…' : 'Confirm agent wallet (1 transaction)'}
                  </button>
                  <button type="button" className="ui-btn" data-variant="ghost" onClick={() => step(() => newMessage())} disabled={busy}>
                    New message
                  </button>
                </div>
              </>
            )}
            {phase === 'link' && (
              <>
                <label className="ui-field">
                  <span className="ui-field-label">Name shown on the badge</span>
                  <input className="ui-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={40} />
                </label>
                <button type="button" className="ui-btn" data-variant="primary" onClick={link} disabled={busy || !agentName.trim()}>
                  {busy ? 'Waiting for your wallet…' : 'Sign and finish'}
                </button>
              </>
            )}
          </>
        )}
        {error && <p className="ui-error">{error}</p>}
      </div>
    </section>
  );
}

function PanelHead({ step, title, aside }: { step: string; title: string; aside?: string }) {
  return (
    <div className={cs.panelHead}>
      <h2 className={cs.panelTitle}>
        <span className={cs.panelStep}>{step}</span>
        {title}
      </h2>
      {aside && <span className={cs.panelAside}>{aside}</span>}
    </div>
  );
}
