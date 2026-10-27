'use client';

/// Public guide for launching on urufu labs (Robinhood Chain). Written for
/// creators, not developers: plain words, real numbers, no em dashes.
/// NFT and DN404 sections render only when their launch lanes are switched
/// on (NFT_LAUNCHES_ENABLED / DN404_LAUNCHES_ENABLED), so the page always
/// matches what the site actually offers. Copy rules are enforced by
/// src/app/docs/copy.test.mjs.

import Link from 'next/link';

import { GuideToc } from '@/components/GuideToc';
import {
  CHAINS_ENABLED,
  DN404_LAUNCHES_ENABLED,
  DN404_TAX_MODES,
  FAIR_LAUNCHES_ENABLED,
  NFT_LAUNCHES_ENABLED,
  type ChainKey,
} from '@/lib/config';
import styles from '@/styles/guide.module.css';

type Section = { id: string; label: string; show: boolean };

const CHAIN: ChainKey = CHAINS_ENABLED[0]!;
const NFTS_ON = NFT_LAUNCHES_ENABLED[CHAIN] === true;
const DN404_ON = DN404_LAUNCHES_ENABLED[CHAIN] === true;
const FAIR_ON = FAIR_LAUNCHES_ENABLED[CHAIN] === true;

const SECTIONS: Section[] = [
  { id: 'start', label: 'What you can launch', show: true },
  { id: 'coins', label: 'Coins', show: true },
  { id: 'fair', label: 'Fair launch', show: FAIR_ON },
  { id: 'whitelist', label: 'Early access for a community', show: true },
  { id: 'graduation', label: 'Graduation', show: true },
  { id: 'nfts', label: 'NFT collections', show: NFTS_ON },
  { id: 'dn404', label: 'DN404 (coin + NFTs)', show: DN404_ON },
  { id: 'market', label: 'Buying and selling NFTs', show: NFTS_ON || DN404_ON },
  { id: 'agents', label: 'Using an AI agent', show: true },
  { id: 'fees', label: 'Fees and discounts', show: true },
  { id: 'risk', label: 'Risks', show: true },
  { id: 'faq', label: 'FAQ', show: true },
];

const COIN_STEPS = [
  {
    n: '01',
    title: 'Name it',
    body: 'Pick a name, ticker, picture, description and links. This is what people see on the coin page.',
  },
  {
    n: '02',
    title: 'Pick a setup',
    body: 'Quick launch uses safe defaults. Advanced lets you add extras like a community early-access window, a short trading pause at graduation, or a buy-and-burn on every trade.',
  },
  {
    n: '03',
    title: 'Launch',
    body: 'You pay the launch fee and sign one transaction. The coin goes live right away and nobody, including you, keeps admin control over it.',
  },
  {
    n: '04',
    title: 'Trade on the curve',
    body: 'People can buy and sell straight away. The price rises as people buy and falls as they sell.',
  },
  {
    n: '05',
    title: 'Graduate',
    body: 'Once enough has been bought, the coin moves to a Uniswap trading pool at the same price, and the money in that pool is locked forever.',
  },
];

