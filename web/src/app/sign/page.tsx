'use client';

/// /sign#<token>: where an AI's prepared transactions get signed. The agent tools
/// add a `signUrl` to every result with transactions; the human opens it, the page
/// checks the link with the server (/api/sign: only links this server made, not
/// expired), shows each step in plain words, and sends them one at a time from the
/// connected wallet. When the tool named a sender, any other wallet is refused.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatEther, type Address, type Hex } from 'viem';
import { useAccount, useChainId, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';

import cs from '../create/create-studio.module.css';
import agentStyles from '../agent/agent.module.css';
import styles from './sign.module.css';

const CHAIN_ID = 4663;
const EXPLORER = 'https://robinhoodchain.blockscout.com';

interface SignTx { to: Address; data: Hex; value: string; purpose: string; summary: string }
interface Payload { tool: string; chainId: number; from: Address | null; summary: string | null; exp: number; txs: SignTx[] }

/// Plain titles for each step, by the tool's `purpose`.
const TITLES: Record<string, string> = {
  approve: 'Allow the URU fee',
  launch: 'Launch the coin',
  launchWithURU: 'Launch the coin (pay in URU)',
  launchAgentToken: "Launch the agent's coin",
  buy: 'Buy',
  sell: 'Sell',
  deposit: 'Put ETH into the opening batch',
  settle: 'Settle the opening batch',
  claim: 'Claim',
  withdrawRefund: 'Take back your refund',
  claimCreatorFees: 'Collect creator fees',
  createSafe: 'Create the Safe',
  deployRoles: 'Add the limits module',
  armPolicy: 'Turn on the limits',
  fund: 'Put in ETH',
  updatePolicy: 'Change the limits',
  revoke: 'Stop the agent',
  agentExec: 'Agent trade',
  register: 'Register the agent',
  setAgentWallet: "Set the agent's wallet",
  createSwarm: 'Create the swarm',
  allowSwarm: 'Let the agent join this swarm',
  removeSwarm: 'Remove the swarm from the agent',
};
const titleFor = (purpose: string) => TITLES[purpose] ?? purpose.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/// Short addresses and readable amounts ("241889.172607182841743029" -> "241,889.1726").
const tidy = (text: string) =>
  text
    .replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a))
    .replace(/\b\d+\.\d{5,}\b/g, (n) => Number(n).toLocaleString('en-US', { maximumSignificantDigits: Math.max(6, n.indexOf('.') + 4) }));
const errText = (e: unknown) => {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return /rejected|denied/i.test(m) ? 'You cancelled it in your wallet.' : m;
};
const eth = (wei: string) => `${formatEther(BigInt(wei))} ETH`;

type Load = { state: 'loading' } | { state: 'empty' } | { state: 'error'; message: string } | { state: 'ready'; payload: Payload };

