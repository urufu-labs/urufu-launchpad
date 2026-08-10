'use client';

/// /agents — the public "give your ai an agent skill" landing page. Explains
/// what the downloadable skill file does, links to the raw markdown at
/// `/agent-skill.md`, and doubles as a live api reference so a curious dev
/// can eyeball the endpoints without cloning the skill.
///
/// Written in urufu voice: cream + pink cards, mascot, Japanese eyebrows, tape
/// polaroids — same tokens as /docs. It's a docs page, not a dashboard.

import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Mascot } from '@/components/Mascot';

interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  jp: string;
  purpose: string;
  example: string;
  returns: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/agent/status',
    jp: '状態',
    purpose: 'chain live? router paused? current fees. read this first.',
    example: 'curl https://urufulabs.xyz/api/agent/status',
    returns: '{ chain, launchpad, fees, curve, quickLaunchDefaults, addresses }',
  },
  {
    method: 'GET',
    path: '/api/agent/name-check',
    jp: '名前確認',
    purpose: 'is the name + ticker free? mirrors what the router will accept.',
    example: 'curl "https://urufulabs.xyz/api/agent/name-check?name=MyCoin&ticker=MYC"',
    returns: '{ name: {available, reason}, ticker: {available, reason}, ok }',
  },
  {
    method: 'POST',
    path: '/api/agent/upload-image',
    jp: '画像',
    purpose: 'pin the token logo to IPFS before launch. accepts a public URL or a base64 data URL.',
    example:
      'curl -X POST https://urufulabs.xyz/api/agent/upload-image -H "content-type: application/json" -d \'{"imageUrl":"https://i.imgur.com/abc123.png"}\'',
    returns: '{ cid, gatewayUrl } — pass gatewayUrl as imageUrl on /prepare-metadata',
  },
  {
    method: 'GET',
    path: '/api/agent/quote',
    jp: '見積り',
    purpose: 'everything the agent needs to sign the launch tx: calldata, msg.value, entrypoint, errors, warnings.',
    example:
      'curl "https://urufulabs.xyz/api/agent/quote?name=MyCoin&ticker=MYC&launcher=0x...&initialBuyEth=0.01"',
    returns:
      '{ to, calldata, value, fee, entrypoint, errors, warnings, canBroadcast, params }',
  },
  {
    method: 'POST',
    path: '/api/agent/verify',
    jp: '確認',
    purpose: 'after broadcast, POST the tx hash — returns deployed token + curve address.',
    example:
      'curl -X POST https://urufulabs.xyz/api/agent/verify -H "content-type: application/json" -d \'{"txHash":"0x..."}\'',
    returns: '{ token: {address, curve}, block, gas, links: {trade, blockscout} }',
  },
  {
    method: 'POST',
    path: '/api/agent/prepare-metadata',
    jp: '準備',
    purpose: 'build the canonical envelope for the launcher wallet to sign so description + logo + socials attach to the token on the site.',
    example:
      'curl -X POST https://urufulabs.xyz/api/agent/prepare-metadata -H "content-type: application/json" -d \'{"txHash":"0x...","imageUrl":"https://gateway.pinata.cloud/ipfs/Qm..."}\'',
    returns: '{ message, timestamp, payload, tokenAddress, chainId, launcher } — sign `message` with launcher key',
  },
  {
    method: 'POST',
    path: '/api/agent/attach-metadata',
    jp: '公開',
    purpose: 'submit the signed envelope. write happens iff signer wallet == launcher wallet.',
    example:
      'curl -X POST https://urufulabs.xyz/api/agent/attach-metadata -H "content-type: application/json" -d \'{"tokenAddress":"0x...","chainId":4663,"timestamp":...,"payload":{...},"signature":"0x...","address":"0x..."}\'',
    returns: '{ ok, tokenAddress, links: {trade} } | { code: "INDEXER_PENDING" | "NOT_LAUNCHER" | ... }',
  },
];

