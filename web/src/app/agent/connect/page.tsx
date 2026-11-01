'use client';

/// "Connect your AI": per-app steps for adding the urufu MCP server
/// (https://urufulabs.xyz/api/mcp), a first prompt, and ready-made prompts with copy
/// buttons. Steps per app were checked against each app's own help pages on
/// 2026-11-01; "Any other app" covers the rest (MCP or the skill file).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import cs from '../../create/create-studio.module.css';
import styles from './connect.module.css';

const MCP_URL = 'https://urufulabs.xyz/api/mcp';
const SKILL_URL = 'https://urufulabs.xyz/agent-skill.md';

interface App {
  id: string;
  label: string;
  plan: string;
  steps: React.ReactNode[];
  copy?: { label: string; text: string };
}

const APPS: App[] = [
  {
    id: 'claude',
    label: 'Claude',
    plan: 'Works on every plan. Free accounts get one custom connector.',
    steps: [
      <>Open <b>Customize → Connectors</b> on claude.ai.</>,
      <>Click <b>+ Add</b>, then <b>Add custom connector</b>.</>,
      <>Name it <b>urufu</b>, paste the link below, and click <b>Continue</b>.</>,
      <>Under Authentication pick <b>No sign in</b>, then click <b>Add</b>.</>,
      <>In a chat, click <b>+ → Connectors</b> and switch urufu on.</>,
    ],
    copy: { label: 'Connector link', text: MCP_URL },
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    plan: 'Run this once in your terminal.',
    steps: [
      <>Run the command below.</>,
      <>Check it with <b>/mcp</b> inside Claude Code. urufu should say connected.</>,
    ],
    copy: { label: 'Command', text: `claude mcp add --transport http urufu ${MCP_URL}` },
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    plan: 'Custom connectors are on ChatGPT Business and Enterprise (web). On a workspace, an admin may need to add it.',
    steps: [
      <>Open <b>Plugins</b>.</>,
      <>Click <b>+</b>, then <b>Add custom MCP server</b>.</>,
      <>Name it <b>urufu</b> and paste the link below under Connection.</>,
      <>Set authentication to <b>none</b>, tick the risk box, and click <b>Create as a plugin</b>.</>,
      <>In a chat, type <b>@</b> and pick urufu.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'grok',
    label: 'Grok',
    plan: 'Connectors are on every Grok plan. On Grok Business, an admin adds it first.',
    steps: [
      <>Go to <b>grok.com/connectors</b>.</>,
      <>Click <b>New Connector</b>, then <b>Custom</b>.</>,
      <>Paste the link below and save. Grok finds the urufu tools by itself.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'grok-bot',
    label: 'Grok Bot',
    plan: 'Included with Grok Premium, Super, Ultra, Teams and Enterprise. Grok Bot uses the same connectors as Cursor and can run routines on a schedule.',
    steps: [
      <>Open Grok Bot on your desktop or phone.</>,
      <>Add a custom MCP server with the link below, the same way you would in Cursor.</>,
      <>Ask it to read the urufu guide once so it knows the rules: <b>{SKILL_URL}</b></>,
      <>Give it a routine, like the Monday check-in below.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    plan: 'Remote connectors are added from Plugins.',
    steps: [
      <>Open <b>Plugins</b> in the sidebar.</>,
      <>Click <b>Add custom</b> and add a remote connector with the link below.</>,
      <>On the home page, switch urufu on under <b>Sources</b>.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    plan: 'Add it to ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).',
    steps: [
      <>Open or create <b>~/.cursor/mcp.json</b>.</>,
      <>Paste the block below and save.</>,
      <>Restart Cursor.</>,
    ],
    copy: { label: 'mcp.json', text: JSON.stringify({ mcpServers: { urufu: { url: MCP_URL } } }, null, 2) },
  },
  {
    id: 'other',
    label: 'Any other app',
    plan: 'Any app that can add an MCP server by link works. If yours can only read web pages, give it the guide instead.',
    steps: [
      <>If it supports MCP, add this server: <b>{MCP_URL}</b></>,
      <>If not, paste the line below into a chat. It tells your AI how to use urufu.</>,
    ],
    copy: { label: 'First message', text: `Read ${SKILL_URL} and follow it to help me use urufu on Robinhood Chain.` },
  },
];

interface Prompt { title: string; text: (w: string) => string; note?: string }

const START: Prompt = {
  title: 'Get started',
  text: (w) => `Using urufu, show me what my wallet ${w} holds and what each coin is worth in ETH. Then tell me what else you can do for me on urufu.`,
};

const PROMPTS: Prompt[] = [
  {
    title: 'Check a coin before you buy',
    text: () => 'Look up this urufu coin: [paste the coin link]. Show its price, how close it is to graduating, its top holders and recent trades, and tell me anything that looks risky.',
  },
  {
    title: 'Buy with a price limit',
    text: () => 'Get me a quote on urufu to buy 0.01 ETH of [paste the coin link]. Show me how many coins I get and the price limit, and wait for my yes before anything is signed.',
  },
  {
    title: 'Take profit',
    text: (w) => `Using urufu, check the coins in ${w}. For any coin worth more than 0.05 ETH, get me a quote to sell half and show me what I would get.`,
  },
  {
    title: 'Launch a coin',
    text: () => 'Launch a coin on urufu called [name] with the ticker [TICKER] using the Fair launch. Show me the fees and every step I need to sign before we start.',
  },
  {
    title: 'Collect creator fees',
    text: (w) => `Check if ${w} has creator fees waiting on urufu, tell me how much, and prepare the claim.`,
  },
  {
    title: 'Join a swarm',
    text: () => 'List the open swarms on urufu. For each one, tell me the coin, how much is in the pot, and when the vote ends. Then help me join the one I pick.',
  },
  {
    title: 'Monday check-in',
    text: (w) => `Every Monday morning, show me what my urufu coins in ${w} are worth in ETH, biggest first, and flag any coin that is close to graduating.`,
    note: 'Needs an app that runs tasks on a schedule, like Grok Bot routines.',
  },
  {
    title: 'Graduation watch',
    text: () => 'Check this urufu coin every hour: [paste the coin link]. Tell me when it is over 90% of the way to graduating.',
    note: 'Needs an app that runs tasks on a schedule.',
  },
];

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch { /* clipboard blocked: the text is still selectable */ }
  };
  return (
    <button type="button" className="ui-btn" data-variant="ghost" data-size="sm" onClick={copy} aria-label="Copy">
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function PromptCard({ p, wallet }: { p: Prompt; wallet: string }) {
  const text = p.text(wallet);
  return (
    <div className={styles.prompt}>
      <div className={styles.promptText}>
        <span className={styles.promptTitle}>{p.title}</span>
        <span className={styles.promptBody}>{text}</span>
        {p.note && <span className={styles.promptNote}>{p.note}</span>}
      </div>
      <CopyButton text={text} />
    </div>
  );
}

export default function ConnectAgentPage() {
  const [tab, setTab] = useState(APPS[0]!.id);
  const [mounted, setMounted] = useState(false);
  const { address } = useAccount();
  useEffect(() => setMounted(true), []);
  const wallet = mounted && address ? address : '[your wallet address]';
  const app = APPS.find((a) => a.id === tab) ?? APPS[0]!;

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>AI · Connect</p>
          <h1 className={cs.pageTitle}>Connect your AI</h1>
          <p className={cs.pageLede}>
            Use urufu from the AI app you already talk to. Ask it to check your coins, look into a coin, get a price, launch, or
            join a swarm. Your AI prepares everything, and nothing moves until you sign it in your own wallet.
          </p>
        </div>
      </header>

      <div className={styles.page}>
        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <div className={styles.stepHead}>
              <span className={styles.stepNum}>1</span>
              <div>
                <h2 className={styles.stepTitle}>Connect your AI to urufu</h2>
                <p className={styles.stepLede}>Pick your app. It takes about a minute.</p>
              </div>
            </div>
            <div className={styles.tabs} role="tablist" aria-label="AI app">
              {APPS.map((a) => (
                <button key={a.id} type="button" role="tab" aria-selected={tab === a.id} className={styles.tab} data-active={tab === a.id} onClick={() => setTab(a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
            <div className={styles.appBody} role="tabpanel">
              <ol className={styles.appSteps}>
                {app.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              {app.copy && (
                <div className={styles.copyBox}>
                  <div className={styles.copyLabel}>
                    <span>{app.copy.label}</span>
                    <CopyButton text={app.copy.text} />
                  </div>
                  <pre className={styles.code}>{app.copy.text}</pre>
                </div>
              )}
              <p className={styles.appPlan}>{app.plan}</p>
            </div>
          </div>
        </section>

        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <div className={styles.stepHead}>
              <span className={styles.stepNum}>2</span>
              <div>
                <h2 className={styles.stepTitle}>Say hello</h2>
                <p className={styles.stepLede}>
                  {mounted && address ? 'Your wallet is already filled in.' : 'Connect your wallet (top right) and your address fills in by itself.'}
                </p>
              </div>
            </div>
            <PromptCard p={START} wallet={wallet} />
          </div>
        </section>

        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <div className={styles.stepHead}>
              <span className={styles.stepNum}>3</span>
              <div>
                <h2 className={styles.stepTitle}>Put it to work</h2>
                <p className={styles.stepLede}>Copy one, swap in your coin, and send it.</p>
              </div>
            </div>
            <div className={styles.prompts}>
              {PROMPTS.map((p) => <PromptCard key={p.title} p={p} wallet={wallet} />)}
            </div>
          </div>
        </section>

        <section className={cs.panel}>
          <div className={cs.panelBody}>
            <div className={styles.stepHead}>
              <span className={styles.stepNum}>4</span>
              <div>
                <h2 className={styles.stepTitle}>Let it trade on its own (optional)</h2>
                <p className={styles.stepLede}>
                  Want it to buy and sell without asking you each time? Give it an agent account: a wallet you own, with
                  spending limits set on chain. <Link href="/agent/new">Launch an agent</Link>
                </p>
              </div>
            </div>
          </div>
        </section>

        <p className={styles.safety}>
          urufu never asks for your private key or seed phrase, and no AI should either. Before you sign, check the coin, the
          amount and the total ETH. More in <Link href="/docs#agents">Using an AI agent</Link>.
        </p>
      </div>
    </div>
  );
}