export default function DocsPage() {
  const sections = SECTIONS.filter((s) => s.show);
  const launchTypes = [
    'coins',
    FAIR_ON ? 'fair launch coins' : null,
    NFTS_ON ? 'NFT collections' : null,
    DN404_ON ? 'DN404 coins with NFTs' : null,
  ].filter(
    (t): t is string => t !== null,
  );

  return (
    <main className={styles.page}>
      <header className={styles.header} aria-labelledby="docs-title">
        <div>
          <p className={styles.eyebrow}>Guide</p>
          <h1 id="docs-title" className={styles.title}>How launching works</h1>
          <p className={styles.lede}>
            Everything you need to launch and trade on urufu labs, in plain words. If something here
            and the site ever disagree, trust what the site shows when you sign.
          </p>
        </div>
        <div className={styles.actions}>
          <Link href="/create" className="ui-btn" data-variant="primary" data-size="lg">
            Start a launch
          </Link>
        </div>
      </header>

      <div className={styles.layout}>
        <GuideToc label="Contents" items={sections.map((s) => ({ id: s.id, label: s.label }))} />

        <article className={styles.content}>
          <DocSection id="start" title="What you can launch">
            <p className={styles.prose}>
              Right now you can launch {launchTypes.join(', ').replace(/, ([^,]*)$/, ' and $1')}{' '}
              on Robinhood Chain. You don&apos;t need to write any code.
            </p>
            <FactList
              items={[
                'Coin: a token people trade. It starts on a price curve and moves to Uniswap once enough is bought.',
                ...(FAIR_ON
                  ? ['Fair launch: a coin built so snipers and bundles get no edge, and the creator only earns while they hold.']
                  : []),
                ...(NFTS_ON
                  ? ['NFT collection: art people mint at a price you set. You keep 90% of the mint money.']
                  : []),
                ...(DN404_ON
                  ? ['DN404: a coin and an NFT collection in one. Hold enough of the coin and you own an NFT.']
                  : []),
              ]}
            />
          </DocSection>

          <section id="coins" className={styles.section} aria-labelledby="coins-title">
            <h2 id="coins-title">Coins</h2>
            <div>
              <ol className={styles.steps}>
                {COIN_STEPS.map((step) => (
                  <li key={step.n}>
                    <span className={styles.stepNum}>{step.n}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <FactList
                items={[
                  'The curve: the coin starts with all of its supply on a price curve. Every buy pushes the price up a little, and every sell pulls it down.',
                  'Each trade on the curve pays a 1% fee to the platform.',
                  'A coin that never graduates can keep trading on its curve.',
                  'Nobody can change the coin after launch. That is on purpose, so buyers aren\'t trusting a person with a kill switch.',
                ]}
              />
            </div>
          </section>

          {FAIR_ON && (
            <DocSection id="fair" title="Fair launch">
              <p className={styles.prose}>
                A fair launch is a coin with rules that take away the usual head start. Bots,
                insiders and people splitting money across many wallets pay the same price as
                everyone else, and the creator only earns while they keep holding. Start from{' '}
                <Link href="/create/fair">the fair launch page</Link>.
              </p>
              <h3 className={styles.groupTitle}>The first minute</h3>
              <FactList
                items={[
                  'For the first 60 seconds there is no trading. Instead, anyone can put ETH into the opening batch.',
                  'When the minute is up, all of that ETH buys at once and everyone gets the same average price. Your share of the coins matches your share of the ETH.',
                  'The batch can buy at most 25% of the coins on the curve. If more ETH comes in than that needs, everyone gets the extra back, split the same way.',
                  'So being first, paying more gas, or splitting across wallets earns nothing extra.',
                  'After the minute, anyone can settle the batch, and each depositor collects their coins and any refund from the coin page.',
                ]}
              />
              <h3 className={styles.groupTitle}>The coin</h3>
              <FactList
                items={[
                  'Supply is fixed at 800,000,000 and all of it goes on the price curve. The creator gets no free share.',
                  'The coin has no owner and no tax. Nobody can mint more or change it later.',
                  'After the opening batch it trades on the curve like any other coin, with the same 1% fee.',
                  'It graduates to a Uniswap pool once about 8 ETH has been bought. The pool opens at the curve price and its money is locked forever.',
                  'The curve starts at a higher price than most launchpads, so a bundle or bot needs real money to grab a big share early, and the pool is deeper when it opens.',
                ]}
              />
              <h3 className={styles.groupTitle}>After graduation</h3>
              <FactList
                items={[
                  'Sniper tax: for the first 5 minutes in the pool, buys and sells pay an extra tax that starts at 20% and drops to 0%.',
                  'The sniper tax is burned, never paid to anyone, including us. Burning coins makes everyone else\'s share a bit bigger.',
                  'Pool trades then pay the usual fees: Uniswap\'s 0.3%, plus 1% to the platform and 1% to the creator.',
                ]}
              />
              <h3 className={styles.groupTitle}>How the creator earns</h3>
              <FactList
                items={[
                  'The creator earns 1% of pool trades only while they keep holding their coins.',
                  'If the creator sells or moves more than 10% of what they held at graduation, their 1% is burned from then on. This can\'t be undone.',
                  'If the creator holds less than 0.1% of the supply at graduation, there is no creator fee at all and it is burned instead.',
                  'Creator fees show up as confirming first and become claimable on the next trade, so a creator can\'t sell and grab the fee in the same go.',
                  'The creator claims their fees from the coin page.',
                ]}
              />
              <Callout tone="info" label="Launch fee">
                0.001 ETH or 1,000 URU, before holder discounts. You can also put ETH into the
                opening batch when you launch, at the same price as everyone else.
              </Callout>
              <Callout tone="warn" label="What it can't catch">
                The rules stop speed and wallet-splitting games, but they can&apos;t tell who owns
                a wallet. A creator can still buy from other wallets. The coin page warns you when
                a big early buyer was funded by the creator&apos;s wallet.
              </Callout>
            </DocSection>
          )}

          <DocSection id="whitelist" title="Early access for a community">
            <p className={styles.prose}>
              On an advanced launch you can give holders of another token or NFT collection a head
              start. You paste that collection&apos;s address and we take a snapshot of who holds it.
            </p>
            <FactList
              items={[
                'For the first hour, only wallets in the snapshot can buy.',
                '60% of the coin supply on the curve is set aside for them during that hour.',
                'One wallet can buy at most a fifth of that set-aside amount, so a single holder can\'t take it all.',
                'After the hour, anyone can buy.',
                'Early-access buyers collect their coins once the coin graduates.',
              ]}
            />
          </DocSection>

          <DocSection id="graduation" title="Graduation">
            <p className={styles.prose}>
              Graduation is when a coin has sold enough on its curve to move to a Uniswap trading
              pool. It happens automatically on the buy that crosses the line.
            </p>
            <FactList
              items={[
                'The pool opens at the same price the curve ended on, so there is no sudden jump or drop.',
                'The money in the pool is locked forever. Nobody, including you and us, can pull it out.',
                "Each trade in the pool pays Uniswap's normal 0.3% fee, plus 1% to the platform and 1% to the creator.",
                'Creator earnings only start after graduation.',
                'If you turned it on, trading in the new pool pauses for a short while right after graduation to stop bots from jumping in first.',
              ]}
            />
          </DocSection>

          {NFTS_ON && (
            <DocSection id="nfts" title="NFT collections">
              <p className={styles.prose}>
                Launch a collection of art that people mint. Make your art in urufu studio, publish
                it, then hit &ldquo;Launch as NFT&rdquo; and the form fills itself in. Or start from{' '}
                <Link href="/create/nft">the NFT launch page</Link> with your own art link.
              </p>
              <FactList
                items={[
                  'You choose the total number of NFTs and how many one wallet can mint.',
                  'The price can stay the same for every mint, or go up by a set amount after each mint.',
                  'Buyers pay in ETH or URU, your choice.',
                  'Optional early access: a list of wallets that can mint first, for a set window.',
                  'Optional discounts for people who hold another collection, like urufu gemu nft.',
                  'You keep 90% of every mint. 10% goes to the platform flywheel.',
                  'Withdraw your earnings from your profile page any time after the first mint.',
                  'After launch, set the collection name, picture and description that OpenSea shows, from your collection page.',
                ]}
              />
              <Callout tone="info" label="Launch fee">
                5,000 URU, before holder discounts. The fee is paid in URU.
              </Callout>
            </DocSection>
          )}

          {DN404_ON && (
            <DocSection id="dn404" title="DN404: a coin and NFTs in one">
              <p className={styles.prose}>
                A DN404 launch is a coin and an NFT collection that move together. You decide how
                many coins make one NFT. Hold that many and you own an NFT. Buy past the next
                multiple and another one shows up in your wallet. Sell or send below it and one
                disappears. There is no separate minting.
              </p>
              <h3 className={styles.groupTitle}>Setting it up</h3>
              <FactList
                items={[
                  'Make your art in urufu studio and hit "Launch as DN404", or fill in the form yourself.',
                  'Collection size: up to 10,000 NFTs.',
                  'Coins per NFT: you pick. Total supply is the collection size times coins per NFT.',
                  'Pair: buyers pay with ETH or URU.',
                  'Founder share: optionally keep up to 20% of the supply in your own wallet at launch. Buyers can see this.',
                  'Launch fee: 10,000 URU, before holder discounts.',
                ]}
              />
              <h3 className={styles.groupTitle}>Trading and graduation</h3>
              <FactList
                items={[
                  'It trades on a price curve first, just like a coin. Curve trades have a 1% fee.',
                  'When enough has been bought it moves to a Uniswap pool at the same price. Leftover coins are burned and the pool money is locked forever.',
                  'Optional: pause trading in the pool for a short while after graduation (up to 7,200 blocks, about 12 minutes) to stop bots.',
                  'Optional: burn part of every pool buy (up to 20%), which slowly shrinks supply.',
                ]}
              />
              <Callout tone="warn" label="Big trades">
                One buy or sell can create or remove at most 2,000 NFTs. That is a Robinhood Chain
                limit, not ours. If a trade would go over, the site tells you the most you can do
                in one go so you can split it.
              </Callout>
              <h3 className={styles.groupTitle}>Optional tax</h3>
              <p className={styles.prose}>
                You can add a tax of 0% to 5%. You pick the rate at launch and it can never change.
                The tax is taken when someone buys from the trading pool and when coins move from
                one wallet to another. It is not taken on curve trades or on sells into the
                trading pool. Here is what the tax can do:
              </p>
              <FactList
                items={DN404_TAX_MODES.filter((m) => m.value !== 0).map(
                  (m) => `${m.label}: ${m.description}.`,
                )}
              />
              <FactList
                items={[
                  'Our automated helper collects the tax and carries out your choice for you. It keeps 5% of each payout to cover gas and upkeep.',
                  'Some trading apps that route through their own contracts may fail to sell taxed coins. Selling on this site and in the Uniswap app works.',
                ]}
              />
            </DocSection>
          )}

          {(NFTS_ON || DN404_ON) && (
            <DocSection id="market" title="Buying and selling NFTs">
              <p className={styles.prose}>
                The NFT marketplace lists NFTs from collections launched on urufu, both NFT and
                DN404 collections. There is no marketplace fee: the seller gets the full price.
              </p>
              <FactList
                items={[
                  'To sell, open Market, then Sell, and pick a price and how long the listing lasts (up to 180 days).',
                  'The first time you sell from a collection, you approve the marketplace with one transaction. After that, listing is a free signature.',
                  'Sales go through Seaport, the open trading contract OpenSea also uses. The NFT and the ETH swap in one transaction. If either side fails, nothing moves.',
                  'Cancelling a listing or changing its price is a transaction. Cancel all listings ends every listing from your wallet at once.',
                  'If you move or sell an NFT you listed, its listing stops showing and can no longer be bought.',
                ]}
              />
              {DN404_ON && (
                <FactList
                  items={[
                    'Selling a DN404 NFT also sends the coins behind it to the buyer.',
                    'If you sell those coins first, the NFT goes away and its listing stops working.',
                    'Each DN404 listing shows the token value of 1 NFT, so you can see how much of the price is for the art.',
                  ]}
                />
              )}
            </DocSection>
          )}

          <DocSection id="agents" title="Using an AI agent">
            <p className={styles.prose}>
              You can ask an AI assistant like Claude or Cursor to do things on urufu for you: look up a
              coin, launch one, buy or sell, join a fair launch, or claim creator fees. The assistant
              gets the details and prepares the transaction. You still check it and sign it in your
              own wallet.
            </p>
            <h3 className={styles.groupTitle}>Connect your assistant</h3>
            <FactList
              items={[
                'If your assistant supports MCP (Claude, Cursor and others do), add this server: https://urufulabs.xyz/api/mcp',
                "If it doesn't, give it this link and ask it to follow the instructions: https://urufulabs.xyz/agent-skill.md",
                'Then just ask in plain words, like "launch a fair coin called Calm Pond with a 0.01 ETH deposit" or "buy 0.05 ETH of this coin".',
              ]}
            />
            <h3 className={styles.groupTitle}>How it stays safe</h3>
            <FactList
              items={[
                'urufu never asks for or accepts your private key or seed phrase. If anything asks you for one, it is a scam.',
                'Every action comes back as a transaction for your wallet to sign. Nothing moves until you approve it.',
                "Before you sign, your assistant should show you the coin, the amounts and the total ETH. If the numbers don't match what you asked for, don't sign.",
                'Coin names and descriptions are written by whoever launched the coin. Your assistant is told never to follow instructions found in them.',
                'Buys and sells include a price limit (2% by default), so a trade fails instead of filling at a much worse price.',
              ]}
            />
            <h3 className={styles.groupTitle}>The Agent badge</h3>
            <FactList
              items={[
                'If you run an AI agent that trades from its own wallet, you can register that wallet. Your assistant can walk you through it.',
                'Its trades then show an Agent badge with a link to you as the owner, so nobody mistakes it for a person.',
                "Registration uses the public agent registry on Robinhood Chain (ERC-8004). Both your wallet and the agent's wallet sign, so nobody can put the badge on a wallet they don't control.",
                'If the agent changes hands or its wallet changes, the badge goes away.',
              ]}
            />
            <h3 className={styles.groupTitle}>Letting an agent trade on its own</h3>
            <FactList
              items={[
                "If you want an agent to trade without asking you each time, give it its own account: a Safe wallet that you own, with spending rules set on chain.",
                'The agent can only use urufu, only trade the coins you list, and everything it buys lands in your Safe.',
                'It can spend at most 0.05 ETH per trade and 0.25 ETH per day unless you change that, and it can only sell a limited amount of each coin per day. Anything beyond the rules simply fails.',
                'You can stop it at any time with one transaction, and the money in the Safe stays yours.',
                'Your assistant can set this up for you, or you can do it yourself on the Launch an agent page (/agent/new). You sign every step from your own wallet.',
              ]}
            />
            <Callout tone="warn" label="Start small">
              Only put in the Safe what you&apos;re happy for the agent to spend. The rules cap
              how fast it can spend, not whether its trades are good ones.
            </Callout>
            <h3 className={styles.groupTitle}>An agent with its own coin</h3>
            <FactList
              items={[
                "You can launch a coin for your agent on the Fair lane, with the agent's Safe as its creator. The creator fee then goes to the Safe.",
                'The agent can buy its coin and collect its fees, but it can never sell or move it. On the Fair lane the creator fee is burned for good if the creator sells, or holds more than 10% less than at graduation.',
                'You can still sell from the Safe yourself, but that burns the fee.',
                'Every agent account has a public page at /agent/ followed by its Safe address: who owns it, its limits, its coin and its trades, all read from the chain.',
              ]}
            />
          </DocSection>

          <DocSection id="fees" title="Fees and discounts">
            <div className={styles.metrics}>
              <Metric label="Curve trades" value="1%" />
              <Metric label="Pool trades" value="0.3% + 2%" />
              <Metric label="Max holder discount" value="50%" />
            </div>
            <FactList
              items={[
                'Launch fees go 40% to buying back URU, 35% to urufu gemu nft holders, and 25% to the treasury.',
                "Pool trades pay Uniswap's 0.3%, plus 1% to the platform and 1% to the creator.",
                'Hold at least one urufu gemu nft: 20% off launch fees.',
                'Hold at least 100,000 URU: 40% off.',
                'Hold both: 50% off.',
                'Discounts only lower the launch fee. Gas and trading fees still apply.',
              ]}
            />
          </DocSection>

          <DocSection id="risk" title="Risks">
            <div className={styles.cards}>
              <Risk title="Anyone can launch" body="We do not check what creators promise, whether their art is original, or whether anyone will want to buy." />
              <Risk title="Selling can be hard" body="You can only sell if there are buyers or enough money on the curve or in the pool. A coin can lose most of its value." />
              <Risk title="Locked forever" body="Pool money is locked forever. That stops rug pulls, but it also means nobody can rescue a market that goes badly." />
              <Risk title="Fees add up" body="Launch fees, trade fees and gas are real costs, even with a discount." />
              <Risk title="Platform controls" body="Some platform-level settings can still be changed by us, like fee routing. Coins themselves cannot be changed after launch." />
              <Risk title="Not audited yet" body="The contracts have had internal reviews and heavy testing, but no outside audit yet. Only put in what you can afford to lose." />
            </div>
          </DocSection>

          <DocSection id="faq" title="FAQ">
            <div className={styles.faq}>
            <FAQ q="Do I need to code?">
              No. You fill in a form and sign one transaction.
            </FAQ>
            <FAQ q="Can I launch an NFT collection here?">
              {NFTS_ON || DN404_ON
                ? 'Yes. Use the NFT launch for art people mint, or DN404 for a coin that comes with NFTs.'
                : 'Not yet. Right now you can launch coins. You can still use an NFT collection as the community for an early-access window.'}
            </FAQ>
            {DN404_ON && (
              <FAQ q="Why did one of my DN404 NFTs disappear?">
                Your coin balance dropped below a multiple of the coins-per-NFT number, usually
                because you sold or sent some coins. Buy back over the line and you get an NFT
                again, though it may be a different one.
              </FAQ>
            )}
            <FAQ q="What if my coin never graduates?">
              It keeps trading on its curve. Creator earnings from the pool only start after
              graduation.
            </FAQ>
            <FAQ q="How do creators get paid?">
              Coin creators earn 1% of every trade in the pool after graduation.
              {FAIR_ON ? ' On a fair launch, only while they keep holding.' : ''}
              {NFTS_ON ? ' NFT creators keep 90% of every mint and withdraw from their profile page.' : ''}
            </FAQ>
            <FAQ q="Where do I get funds back from an old, retired curve?">
              Use the <Link href="/recover">recovery page</Link>. It is only for old curves that
              no longer show in the app.
            </FAQ>
            </div>
          </DocSection>
        </article>

        <aside className={styles.rail} aria-label="Quick notes">
          <section className={styles.railCard}>
            <span className={styles.calloutLabel}>You can launch</span>
            <b>{launchTypes.join(', ').replace(/^c/, 'C')}</b>
            <p>All on Robinhood Chain.</p>
          </section>
          <section className={styles.railCard}>
            <span className={styles.calloutLabel}>Before you launch</span>
            <FactList
              compact
              items={[
                'Pick a name and ticker you are happy with. They can\'t change later.',
                'Quick launch is the safe choice if you are unsure.',
                'Read the fee and the wallet prompt before you sign.',
              ]}
            />
          </section>
          <section className={styles.railCard} data-tone="warn">
            <span className={styles.calloutLabel}>What counts</span>
            <p>
              Fees and settings shown when you sign are the real ones. Old screenshots and copied
              posts can be out of date.
            </p>
          </section>
          <section className={styles.railCard}>
            <span className={styles.calloutLabel}>Old curves</span>
            <p>Funds on retired curves are handled on a separate page.</p>
            <Link href="/recover" className="ui-btn" data-block="true">
              Open recovery
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}

function DocSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className={styles.section}>
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function FactList({ items }: { items: string[]; compact?: boolean }) {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Callout({ tone, label, children }: { tone: 'info' | 'warn'; label: string; children: React.ReactNode }) {
  return (
    <div className={styles.callout} data-tone={tone}>
      <span className={styles.calloutLabel}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Risk({ title, body }: { title: string; body: string }) {
  return (
    <article className={styles.card}>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details>
      <summary>{q}</summary>
      <div>{children}</div>
    </details>
  );
}
