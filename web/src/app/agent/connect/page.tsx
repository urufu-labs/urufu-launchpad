'use client';

/// "Connect your AI": pick what you want your AI to do, pick your app (one setup
/// screen per app), check it worked, then copy a prompt for that goal.
///
/// Setup steps per app were checked against each app's own help pages on
/// 2026-11-01. The "Did it work?" test shows a random code; the human's AI runs
/// the `connection_check` tool with it, and this page polls the compile-service
/// (GET /agents/connect-check) until the code shows up.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import cs from '../../create/create-studio.module.css';
import styles from './connect.module.css';

const MCP_URL = 'https://urufulabs.xyz/api/mcp';
const SKILL_URL = 'https://urufulabs.xyz/agent-skill.md';
const COMPILE_SERVICE_URL = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------- goals + prompts

interface Prompt { title: string; text: (w: string) => string; note?: string }

const P = {
  holdings: {
    title: 'What do I hold?',
    text: (w: string) => `Using urufu, show me what my wallet ${w} holds and what each coin is worth in ETH, biggest first.`,
  },
  takeProfit: {
    title: 'Take profit',
    text: (w: string) => `Using urufu, check the coins in ${w}. For any coin worth more than 0.05 ETH, get me a quote to sell half and show me what I would get.`,
  },
  research: {
    title: 'Check a coin before you buy',
    text: () => 'Look up this urufu coin: [paste the coin link]. Show its price, how close it is to graduating, its top holders and recent trades, and tell me anything that looks risky.',
  },
  buy: {
    title: 'Buy with a price limit',
    text: () => 'Get me a quote on urufu to buy 0.01 ETH of [paste the coin link]. Show me how many coins I get and the price limit, and wait for my yes before anything is signed.',
  },
  launch: {
    title: 'Launch a coin',
    text: () => 'Launch a coin on urufu called [name] with the ticker [TICKER] using the Fair launch. Show me the fees and every step I need to sign before we start.',
  },
  swarm: {
    title: 'Join a swarm',
    text: () => 'List the open swarms on urufu. For each one, tell me the coin, how much is in the pot, and when the vote ends. Then help me join the one I pick.',
  },
  fees: {
    title: 'Collect creator fees',
    text: (w: string) => `Check if ${w} has creator fees waiting on urufu, tell me how much, and prepare the claim.`,
  },
  monday: {
    title: 'Monday check-in',
    text: (w: string) => `Every Monday morning, show me what my urufu coins in ${w} are worth in ETH, biggest first, and flag any coin that is close to graduating.`,
    note: 'Needs an app that runs tasks on a schedule, like Grok Bot routines.',
  },
  watch: {
    title: 'Graduation watch',
    text: () => 'Check this urufu coin every hour: [paste the coin link]. Tell me when it is over 90% of the way to graduating.',
    note: 'Needs an app that runs tasks on a schedule.',
  },
} satisfies Record<string, Prompt>;

interface Goal { id: string; label: string; line: string; prompts: Prompt[] }

const GOALS: Goal[] = [
  { id: 'holdings', label: 'Check my coins', line: 'What you hold and what it is worth', prompts: [P.holdings, P.takeProfit] },
  { id: 'research', label: 'Look into a coin', line: 'Price, holders, trades, red flags', prompts: [P.research, P.watch] },
  { id: 'trade', label: 'Buy or sell', line: 'A quote first, then you approve it', prompts: [P.buy, P.takeProfit] },
  { id: 'launch', label: 'Launch a coin', line: 'Your AI walks you through it', prompts: [P.launch] },
  { id: 'swarm', label: 'Join a swarm', line: 'Back a coin with a group', prompts: [P.swarm] },
  { id: 'fees', label: 'Collect my fees', line: 'Creator fees from coins you launched', prompts: [P.fees] },
  { id: 'schedule', label: 'Run on a schedule', line: 'Check-ins and alerts while you are away', prompts: [P.monday, P.watch] },
];

// ---------------------------------------------------------------- apps

interface App {
  id: string;
  label: string;
  /// Short letter mark for the app card (we don't ship other companies' logos).
  mark: string;
  tone: string;
  blurb: string;
  plan: string;
  steps: React.ReactNode[];
  copy?: { label: string; text: string };
}

