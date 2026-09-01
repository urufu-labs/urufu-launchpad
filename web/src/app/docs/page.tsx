'use client';

/// Public guide for the live Urufu launch flow. Covers ERC-20 coin launches
/// and ERC-721 NFT collection launches on Robinhood chain.

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';
import styles from './docs-page.module.css';

type Section = { id: string; label: string; jp: string };
type Tone = 'pink' | 'mint' | 'mizuiro' | 'yolk' | 'paper';

const SECTIONS: Section[] = [
  { id: 'flow', label: 'launch flow', jp: '流れ' },
  { id: 'whitelist', label: 'whitelists', jp: '関係者' },
  { id: 'uru-pay', label: 'URU pay', jp: 'URU支払' },
  { id: 'trading', label: 'curve trading', jp: '曲線' },
  { id: 'graduation', label: 'V4 graduation', jp: '卒業' },
  { id: 'nfts', label: 'NFT launches', jp: '絵札' },
  { id: 'fees', label: 'fees', jp: '料金' },
  { id: 'risk', label: 'risk', jp: '注意' },
  { id: 'chains', label: 'chains', jp: '鎖' },
  { id: 'faq', label: 'faq', jp: 'よくある' },
];

const FLOW = [
  {
    n: '01',
    title: 'define coin',
    body: 'name, ticker, artwork, description, and links. This is the public identity traders see on the launch and trade pages.',
  },
  {
    n: '02',
    title: 'customize contract',
    body: 'quick launch uses safe defaults; customizable curve adds shipped ERC-20 modules plus optional whitelist, sniper gate, and buyback-burn settings.',
  },
  {
    n: '03',
    title: 'safe launch',
    body: 'the router quotes the live fee, checks name/ticker availability, deploys the token, installs the bonding curve, and auto-renounces curve ownership.',
  },
  {
    n: '04',
    title: 'curve trading',
    body: 'buyers and sellers trade against the bonding curve immediately. Price moves with the curve reserves, and sellability depends on curve liquidity.',
  },
  {
    n: '05',
    title: 'V4 graduation',
    body: 'when the curve reaches its target, liquidity migrates to a Uniswap V4 pool with the platform hook for locked LP and creator fee routing.',
  },
];

