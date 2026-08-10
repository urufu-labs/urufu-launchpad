'use client';

/// /agents — minimal landing page. The skill file at /agent-skill.md is the
/// actual docs (it covers every endpoint, every conversational script, the
/// full worked transcript). This page is a one-screen handoff: what the
/// skill is, where to paste it, and a link to the raw file.

import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Mascot } from '@/components/Mascot';

export default function AgentsPage() {
  const [copied, setCopied] = useState(false);

  const copySkillUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('https://urufulabs.xyz/agent-skill.md');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
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
          drop this markdown into ur agent's <b>system prompt</b> or <b>rules file</b> — not a
          regular chat message. it walks the human through name, ticker, logo, description,
          socials, first-buy, then signs + reports back.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link
            href="/agent-skill.md"
            className="uru-btn uru-btn-primary"
            style={{ padding: '8px 14px', fontSize: 12 }}
            prefetch={false}
          >
            open skill ↗
          </Link>
          <button
            type="button"
            onClick={copySkillUrl}
            className="uru-btn uru-btn-cream"
            style={{ padding: '8px 14px', fontSize: 12 }}
          >
            {copied ? '✿ copied' : 'copy url'}
          </button>
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
          <b>where to paste:</b> claude.ai → project instructions · claude code →{' '}
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