const APPS: App[] = [
  {
    id: 'claude',
    label: 'Claude',
    mark: 'Cl',
    tone: '#d97757',
    blurb: 'claude.ai, desktop and phone',
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
    id: 'chatgpt',
    label: 'ChatGPT',
    mark: 'G',
    tone: '#10a37f',
    blurb: 'Business and Enterprise',
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
    mark: 'Gk',
    tone: '#6b7280',
    blurb: 'grok.com, every plan',
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
    mark: 'GB',
    tone: '#111827',
    blurb: 'Works 24/7, runs routines',
    plan: 'Included with Grok Premium, Super, Ultra, Teams and Enterprise. Grok Bot uses the same connectors as Cursor and can run routines on a schedule.',
    steps: [
      <>Open Grok Bot on your desktop or phone.</>,
      <>Add a custom MCP server with the link below, the same way you would in Cursor.</>,
      <>Ask it to read the urufu guide once so it knows the rules: <b>{SKILL_URL}</b></>,
      <>Give it a routine, like a Monday check-in.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    mark: 'Px',
    tone: '#20808d',
    blurb: 'Plugins in the sidebar',
    plan: 'Remote connectors are added from Plugins.',
    steps: [
      <>Open <b>Plugins</b> in the sidebar.</>,
      <>Click <b>Add custom</b> and add a remote connector with the link below.</>,
      <>On the home page, switch urufu on under <b>Sources</b>.</>,
    ],
    copy: { label: 'Server link', text: MCP_URL },
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    mark: '>_',
    tone: '#b4532a',
    blurb: 'One command in your terminal',
    plan: 'Run this once in your terminal.',
    steps: [
      <>Run the command below.</>,
      <>Check it with <b>/mcp</b> inside Claude Code. urufu should say connected.</>,
    ],
    copy: { label: 'Command', text: `claude mcp add --transport http urufu ${MCP_URL}` },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mark: 'Cu',
    tone: '#374151',
    blurb: 'One line in mcp.json',
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
    label: 'Something else',
    mark: '+',
    tone: '#9ca3af',
    blurb: 'Any app with MCP or web reading',
    plan: 'Any app that can add an MCP server by link works. If yours can only read web pages, give it the guide instead.',
    steps: [
      <>If it supports MCP, add this server: <b>{MCP_URL}</b></>,
      <>If not, paste the line below into a chat. It tells your AI how to use urufu.</>,
    ],
    copy: { label: 'First message', text: `Read ${SKILL_URL} and follow it to help me use urufu on Robinhood Chain.` },
  },
];

// ---------------------------------------------------------------- small pieces

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch { /* clipboard blocked: the text is still selectable */ }
  };
  return (
    <button type="button" className="ui-btn" data-variant="ghost" data-size="sm" onClick={copy}>
      {done ? 'Copied' : label}
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

function Section({ n, title, lede, children }: { n: number; title: string; lede?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className={cs.panel}>
      <div className={cs.panelBody}>
        <div className={styles.stepHead}>
          <span className={styles.stepNum}>{n}</span>
          <div>
            <h2 className={styles.stepTitle}>{title}</h2>
            {lede && <p className={styles.stepLede}>{lede}</p>}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `URU-${Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('')}`;
}

/// Polls the compile-service for the code every 3 s for up to 5 minutes.
function ConnectionTest() {
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'waiting' | 'ok' | 'timeout'>('idle');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => { setCode(newCode()); return () => { if (timer.current) clearInterval(timer.current); }; }, []);

  const start = () => {
    if (!code) return;
    if (timer.current) clearInterval(timer.current);
    setState('waiting');
    const until = Date.now() + 5 * 60_000;
    timer.current = setInterval(async () => {
      if (Date.now() > until) {
        clearInterval(timer.current!);
        setState('timeout');
        return;
      }
      try {
        const r = await fetch(`${COMPILE_SERVICE_URL}/agents/connect-check?code=${code}`, { cache: 'no-store' });
        const body = (await r.json()) as { seen?: boolean };
        if (body.seen) {
          clearInterval(timer.current!);
          setState('ok');
        }
      } catch { /* keep trying until the time runs out */ }
    }, 3000);
  };

  const prompt = code ? `Run the urufu connection check with code ${code}.` : '';
  return (
    <div className={styles.test} data-state={state}>
      {state === 'ok' ? (
        <p className={styles.testOk}>Connected. Your AI can use urufu now.</p>
      ) : (
        <>
          <div className={styles.prompt}>
            <div className={styles.promptText}>
              <span className={styles.promptTitle}>Send this to your AI</span>
              <span className={styles.promptBody}>{prompt || '…'}</span>
            </div>
            <CopyButton text={prompt} />
          </div>
          <div className={styles.testRow}>
            <button type="button" className="ui-btn" data-variant="primary" data-size="sm" onClick={start} disabled={!code || state === 'waiting'}>
              {state === 'waiting' ? 'Waiting for your AI…' : state === 'timeout' ? 'Check again' : 'I sent it'}
            </button>
            {state === 'timeout' && (
              <span className={styles.testHint}>Nothing yet. Check the connector is switched on in your app, then try again.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function ConnectAgentPage() {
  const [goalId, setGoalId] = useState(GOALS[0]!.id);
  const [appId, setAppId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const { address } = useAccount();
  useEffect(() => setMounted(true), []);
  const wallet = mounted && address ? address : '[your wallet address]';
  const goal = GOALS.find((g) => g.id === goalId) ?? GOALS[0]!;
  const app = APPS.find((a) => a.id === appId) ?? null;

  return (
    <div className={cs.studio}>
      <header className={cs.pageHeader}>
        <div>
          <p className={cs.pageEyebrow}>AI · Connect</p>
          <h1 className={cs.pageTitle}>Connect your AI</h1>
          <p className={cs.pageLede}>
            Use urufu from the AI you already talk to. It does the looking up and the paperwork, and gives you a link to
            approve anything that moves money. Nothing moves until you sign in your own wallet.
          </p>
        </div>
      </header>

      <div className={styles.page}>
        <Section n={1} title="What do you want your AI to do?">
          <div className={styles.goals} role="radiogroup" aria-label="Goal">
            {GOALS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={goalId === g.id}
                className={styles.goal}
                data-active={goalId === g.id}
                onClick={() => setGoalId(g.id)}
              >
                <span className={styles.goalLabel}>{g.label}</span>
                <span className={styles.goalLine}>{g.line}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section n={2} title="Pick your app" lede="About a minute to set up.">
          <div className={styles.apps}>
            {APPS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={styles.app}
                data-active={appId === a.id}
                aria-expanded={appId === a.id}
                onClick={() => setAppId(appId === a.id ? null : a.id)}
              >
                <span className={styles.appMark} style={{ background: a.tone }} aria-hidden>{a.mark}</span>
                <span className={styles.appText}>
                  <span className={styles.appName}>{a.label}</span>
                  <span className={styles.appBlurb}>{a.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          {app && (
            <div className={styles.setup}>
              <div className={styles.setupHead}>
                <span className={styles.appMark} style={{ background: app.tone }} aria-hidden>{app.mark}</span>
                <span className={styles.appName}>Set up {app.label}</span>
              </div>
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
          )}
        </Section>

        <Section n={3} title="Did it work?" lede="Send your AI this line. This box turns green when it reaches urufu.">
          <ConnectionTest />
        </Section>

        <Section
          n={4}
          title={`Try it: ${goal.label.toLowerCase()}`}
          lede={mounted && address ? 'Your wallet is already filled in.' : 'Connect your wallet (top right) and your address fills in by itself.'}
        >
          <div className={styles.prompts}>
            {goal.prompts.map((p) => <PromptCard key={p.title} p={p} wallet={wallet} />)}
          </div>
          {goal.id === 'schedule' || goal.id === 'trade' ? (
            <p className={styles.appPlan}>
              Want it to trade without asking you each time? Give it an agent account with spending limits set on chain:{' '}
              <Link href="/agent/new">Launch an agent</Link>.
            </p>
          ) : null}
        </Section>

        <p className={styles.safety}>
          urufu never asks for your private key or seed phrase, and no AI should either. Before you sign, check the coin, the
          amount and the total ETH. More in <Link href="/docs#agents">Using an AI agent</Link>.
        </p>
      </div>
    </div>
  );
}