export default function DocsPage() {
  return (
    <main className={styles.page}>
      <header className={styles.manualHeader} aria-labelledby="docs-title">
        <div className={styles.headerId}>
          <Mascot size={38} mood="happy" />
          <div>
            <p className={styles.eyebrow}>urufu reference</p>
            <h1 id="docs-title">Launchpad documentation</h1>
          </div>
        </div>
        <p>
          Current public flow for ERC-20 coin launches, curve trading, and V4
          graduation. This page is written as product documentation, not launch copy.
        </p>
        <Link href="/create" className="uru-btn uru-btn-primary">
          go to /create <span className="uru-arrow">→</span>
        </Link>
      </header>

      <div className={styles.manualLayout}>
        <aside className={styles.toc} aria-label="Documentation table of contents">
          <span className={styles.noteKicker}>contents</span>
          <nav>
            {SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.label}
                <span>{section.jp}</span>
              </a>
            ))}
          </nav>
        </aside>

        <article className={styles.primary}>
          <section id="flow" className={styles.referenceSection} aria-labelledby="flow-title">
            <div className={styles.sectionTitle}>
              <span>流れ</span>
              <h2 id="flow-title">Launch Flow</h2>
            </div>
            <div className={styles.sectionBody}>
              <p>
                Public Urufu launches follow one ERC-20 lifecycle: define coin,
                customize contract, safe launch, curve trading, then V4 graduation
                if the bonding curve reaches its target.
              </p>
              <ol className={styles.processList}>
                {FLOW.map((step) => (
                  <li key={step.n}>
                    <span>{step.n}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <DocSection id="whitelist" title="Whitelist Launches" jp="関係者">
            <p>
              A customizable curve can attach a community whitelist at launch. The creator
              pastes a supported contract address, the backend snapshots current holders,
              and the launch transaction stores a Merkle root.
            </p>
            <FactList
              items={[
                'Whitelisted wallets use the proof path during the exclusive window; non-whitelisted wallets wait for fallback.',
                '60% of curve supply is reserved for whitelist buyers while the window is active.',
                'The per-wallet cap is reserved supply divided by five, so a small set of holders cannot drain the full reserved slice from one wallet.',
                'The current frontend sets a 1-hour fallback window when the whitelist is applied.',
                'Whitelist buyers hold on-curve balances until graduation, then claim through the whitelist claim path.',
              ]}
            />
            <Callout tone="yolk" label="plain limitation">
              Holder snapshots only support compatible source contracts in the current public
              whitelist flow. A source community can gate an ERC-20 coin release; that is not
              a second public launch format.
            </Callout>
          </DocSection>

          <DocSection id="uru-pay" title="Paying In URU" jp="URU支払">
            <p>
              Launch fees are quoted from the router. Creators can pay in ETH, or on chains
              where URU pay is wired, pay the quoted ETH-equivalent amount in URU through
              the router&apos;s URU launch path.
            </p>
            <FactList
              items={[
                'Holding at least one urufu gemu pass applies a 20% launch-fee discount.',
                'Holding at least 100,000 URU applies a 40% launch-fee discount.',
                'Holding both applies a 50% combined discount in the frontend, with an on-chain hard cap protecting the router.',
                'The frontend checks the live URU/WETH V4 slot and the router floor before enabling URU payment.',
                'URU approvals are separate from the launch transaction; approve first, then launch.',
              ]}
            />
          </DocSection>

          <DocSection id="trading" title="Curve Trading" jp="曲線">
            <p>
              Every public ERC-20 launch installs a bonding curve. The token supply starts
              inside the curve, the trade page is live after launch, and users buy or sell
              against the curve while it has reserves.
            </p>
            <FactList
              items={[
                'The curve uses virtual reserves and a constant-product style price model.',
                'Buys add ETH and move the price up; sells remove ETH and move the price down.',
                'Pre-graduation curve trading charges a 1% trade fee routed by platform contracts, not a hidden creator kickback.',
                'Quick launch uses safe defaults, including a fixed supply and a safe launch; customizable curve exposes more knobs.',
                'A token that never graduates can keep trading on its curve as long as the curve has usable liquidity.',
              ]}
            />
          </DocSection>

          <DocSection id="graduation" title="V4 Graduation" jp="卒業">
            <p>
              Graduation moves the market from the bonding curve to Uniswap V4. The
              graduator creates the pool, installs the platform hook, and moves the curve
              liquidity into the V4 position.
            </p>
            <FactList
              items={[
                'The V4 LP is intended to be locked by hook behavior: remove-liquidity calls revert through the LP-lock hook.',
                'The trade page continues against the graduated market instead of the old curve path.',
                'Creator fee routing starts after graduation through the V4 hook configuration.',
                'Optional security and buyback-burn settings are written into the pool at graduation when selected.',
                'Graduation improves market depth, but it does not make price appreciation or future volume guaranteed.',
              ]}
            />
          </DocSection>

          <DocSection id="nfts" title="NFT Launches" jp="絵札">
            <p>
              Alongside coins, creators can launch ERC-721 collections at
              <Link href="/create/nft" style={{ marginLeft: 4 }}>/create/nft</Link>.
              Pick a fixed or stepped mint price, cap per-wallet mints, and choose
              ETH or URU as the payment currency.
            </p>
            <FactList
              items={[
                'Optional whitelist: a merkle list of wallets that can mint during a set window.',
                'Optional discounts for holders of another NFT collection (any chain the attestation service supports).',
                'Launcher keeps 90% of every mint, 10% flows to the flywheel.',
                'Claim launcher earnings from your profile page any time after the first mint.',
              ]}
            />
          </DocSection>

          <DocSection id="fees" title="Fees, Discounts, And Revenue" jp="料金">
            <div className={styles.feeGrid}>
              <Metric label="launch fee" value="live router quote" tone="pink" />
              <Metric label="curve trade fee" value="1%" tone="mint" />
              <Metric label="V4 swap fee" value="0.3%" tone="mizuiro" />
            </div>
            <FactList
              items={[
                'Launch fees use a documented split: 40% URU buyback, 35% urufu gemu NFT revenue, and 25% treasury.',
                'The 40% buyback slice funds the flywheel. ETH accrues in the buyback vault, a keeper swaps it for URU on-chain, and the bought URU is forwarded to the current distribution sink (redistribute to gemu holders, or burn, depending on the active sink).',
                'There is no launch-fee creator slot. That path was removed to avoid spam-launch farming.',
                'Creator earnings are post-graduation V4 swap fees, claimable from the configured creator address.',
                'Discounts lower the launch fee only; they do not remove gas costs or trading risk.',
              ]}
            />
          </DocSection>

          <DocSection id="risk" title="Material Risks" jp="注意">
            <div className={styles.riskGrid}>
              <Risk title="ownership" body="Curve ERC-20 launches auto-renounce ownership so traders are not relying on a launcher admin. Modules that need owner controls are blocked for curve launches." />
              <Risk title="sellability" body="Selling depends on contract behavior, your wallet state, chain availability, and available curve or pool liquidity. A token can be hard to exit." />
              <Risk title="liquidity" body="Locked LP removes one rug path after graduation, but it also means the position is not manually withdrawn to rescue a bad market." />
              <Risk title="fees" body="Launch fees, trade fees, swap fees, and gas are real costs. Fee discounts do not make a launch or trade free." />
              <Risk title="censorship" body="Owner-controlled platform contracts can pause or update platform-level routing where those powers exist. Existing token contracts do not become risk-free because the UI looks friendly." />
              <Risk title="market" body="Anyone can launch a coin. The launchpad does not verify creator promises, future demand, art provenance, or off-chain roadmap claims." />
            </div>
            <Callout tone="pink" label="security wording">
              Urufu can make specific contract-level guarantees, such as the LP-lock hook
              reverting remove-liquidity calls after graduation. It cannot guarantee that
              every launched coin is valuable, liquid, honest, or easy to sell.
            </Callout>
          </DocSection>

          <DocSection id="chains" title="Chains" jp="鎖">
            <p>
              The frontend should be treated as the source of truth for which chain is
              currently launch-enabled. The create page reads deployed contract addresses
              from configuration, quotes from the live router, and disables launch when the
              selected chain is not wired.
            </p>
            <FactList
              items={[
                'Robinhood Chain is the current culture-first target for the public flow.',
                'Historical Base and testnet code remains in the repository, but inactive chains should not be treated as public launch availability.',
                'Wrong-network and not-live states block the launch button before a transaction is sent.',
              ]}
            />
          </DocSection>

          <DocSection id="faq" title="FAQ" jp="よくある">
            <FAQ q="Do I need to code?">
              No. The token creation page collects the coin identity and configuration, then the
              router deploys the token and curve from shipped contracts.
            </FAQ>
            <FAQ q="Can I launch an NFT collection here today?">
              Not from the public creator flow. NFT contracts exist in the repo, and an NFT
              collection can be used as a whitelist source, but public launching is ERC-20
              coin-only right now.
            </FAQ>
            <FAQ q="What happens if my coin does not graduate?">
              It stays on its bonding curve. Trading can continue there while the curve has
              usable reserves, but creator V4 swap-fee revenue starts only after graduation.
            </FAQ>
            <FAQ q="Where do creator fees go?">
              Post-graduation fees accrue to the configured creator address through the V4
              hook path. The creator claims from the configured contract flow when fees are
              available.
            </FAQ>
            <FAQ q="Where do I recover historical orphan-curve funds?">
              Use the dedicated <Link href="/recover">recovery page</Link>. It is only for
              historical curves that are no longer shown in the main app.
            </FAQ>
          </DocSection>
        </article>

        <aside className={styles.factRail} aria-label="Current scope and source-of-truth notes">
          <section className={styles.factCard}>
            <span className={styles.noteKicker}>current scope</span>
            <b>ERC-20 coins only</b>
            <p>
              NFT and mixed-item contracts remain in the codebase, but the public
              creator flow does not offer them today.
            </p>
          </section>
          <section className={styles.factCard}>
            <span className={styles.noteKicker}>before launch</span>
            <FactList
              compact
              items={[
                'Pick a name and ticker you want reserved.',
                'Use quick launch for safe defaults.',
                'Use customizable curve only when you understand the selected modules.',
                'Read the quote and gas prompt before signing.',
              ]}
            />
          </section>
          <section className={styles.factCard} data-tone="warning">
            <span className={styles.noteKicker}>source of truth</span>
            <p>
              For exact contract addresses, fees, and chain enablement, trust the live
              router/config reads over old screenshots or copied docs.
            </p>
          </section>
          <section className={styles.factCard}>
            <span className={styles.noteKicker}>support route</span>
            <p>
              Historical orphan curves are handled outside normal trading.
            </p>
            <Link href="/recover" className="uru-btn uru-btn-mint">
              open recovery
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}

function DocSection({
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
    <section id={id} className={styles.referenceSection}>
      <div className={styles.sectionTitle}>
        <span>{jp}</span>
        <h2>{title}</h2>
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function FactList({ items, compact = false }: { items: string[]; compact?: boolean }) {
  return (
    <ul className={compact ? styles.compactList : styles.factList}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Callout({
  tone,
  label,
  children,
}: {
  tone: Exclude<Tone, 'paper'>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.callout} data-tone={tone}>
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={styles.metric} data-tone={tone}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Risk({ title, body }: { title: string; body: string }) {
  return (
    <article className={styles.risk}>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className={styles.faq}>
      <summary>{q}</summary>
      <div>{children}</div>
    </details>
  );
}