export default function SignPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!token) return setLoad({ state: 'empty' });
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; payload?: Payload; error?: { message?: string } };
        if (cancelled) return;
        if (!res.ok || !body.payload) return setLoad({ state: 'error', message: body.error?.message ?? 'This link could not be checked.' });
        if (body.payload.chainId !== CHAIN_ID) return setLoad({ state: 'error', message: 'This link is for a different chain.' });
        setLoad({ state: 'ready', payload: body.payload });
      } catch {
        if (!cancelled) setLoad({ state: 'error', message: 'Could not reach urufu to check this link. Try again.' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>AI · Sign</p>
          <h1 className={cs.pageTitle}>Approve in your wallet</h1>
          <p className={cs.pageLede}>
            Your AI prepared this on urufu. Check what it does, then confirm each step in your own wallet. Nothing happens
            until you do.
          </p>
        </div>
      </header>
      <div className={styles.page}>
        {load.state === 'loading' && <section className={cs.panel}><div className={cs.panelBody}><p className={styles.muted}>Checking the link…</p></div></section>}
        {load.state === 'empty' && (
          <section className={cs.panel}>
            <div className={cs.panelBody}>
              <p className={styles.muted}>
                Nothing to sign here. When your AI prepares a trade or launch on urufu, it gives you a link to this page.
                See <Link href="/agent/connect">Connect your AI</Link>.
              </p>
            </div>
          </section>
        )}
        {load.state === 'error' && (
          <section className={cs.panel}>
            <div className={cs.panelBody}>
              <p className="ui-error">{load.message}</p>
              <p className={styles.muted}>Don&apos;t sign anything from a link that fails here. Ask your AI to prepare it again.</p>
            </div>
          </section>
        )}
        {load.state === 'ready' && <Steps payload={load.payload} />}
        <p className={styles.muted}>
          urufu never asks for your private key or seed phrase. If anything does, it is a scam.
        </p>
      </div>
    </div>
  );
}

function Steps({ payload }: { payload: Payload }) {
  const { address } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [sent, setSent] = useState<Hex[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sendTransactionAsync } = useSendTransaction();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const total = payload.txs.reduce((s, t) => s + BigInt(t.value), 0n);
  const wrongWallet = !!(address && payload.from && address.toLowerCase() !== payload.from.toLowerCase());
  const expired = Date.now() > payload.exp;
  const done = sent.length >= payload.txs.length;
  const until = new Date(payload.exp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const sendNext = async () => {
    const tx = payload.txs[sent.length];
    if (!tx) return;
    setError(null);
    setBusy(true);
    try {
      if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID });
      const hash = await sendTransactionAsync({ chainId: CHAIN_ID, to: tx.to, data: tx.data, value: BigInt(tx.value) });
      const receipt = await client!.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction failed on chain. Ask your AI to check it and prepare a fresh one.');
      setSent((s) => [...s, hash]);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={cs.panel}>
      <div className={cs.panelBody}>
        {payload.summary && <p className={styles.summary}>{tidy(payload.summary)}</p>}
        <dl className={styles.facts}>
          <div><dt>Total ETH</dt><dd>{eth(total.toString())}</dd></div>
          <div><dt>Steps</dt><dd>{payload.txs.length}</dd></div>
          {payload.from && <div><dt>Send from</dt><dd className={styles.mono}>{short(payload.from)}</dd></div>}
          <div><dt>Link good until</dt><dd>{until}</dd></div>
        </dl>

        <ol className={agentStyles.txList}>
          {payload.txs.map((t, i) => {
            const state = i < sent.length ? 'done' : i === sent.length ? 'next' : 'later';
            const canSend = state === 'next' && mounted && !!address && !wrongWallet && !expired;
            return (
              <li key={i} className={agentStyles.txRow} data-state={state}>
                <span className={agentStyles.txNum}>{i < sent.length ? '✓' : i + 1}</span>
                <div className={agentStyles.txText}>
                  <span className={agentStyles.txTitle}>{titleFor(t.purpose)}</span>
                  <span className={agentStyles.txDesc}>{tidy(t.summary)}</span>
                  {i < sent.length && (
                    <a className={agentStyles.txDesc} href={`${EXPLORER}/tx/${sent[i]}`} target="_blank" rel="noreferrer">View on explorer ↗</a>
                  )}
                </div>
                <div className={agentStyles.txAction}>
                  {state === 'done' && <span className="ui-badge" data-tone="ok">Done</span>}
                  {canSend && (
                    <button type="button" className="ui-btn" data-variant="primary" data-size="sm" onClick={sendNext} disabled={busy}>
                      {busy ? 'Confirm in wallet…' : BigInt(t.value) > 0n ? `Send ${eth(t.value)}` : 'Send'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {!done && mounted && !address && <p className={styles.muted}>Connect your wallet (top right) to continue.</p>}
        {!done && wrongWallet && (
          <p className="ui-error">
            This was prepared for {short(payload.from!)}, but your wallet is {short(address!)}. Switch to that wallet, or ask your AI
            to prepare it for this one.
          </p>
        )}
        {!done && expired && <p className="ui-error">This link has expired. Ask your AI for a fresh one.</p>}
        {done && (
          <p className={styles.done}>
            All done. Tell your AI it went through, and it can check the result for you.
          </p>
        )}
        {error && <p className="ui-error">{error}</p>}
      </div>
    </section>
  );
}