export default function AgentsPage() {
  const [copied, setCopied] = useState(false);

  const copySkillUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('https://urufulabs.xyz/agent-skill.md');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard may not be available on non-https or older browsers */ }
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-3 sm:px-4 py-4">
      {/* ================================================================
          HERO
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '14px 18px',
          marginBottom: 12,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Mascot size={48} mood="happy" className="uru-idle-bob" />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="uru-eyebrow" style={{ marginBottom: 3 }}>❋ agent skill</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1 }}>
              give ur ai a launchpad
            </h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              エージェント
            </span>
          </div>
          <p style={{ marginTop: 4, fontSize: 12, color: 'var(--anchor-soft)', lineHeight: 1.5 }}>
            hand this skill file to claude / cursor / clawbot / chatgpt / langchain — any agent
            that takes free-form instructions. it launches erc-20 tokens on ur behalf, with u
            confirming each spend before it signs ~
          </p>
        </div>
      </section>

      {/* ================================================================
          DOWNLOAD STRIP
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: 14,
          marginBottom: 12,
          background: 'var(--cream-deep, var(--cream))',
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 12,
          alignItems: 'center',
        }}
      >
        <div>
          <div className="uru-eyebrow" style={{ marginBottom: 4 }}>❀ the skill file</div>
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 12 }}>
            <code style={codeStyle}>urufulabs.xyz/agent-skill.md</code>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--anchor-soft)', lineHeight: 1.4 }}>
            plain markdown, tool-agnostic. paste it into ur agent's system prompt, rules file,
            or context. no install, no lock-in ~
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Link
            href="/agent-skill.md"
            className="uru-btn uru-btn-primary"
            style={{ padding: '8px 14px', fontSize: 12, textAlign: 'center' }}
            prefetch={false}
          >
            open skill ↗
          </Link>
          <button
            type="button"
            onClick={copySkillUrl}
            className="uru-btn uru-btn-cream"
            style={{ padding: '6px 12px', fontSize: 11 }}
          >
            {copied ? '✿ copied!' : 'copy url'}
          </button>
        </div>
      </section>

      {/* ================================================================
          HOW TO GIVE IT TO AN AGENT
          ================================================================ */}
      <section className="uru-shell" style={{ padding: 14, marginBottom: 12 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❁ how to load it (this matters!!)</div>
        <div style={{ fontSize: 12, color: 'var(--anchor-soft)', marginBottom: 8, lineHeight: 1.5 }}>
          the skill must go in ur agent's <b>instructions / system prompt / rules file</b> — not
          as a regular chat message. pasted-in-chat, the ai will summarize it instead of
          following it. use one of these patterns ~
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.75 }}>
          <li>
            <b>claude.ai (project or custom style)</b>: paste into <i>Project Instructions</i>{' '}
            or <i>Custom Instructions</i>. do NOT paste into a normal chat — claude will
            summarize instead of adopting the role.
          </li>
          <li>
            <b>claude code</b>: save as{' '}
            <code style={codeStyle}>.claude/skills/launch-urufu-token/SKILL.md</code> in ur
            project + say "use the launch-urufu-token skill".
          </li>
          <li>
            <b>cursor</b>: paste into <code style={codeStyle}>.cursorrules</code> or a custom
            mode's system prompt.
          </li>
          <li>
            <b>chatgpt / anthropic api / openai api</b>: paste as the <i>system</i> role message
            when starting a new conversation.
          </li>
          <li>
            <b>langchain / crewai / autogen / custom agents</b>: load as the agent's system prompt
            or tool-description.
          </li>
          <li>
            <b>quick test in any chat</b>: prefix with a directive line, e.g.
            <i> "Adopt the following operating instructions and follow them exactly when I talk
            to u. Do not summarize this file."</i> then paste. Reply with "hi" to trigger.
          </li>
        </ul>
      </section>

      {/* ================================================================
          WHAT THE AGENT WILL DO
          ================================================================ */}
      <section className="uru-shell" style={{ padding: 14, marginBottom: 12 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❉ the conversation ur agent has with u</div>
        <ol style={{ margin: 0, paddingLeft: 22, fontSize: 13, lineHeight: 1.75 }}>
          <li>asks for: <b>token name</b>, <b>ticker</b>, <b>logo</b> (image URL), <b>description</b>, <b>socials</b>, <b>first buy in ETH</b></li>
          <li>calls <code style={codeStyle}>/status</code> — chain up?</li>
          <li>calls <code style={codeStyle}>/name-check</code> — asks u for a new name if taken</li>
          <li>if u gave a logo: calls <code style={codeStyle}>/upload-image</code> — pins it to IPFS</li>
          <li>calls <code style={codeStyle}>/quote</code> — gets exact tx payload + total ETH cost</li>
          <li>
            <b>confirms every number with u</b>: name, ticker, logo, description, socials, first-buy,
            launch fee, total spend. u say yes or the agent aborts. hard rule in the skill —
            no autonomous spend ✿
          </li>
          <li>signs + broadcasts the launch tx from ur wallet</li>
          <li>calls <code style={codeStyle}>/verify</code> — confirms landed, gets token address</li>
          <li>if u gave description/logo/socials: calls <code style={codeStyle}>/prepare-metadata</code>,
              signs the ownership envelope with the same wallet, calls <code style={codeStyle}>/attach-metadata</code></li>
          <li>reports back: token address, trade URL, first-buy tokens owned</li>
        </ol>
      </section>

      {/* ================================================================
          API REFERENCE
          ================================================================ */}
      <section style={{ marginBottom: 12 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 8, paddingLeft: 4 }}>
          ❋ api reference{' '}
          <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 11, opacity: 0.7 }}>
            API仕様
          </span>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {ENDPOINTS.map((ep) => <EndpointCard key={ep.path} ep={ep} />)}
        </div>
      </section>

      {/* ================================================================
          SCOPE + SAFETY
          ================================================================ */}
      <section className="uru-shell" style={{ padding: 14, marginBottom: 12, background: 'var(--mint, #E8F5E9)' }}>
        <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ what agents CAN and CANNOT do</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, marginBottom: 4, color: 'var(--anchor)' }}>
              ✓ scope
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
              <li>launch a bonding-curve ERC-20 (quick mode only)</li>
              <li>on robinhood chain (chainid 4663)</li>
              <li>fixed 60-second anti-sniper gate</li>
              <li>optional launcher first-buy (atomic w/ launch)</li>
              <li>ownership renounced at launch (curve rule)</li>
            </ul>
          </div>
          <div>
            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, marginBottom: 4, color: 'var(--anchor)' }}>
              ✕ never
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
              <li>launch on any other chain</li>
              <li>launch without ur explicit yes</li>
              <li>set anti-sniper, burn %, or modules itself</li>
              <li>pay in URU (add later if u want it)</li>
              <li>use whitelist launches (add later if u want it)</li>
              <li>launch as part of a multi-step "agent decides" workflow</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ================================================================
          WORKED EXAMPLE
          ================================================================ */}
      <section className="uru-shell" style={{ padding: 14, marginBottom: 12 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 8 }}>❉ worked example (curl)</div>
        <pre
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 11,
            lineHeight: 1.55,
            padding: 10,
            background: 'var(--paper-base)',
            border: '1px solid var(--anchor-soft)',
            overflowX: 'auto',
            margin: 0,
          }}
        >{`# 1. is the chain up?
curl https://urufulabs.xyz/api/agent/status | jq '.launchpad, .fees.erc20Formatted'

# 2. is "MyCoin" / "MYC" free?
curl "https://urufulabs.xyz/api/agent/name-check?name=MyCoin&ticker=MYC" | jq

# 3. get the launch payload (buying 0.01 ETH of my own coin)
curl "https://urufulabs.xyz/api/agent/quote?name=MyCoin&ticker=MYC&launcher=0xMYWALLET&initialBuyEth=0.01" | jq

# 4. show human the numbers, wait for "yes"

# 5. sign + broadcast (cast, viem, ethers — anything)
cast send <to> <calldata> --value <value>wei \\
  --rpc-url https://rpc.mainnet.chain.robinhood.com \\
  --private-key $MY_KEY

# 6. verify
curl -X POST https://urufulabs.xyz/api/agent/verify \\
  -H "content-type: application/json" \\
  -d "{\\"txHash\\":\\"$TX\\"}" | jq
`}</pre>
      </section>

      {/* ================================================================
          FOOTER LINK BACK
          ================================================================ */}
      <div style={{ textAlign: 'center', marginTop: 20, marginBottom: 20, fontSize: 11, color: 'var(--anchor-soft)' }}>
        questions? <Link href="/docs" style={{ color: 'var(--anchor)', textDecoration: 'underline' }}>the human docs live here</Link> ~
      </div>
    </div>
  );
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  return (
    <div className="uru-shell-tight" style={{ padding: 12, background: 'var(--cream)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span
          className="uru-stamp"
          style={{
            background: ep.method === 'GET' ? 'var(--mint, #E8F5E9)' : 'var(--pink-warm, #FCE4EC)',
            transform: 'rotate(-2deg)',
          }}
        >
          {ep.method}
        </span>
        <code style={{ ...codeStyle, fontSize: 12 }}>{ep.path}</code>
        <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
          {ep.jp}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>{ep.purpose}</div>
      <div style={{ marginTop: 8 }}>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 2 }}>
          example
        </div>
        <pre
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10.5,
            padding: 8,
            background: 'var(--paper-base)',
            border: '1px solid var(--anchor-soft)',
            overflowX: 'auto',
            margin: 0,
          }}
        >{ep.example}</pre>
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 2 }}>
          returns
        </div>
        <code style={{ ...codeStyle, fontSize: 10.5, display: 'block', padding: 6 }}>{ep.returns}</code>
      </div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  background: 'var(--paper-base)',
  borderRadius: 3,
  padding: '1px 5px',
  border: '1px solid var(--anchor-soft)',
  fontFamily: 'var(--font-pixel), monospace',
};
