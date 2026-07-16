'use client';

/// Docs page — normie-friendly guide to what urufu labs is, how to launch, and how
/// value routes back to holders. Uses plain language everywhere. Any deep-technical
/// stuff lives in the shelf + on-chain readmes.

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';

type Section = { id: string; label: string; jp: string };

const SECTIONS: Section[] = [
  { id: 'what', label: 'what is this', jp: '説明' },
  { id: 'launch', label: 'how to launch', jp: '発行' },
  { id: 'trade', label: 'trading + graduation', jp: '取引' },
  { id: 'creator', label: 'creator revenue', jp: '報酬' },
  { id: 'fees', label: 'fees + discounts', jp: '料金' },
  { id: 'chains', label: 'which chain', jp: '鎖' },
  { id: 'safe', label: 'is it safe', jp: '安全' },
  { id: 'faq', label: 'faq', jp: 'よくある' },
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-4xl px-3 sm:px-4 py-4">
      {/* ================================================================
          COMPACT HERO
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '12px 18px',
          marginBottom: 10,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Mascot size={44} mood="happy" className="uru-idle-bob" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="uru-eyebrow" style={{ marginBottom: 2 }}>❉ docs</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1 }}>the friendly guide</h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              説明書
            </span>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
              · everything in plain english ~
            </span>
          </div>
        </div>
        <Link href="/create" className="uru-btn uru-btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}>
          launch a token <span className="uru-arrow">→</span>
        </Link>
      </section>

      {/* ================================================================
          SECTION JUMP BAR (sticky)
          ================================================================ */}
      <nav
        style={{
          display: 'flex',
          gap: 5,
          flexWrap: 'wrap',
          marginBottom: 14,
          position: 'sticky',
          top: 0,
          zIndex: 5,
          padding: '6px 0',
          background: 'var(--paper-base)',
        }}
      >
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="uru-chip"
            style={{ padding: '5px 12px', textDecoration: 'none' }}
          >
            {s.label}
            <span
              style={{
                fontFamily: 'var(--font-jp), monospace',
                fontSize: 10,
                marginLeft: 4,
                opacity: 0.7,
              }}
            >
              {s.jp}
            </span>
          </a>
        ))}
      </nav>

      {/* ================================================================
          WHAT IS THIS
          ================================================================ */}
      <Section id="what" title="what is urufu labs?" jp="説明">
        <p>
          a launchpad. pick a base (coin, nft, or mixed-item collection), drag features into
          a cart, hit launch. u get a real ERC-20 or ERC-721/1155 on-chain in one tx, plus a
          trade page + chart for anyone to trade it.
        </p>
        <Callout tone="pink" label="what makes urufu different">
          most launchpads only launch one shape of token. urufu launches every shape, each
          with composable features (anti-bot, staking, royalties, voting) that compile from
          the same audited primitives ~
        </Callout>
      </Section>

      {/* ================================================================
          HOW TO LAUNCH
          ================================================================ */}
      <Section id="launch" title="how to launch" jp="発行">
        <ol style={numberedListStyle}>
          <li><b>connect wallet</b> (top-right). fund w/ a little ETH.</li>
          <li><b>pick a chain</b> in the switcher next to the wallet button.</li>
          <li>
            head to the <Link href="/create" style={linkStyle}>✿ shop</Link> and{' '}
            <b>pick a base</b>: coin (like $DOGE) · collectible (like an NFT) ·
            mixed items (like an in-game shop).
          </li>
          <li>
            <b>drag features</b> into ur cart — anti-bot cooldowns, staking, royalties,
            deflation, voting. each one is optional; hover to see what it does.
          </li>
          <li>
            <b>hit launch.</b> approve the tx, pay the fee, get a token address. ur trade
            page + chart is live immediately.
          </li>
        </ol>
      </Section>

      {/* ================================================================
          TRADING + GRADUATION
          ================================================================ */}
      <Section id="trade" title="trading + graduation" jp="取引">
        <p>
          <b>every token starts on a bonding curve</b> — a math formula that sets price from
          the ETH in the pool. more buys → higher price. more sells → lower. u can always
          trade because the curve is the market; no market maker or LP providers needed.
        </p>
        <p style={{ marginTop: 10 }}>
          when the curve fills to its target ETH amount, the token <b>graduates</b>:
        </p>
        <ul style={bulletListStyle}>
          <li>ETH + tokens migrate to a Uniswap v4 pool</li>
          <li><b>the LP position is math-locked forever</b> — the contract literally reverts on
            any removal attempt. not u, not the creator, not us can pull it.</li>
          <li>trading continues on the same trade page — same UX, bigger market</li>
          <li>the creator starts earning a % of every trade (see below)</li>
        </ul>
        <Callout tone="mizuiro" label="locked forever = coded in">
          not a timer, not a promise. `LPLockedHook.beforeRemoveLiquidity` reverts on every
          v4 removal call. graduated urufu tokens can&apos;t be rugged, period.
        </Callout>

        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 12, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ opt-in curve extras (pick at launch)</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li><b>sniper gate</b> — first N blocks after graduation, swaps revert. gives real
              ppl a beat to catch up before bots front-run.</li>
            <li><b>buy → burn</b> — up to 20% of tokens on each buy go to 0x…dead. deflation
              on every trade.</li>
          </ul>
          <p style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            baked into the v4 pool at graduation; not changeable after ~
          </p>
        </div>
      </Section>

      {/* ================================================================
          CREATOR REVENUE
          ================================================================ */}
      <Section id="creator" title="creator revenue" jp="報酬">
        <p>
          <b>if u launch a token that graduates, u earn ETH on every trade forever.</b>
          this is set at launch and can never be changed.
        </p>
        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 10, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ how it flows</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li><b>pre-graduation:</b> the 1% curve trade fee is split between platform + creator.</li>
            <li><b>post-graduation:</b> uniswap v4 charges a 0.3% swap fee. our hook
              redirects a slice of that fee stream to u as the creator, forever.</li>
            <li>u don&apos;t claim manually — fees accumulate to ur address and u withdraw via the
              MultiHookHost <code style={codeStyle}>claim()</code> function whenever u want.</li>
          </ul>
        </div>
        <Callout tone="mint" label="a small example">
          launch a coin, hit graduation, community trades $50k/day. at typical creator-share
          rates, that&apos;s meaningful passive ETH monthly — no team required, no marketing tricks,
          just from the pool doing what pools do ~
        </Callout>
        <p style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>
          exact split (platform / creator / flywheel) is set per launch by the hook config.
          check the trade page for ur token&apos;s configured split.
        </p>
      </Section>

      {/* ================================================================
          FEES + DISCOUNTS
          ================================================================ */}
      <Section id="fees" title="fees + discounts" jp="料金">
        <div className="uru-shell-tight" style={{ padding: 12, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ launch fee (paid once)</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li>bare token: <b>0.001 ETH</b></li>
            <li>full-loaded (hook + gov + modules): <b>~0.005 ETH</b></li>
            <li>plus network gas (cheap on Base + Robinhood)</li>
          </ul>
        </div>

        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 10, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ launch-fee discounts</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li>hold ≥ 1 urufu gemu nft → <b>20% off</b></li>
            <li>hold ≥ 100,000 URU → <b>40% off</b></li>
            <li>hold both → <b>50% off</b> (capped)</li>
          </ul>
        </div>

        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 10, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ trade fee (paid per swap)</div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <b>1%</b> pre-graduation, <b>0.3%</b> post-graduation (uniswap v4 standard).
            never paid directly — deducted from swap output.
          </p>
        </div>

        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 10, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ where the trade fee goes (the flywheel)</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li><b>40%</b> → buys back URU on-market</li>
            <li><b>35%</b> → paid to urufu gemu nft holders as ETH</li>
            <li><b>25%</b> → treasury (servers, audits, next builds)</li>
          </ul>
        </div>
      </Section>

      {/* ================================================================
          WHICH CHAIN
          ================================================================ */}
      <Section id="chains" title="which chain should i pick?" jp="鎖">
        <p>
          urufu launches identical contracts on 4 chains. all have the same launch fee.
          differ mostly by gas + who&apos;s trading:
        </p>
        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 10, background: 'var(--cream)' }}>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li>
              <b>base mainnet</b> — the default. cheap gas, huge trading community, best for
              memes + serious launches. flywheel + URU discounts live here.
            </li>
            <li>
              <b>ethereum mainnet</b> — most credibility, most gas cost. pick for high-stakes
              launches where u want L1 permanence.
            </li>
            <li>
              <b>robinhood chain</b> — brand-new L2, near-zero gas. good for experiments +
              first launches.
            </li>
            <li>
              <b>base sepolia</b> — testnet. rehearse here w/ fake ETH before spending real ETH.
              get testnet ETH from any base sepolia faucet.
            </li>
          </ul>
        </div>
        <Callout tone="yolk" label="switch chains anytime">
          the chain switcher (top-right, next to the wallet button) affects what the shop
          builds against + where new launches land. discover + trade pages show every chain&apos;s
          activity.
        </Callout>
      </Section>

      {/* ================================================================
          IS IT SAFE
          ================================================================ */}
      <Section id="safe" title="is it safe?" jp="安全">
        <p>
          <b>the code is safe. the tokens people launch are not always safe.</b> those are
          two different things.
        </p>
        <ul style={bulletListStyle}>
          <li>
            <b>contracts are open + tested</b> — every combo compiles from the same audited
            primitives, factory addresses are on-chain readable, internal test suite covers
            shipped combos. external audit in progress.
          </li>
          <li>
            <b>graduated LPs can&apos;t be rugged</b> — LPLockedHook makes removal impossible.
          </li>
          <li>
            <b>ur job: check what u&apos;re buying.</b> anyone can launch. always verify the
            token address on the <Link href="/discover" style={linkStyle}>discover page</Link>.
          </li>
        </ul>
        <Callout tone="yolk" label="urufu can&apos;t save u from">
          bad ideas u picked · pre-graduation dumps · fake tokens copying real ones.
        </Callout>
      </Section>

      {/* ================================================================
          FAQ
          ================================================================ */}
      <Section id="faq" title="faq" jp="よくある">
        <FAQ q="never used a crypto wallet — can i still use urufu?">
          install metamask / rabby / coinbase wallet, fund with a little ETH, done. any
          beginner ETH guide works.
        </FAQ>
        <FAQ q="do i need to code anything?">
          no. pick, click launch, done. we handle every line of solidity.
        </FAQ>
        <FAQ q="what if my token doesn&apos;t graduate?">
          totally fine — it stays on the curve forever. u can still trade it. no penalty, no
          creator fees (those start post-graduation).
        </FAQ>
        <FAQ q="how do i claim creator fees?">
          call <code style={codeStyle}>claim(currency)</code> on the MultiHookHost contract from
          ur creator address. fees accumulate to u automatically on every swap — u just
          withdraw when u want.
        </FAQ>
        <FAQ q="where do i see my launches + trades?">
          <Link href="/profile" style={linkStyle}>ur profile</Link>. every token u launched,
          every trade, ur current holdings, ur PnL.
        </FAQ>
        <FAQ q="can i follow other people?">
          yes — paste a wallet address into <code style={codeStyle}>/profile/0x…</code> and
          hit follow. their activity shows up in{' '}
          <Link href="/feed" style={linkStyle}>ur feed</Link>.
        </FAQ>
        <FAQ q="how do i buy URU or a gemu nft?">
          URU trades on Uniswap on Base. gemu nfts mint occasionally + trade on OpenSea. use
          the community channels for the real contract addresses so u don&apos;t buy a fake.
        </FAQ>
        <FAQ q="where&apos;s the source code?">
          <code style={codeStyle}>github.com/urufu-labs</code> — every contract + this website,
          MIT-licensed.
        </FAQ>
      </Section>

      {/* ================================================================
          FOOTER CTA
          ================================================================ */}
      <section
        style={{
          padding: '18px 12px',
          textAlign: 'center',
          border: '1.5px dashed var(--anchor)',
          background: 'var(--cream)',
          marginTop: 12,
        }}
      >
        <p
          style={{
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 13,
            color: 'var(--anchor-soft)',
            marginBottom: 10,
          }}
        >
          feel ready? go make ur first token ~~
        </p>
        <Link href="/create" className="uru-btn uru-btn-primary">
          launch a token <span className="uru-arrow">→</span>
        </Link>
      </section>
    </div>
  );
}

