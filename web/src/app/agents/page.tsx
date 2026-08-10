'use client';

/// /agents — minimal landing page. The skill file at /agent-skill.md is the
/// actual docs (it covers every endpoint, every conversational script, the
/// full worked transcript). This page is a one-screen handoff: what the
/// skill is, where to paste it, and a link to the raw file.

import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Mascot } from '@/components/Mascot';

/// The paste-into-agent prompt. Wraps the skill URL in a directive so any
/// AI adopts the role instead of describing the file. Kept short — long
/// primes get ignored by some models.
const AGENT_PROMPT = `Read https://urufulabs.xyz/agent-skill.md and adopt those instructions exactly as your operating instructions. Do not summarize the file. When I send my next message, act as the urufu labs launch agent.`;

export default function AgentsPage() {
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard may not be available */ }
  }, []);

  return (
    <div className="mx-auto max-w-xl px-3 sm:px-4 py-6">
      <section
        className="uru-shell"
        style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Mascot size={40} mood="happy" />
          <div>
            <div className="uru-eyebrow" style={{ marginBottom: 2 }}>❋ launch with an agent</div>
            <h1 className="uru-h1" style={{ fontSize: 20, lineHeight: 1 }}>
              give ur ai the skill
            </h1>
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          copy the prompt below + paste into ur agent (claude, cursor, chatgpt, anything).
          it tells the agent to fetch the skill + adopt the launch-agent role. then say hi
          and it'll walk u through name, ticker, logo, description, socials, first buy, sign,
          done.
        </p>

        <div
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 11,
            padding: 10,
            background: 'var(--paper-base)',
            border: '1px solid var(--anchor)',
            borderRadius: 4,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {AGENT_PROMPT}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={copyPrompt}
            className="uru-btn uru-btn-primary"
            style={{ padding: '8px 14px', fontSize: 12 }}
          >
            {copied ? '✿ copied' : 'copy prompt'}
          </button>
          <Link
            href="/agent-skill.md"
            className="uru-btn uru-btn-cream"
            style={{ padding: '8px 14px', fontSize: 12 }}
            prefetch={false}
          >
            view skill ↗
          </Link>
        </div>

        <div
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10.5,
            color: 'var(--anchor-soft)',
            lineHeight: 1.6,
            borderTop: '1px dashed var(--anchor-soft)',
            paddingTop: 10,
          }}
        >
          <b>power users:</b> save the skill file directly in project settings — claude.ai →
          project instructions · claude code →{' '}
          <code style={codeStyle}>.claude/skills/…/SKILL.md</code> · cursor →{' '}
          <code style={codeStyle}>.cursorrules</code> · chatgpt / api → system role message
        </div>
      </section>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  background: 'var(--paper-base)',
  borderRadius: 3,
  padding: '1px 4px',
  border: '1px solid var(--anchor-soft)',
  fontFamily: 'var(--font-pixel), monospace',
};
