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
  { id: 'trade', label: 'how trading works', jp: '取引' },
  { id: 'grad', label: 'graduation', jp: '卒業' },
  { id: 'fees', label: 'fees + discounts', jp: '料金' },
  { id: 'safe', label: 'is it safe', jp: '安全' },
  { id: 'terms', label: 'plain-english glossary', jp: '用語' },
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
          <b>urufu labs</b> is a launchpad. u come here to make ur own token, hit launch,
          and immediately have a place where people can trade it.
        </p>
        <p style={{ marginTop: 10 }}>
          most launchpads only let u launch one shape of token. urufu is different. u pick a
          base (a plain coin, a picture-based collectible, or a mixed-item collection), then u
          drag features into a cart: things like anti-bot protection, staking, royalties,
          voting rights. every combo is a real, audited contract. one click, one transaction,
          done ✿
        </p>
        <Callout tone="pink" label="in one sentence">
          make ur own token, drop in features, hit launch. the code is real solidity, the
          liquidity locks itself, and every trade quietly rewards our community ~
        </Callout>
      </Section>

      {/* ================================================================
          HOW TO LAUNCH
          ================================================================ */}
      <Section id="launch" title="how do i launch a token?" jp="発行">
        <ol style={numberedListStyle}>
          <li>
            <b>connect ur wallet.</b> top-right corner. u&apos;ll need a little ETH for the launch
            fee and gas.
          </li>
          <li>
            <b>go to the shop.</b> that&apos;s the <Link href="/create" style={linkStyle}>✿ shop</Link>{' '}
            link in the header. it&apos;s where u build ur token.
          </li>
          <li>
            <b>pick a base.</b> three options:
            <ul style={bulletListStyle}>
              <li><b>coin</b> — a fungible token like $DOGE. good for memes + utility.</li>
              <li><b>collectible</b> — 1-of-1 or 1-of-many pictures. like NFTs.</li>
              <li><b>mixed items</b> — a collection where each id has a supply. like an in-game shop.</li>
            </ul>
          </li>
          <li>
            <b>drag features into ur cart.</b> stuff like anti-bot cooldowns, staking rewards,
            royalties, deflation, voting. each one is optional. mouse over any of them to see
            what they do.
          </li>
          <li>
            <b>hit launch.</b> approve the transaction, pay the fee, and ur token is live on
            the chain u&apos;re on. u get an address u can share.
          </li>
        </ol>
        <Callout tone="mint" label="no coding required">
          u never touch code. u never wait for a team to audit ur combo. the audits happened
          once, when we shipped the features. ur job is picking, not building.
        </Callout>
      </Section>

      {/* ================================================================
          HOW TRADING WORKS
          ================================================================ */}
      <Section id="trade" title="how does trading work?" jp="取引">
        <p>
          when u launch a token, it starts on something called a <b>bonding curve</b>.
          that&apos;s a math formula that sets the price based on how much ETH is in the pool.
          the more people buy, the higher the price. the more people sell, the lower it goes.
        </p>
        <p style={{ marginTop: 10 }}>
          this means <b>u can always trade</b>. u don&apos;t need a market maker. u don&apos;t need
          liquidity providers. u don&apos;t need someone else to sell to. the curve is the market.
        </p>
        <p style={{ marginTop: 10 }}>
          every trade goes through the curve, and a small fee (usually 1%) goes back to the
          flywheel (see below).
        </p>
      </Section>

      {/* ================================================================
          GRADUATION
          ================================================================ */}
      <Section id="grad" title="what does &quot;graduation&quot; mean?" jp="卒業">
        <p>
          once ur token&apos;s pool hits a target amount of ETH (usually a few ETH), it{' '}
          <b>graduates</b>. this is a big moment.
        </p>
        <ul style={bulletListStyle}>
          <li>
            <b>the ETH + tokens move onto Uniswap v4</b>, a real, permanent liquidity pool.
          </li>
          <li>
            <b>the liquidity is locked forever.</b> the person who launched can&apos;t pull it.
            we can&apos;t pull it. no one can. this is called a <i>rug pull</i> and graduated
            urufu tokens can&apos;t be rugged.
          </li>
          <li>
            <b>trading keeps going</b>, but now on Uniswap instead of the bonding curve.
            it feels the same to u — same trade page, same interface — but under the hood
            it&apos;s a bigger market with more liquidity.
          </li>
          <li>
            <b>the creator starts earning</b> a small % of every trade on their token. this
            is set at launch time and can never be changed. incentive-aligned ✿
          </li>
        </ul>
        <Callout tone="mizuiro" label="locked forever means locked forever">
          the LP-lock isn&apos;t a timer that runs out. it&apos;s not a promise. it&apos;s coded into the
          contract so removing liquidity literally reverts (aka refuses to happen). if
          someone tells u urufu tokens can be rugged, they are wrong ~~
        </Callout>
      </Section>

      {/* ================================================================
          FEES + DISCOUNTS
          ================================================================ */}
      <Section id="fees" title="what fees are there?" jp="料金">
        <p>
          there are two kinds of fees u&apos;ll see:
        </p>
        <ul style={bulletListStyle}>
          <li>
            <b>launch fee</b> — u pay this once when u launch a token. it&apos;s small (fractions
            of an ETH) and gets discounts if u hold URU or an urufu gemu nft (details below).
          </li>
          <li>
            <b>trade fee</b> — every buy or sell on the curve takes a tiny slice (usually 1%).
            u never pay this directly — it just comes out of the trade before u see the
            output.
          </li>
        </ul>

        <div className="uru-shell-tight" style={{ padding: 12, marginTop: 12, background: 'var(--cream)' }}>
          <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ launch-fee discounts</div>
          <ul className="uru-list-flower" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li>hold at least 1 urufu gemu nft → <b>20% off</b></li>
            <li>hold at least 100,000 URU → <b>40% off</b></li>
            <li>hold both → <b>50% off</b> (capped)</li>
          </ul>
        </div>

        <p style={{ marginTop: 12 }}>
          the trade fee goes into the <b>flywheel</b>: 40% buys back URU (which is then paid
          to urufu gemu nft holders), 35% goes directly to urufu gemu nft holders as ETH, and
          25% keeps the lights on (servers, audits, us being able to build the next thing).
        </p>
      </Section>

      {/* ================================================================
          IS IT SAFE
          ================================================================ */}
      <Section id="safe" title="is it safe?" jp="安全">
        <p>
          real answer: <b>the code is safe. the tokens ppl launch are not always safe. those
          are two different things.</b>
        </p>
        <ul style={bulletListStyle}>
          <li>
            <b>the contracts are audited.</b> every feature u can pick, and every combo u can
            build with them, has been audited before it ships to the shelf.
          </li>
          <li>
            <b>the liquidity locks itself.</b> once a token graduates, the LP position is
            math-locked. we could not remove it even if we wanted to.
          </li>
          <li>
            <b>u are still responsible for what u buy.</b> anyone can launch a token here.
            some tokens are good ideas. some are jokes. some are scams. do ur own research
            (dyor) on any token before u buy it ~~
          </li>
        </ul>
        <Callout tone="yolk" label="things urufu can&apos;t protect u from">
          <ul style={{ ...bulletListStyle, marginTop: 0 }}>
            <li>buying a bad idea (u picked it, not us).</li>
            <li>pre-graduation dumps by early buyers.</li>
            <li>fake tokens that copy real ones — always check the address on{' '}
              <Link href="/discover" style={linkStyle}>the discover page</Link>.
            </li>
          </ul>
        </Callout>
      </Section>

      {/* ================================================================
          GLOSSARY
          ================================================================ */}
      <Section id="terms" title="plain-english glossary" jp="用語">
        <dl style={glossaryStyle}>
          <Term term="token">
            a digital thing on the chain that u can own, send, trade. like a coin, but it can
            also be a picture or a game item.
          </Term>
          <Term term="wallet">
            the app u use to hold tokens + sign transactions. like a browser extension
            (metamask, rabby) or a phone app.
          </Term>
          <Term term="ETH">
            the native currency of ethereum. gas + trading pairs are usually priced in ETH.
          </Term>
          <Term term="gas">
            a small fee u pay the chain to do anything. varies by network — Base + Sepolia
            are cheap, mainnet can be expensive.
          </Term>
          <Term term="bonding curve">
            a self-running market. price goes up as ppl buy, down as ppl sell. no market
            maker needed.
          </Term>
          <Term term="graduation">
            when a token&apos;s pool hits its ETH target and moves onto Uniswap v4 with locked
            liquidity.
          </Term>
          <Term term="market cap">
            price per token × total supply. a rough sense of how much the whole token is
            worth right now.
          </Term>
          <Term term="LP / liquidity">
            the ETH + tokens sitting in a pool that lets u trade. more LP → smoother trades
            + less slippage.
          </Term>
          <Term term="LP lock">
            when the LP is provably stuck. no one can withdraw it — not the creator, not us.
            protects u from rug pulls.
          </Term>
          <Term term="rug pull">
            when someone removes the LP + runs off with the ETH, leaving u with worthless
            tokens. cannot happen to a graduated urufu token.
          </Term>
          <Term term="slippage">
            the difference between the price u see and the price u actually get, because the
            market moved between u clicking and the tx confirming. tolerate more slippage
            for volatile tokens.
          </Term>
          <Term term="URU">
            our ecosystem token. holding URU gets u launch-fee discounts + a slice of trade
            fees via the flywheel.
          </Term>
          <Term term="urufu gemu nft">
            our collectible nft. holders earn ETH directly from every trade on urufu labs +
            get launch-fee discounts.
          </Term>
          <Term term="hook">
            a small piece of code that runs on every uniswap trade after graduation. the
            hooks urufu ships route fees back to holders (the flywheel).
          </Term>
        </dl>
      </Section>

      {/* ================================================================
          FAQ
          ================================================================ */}
      <Section id="faq" title="faq" jp="よくある">
        <FAQ q="i&apos;ve never used a crypto wallet before. can i still use urufu?">
          yes, but u&apos;ll want to install a wallet first (metamask, rabby, or coinbase wallet
          are the easiest starts). then fund it with a little ETH. any beginner ETH guide
          works — we don&apos;t reinvent that here.
        </FAQ>
        <FAQ q="do i need to code anything?">
          no. u pick things, click launch, done. we handle every line of solidity.
        </FAQ>
        <FAQ q="how much does it cost to launch a token?">
          a small launch fee (fractions of an ETH) + gas. u can get up to 50% off the launch
          fee by holding URU + an urufu gemu nft.
        </FAQ>
        <FAQ q="can i make a token on a testnet first to try it?">
          yes! use the chain switcher (top-right) to pick sepolia or base sepolia. testnet
          ETH is free to get from a faucet. we recommend rehearsing at least once before
          launching on mainnet.
        </FAQ>
        <FAQ q="what if my token doesn&apos;t graduate?">
          totally fine — it just stays on the bonding curve. u can still trade it, but it
          never gets locked liquidity + a v4 pool. no penalty.
        </FAQ>
        <FAQ q="which chains does urufu support?">
          right now: ethereum mainnet, base, sepolia (testnet), base sepolia (testnet), and
          robinhood chain (coming as soon as their v4 deployment is public). use the chain
          switcher in the header.
        </FAQ>
        <FAQ q="where do i see my launches / trades?">
          <Link href="/profile" style={linkStyle}>ur profile</Link>. it shows every token u
          launched, every trade u made, ur current holdings, and ur pnl.
        </FAQ>
        <FAQ q="can i follow other people?">
          yes. paste any wallet address into <code style={codeStyle}>/profile/0x…</code> and
          hit follow. their activity shows up in <Link href="/feed" style={linkStyle}>ur feed</Link>.
        </FAQ>
        <FAQ q="how do i buy URU or an urufu gemu nft?">
          URU trades on Uniswap on Base. urufu gemu nfts mint occasionally + trade on OpenSea.
          check the community channels for links so u don&apos;t buy from a fake contract.
        </FAQ>
        <FAQ q="where&apos;s the source code?">
          github.com/urufu-labs — all the contracts + this website are open source.
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

function Term({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt
        style={{
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontWeight: 700,
          fontSize: 13,
          color: 'var(--pink-hot)',
          marginTop: 8,
        }}
      >
        ✿ {term}
      </dt>
      <dd style={{ marginLeft: 16, fontSize: 12.5, lineHeight: 1.55 }}>{children}</dd>
    </>
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

const glossaryStyle: React.CSSProperties = {
  margin: 0,
};