// ============================================================================
// subcomponents
// ============================================================================

function Section({
  id,
  title,
  jp,
  children,
}: {
  id: string;
  title: string;
  jp: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ scrollMarginTop: 60, marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h2
          className="uru-h1"
          style={{ fontSize: 20, lineHeight: 1 }}
          dangerouslySetInnerHTML={{ __html: title }}
        />
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 14,
            color: 'var(--anchor-soft)',
          }}
        >
          {jp}
        </span>
      </div>
      <div className="uru-shell-tight" style={{ padding: 14, lineHeight: 1.6, fontSize: 13 }}>
        {children}
      </div>
    </section>
  );
}

function Callout({
  tone,
  label,
  children,
}: {
  tone: 'pink' | 'mint' | 'mizuiro' | 'yolk';
  label: string;
  children: React.ReactNode;
}) {
  const bg =
    tone === 'pink' ? 'var(--pink-warm)' :
    tone === 'mint' ? 'var(--mint)' :
    tone === 'mizuiro' ? 'var(--mizuiro)' :
    'var(--yolk)';
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: bg,
        border: '1.5px solid var(--anchor)',
        borderLeft: '4px solid var(--anchor)',
      }}
    >
      <div className="uru-eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details
      style={{
        marginBottom: 6,
        padding: '6px 10px',
        border: '1.5px solid var(--anchor)',
        background: 'var(--cream-deep)',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontWeight: 700,
          fontSize: 13,
          listStyle: 'none',
        }}
        dangerouslySetInnerHTML={{ __html: `❀ ${q}` }}
      />
      <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.55 }}>{children}</div>
    </details>
  );
}

// ============================================================================
// shared styles
// ============================================================================

const numberedListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 13,
  lineHeight: 1.65,
};

const bulletListStyle: React.CSSProperties = {
  margin: '6px 0',
  paddingLeft: 18,
  fontSize: 13,
  lineHeight: 1.55,
};

const linkStyle: React.CSSProperties = {
  color: 'var(--link-blue)',
  textDecoration: 'underline',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-pixel), monospace',
  background: 'var(--cream-deep)',
  padding: '1px 4px',
  border: '1px solid var(--anchor)',
};

