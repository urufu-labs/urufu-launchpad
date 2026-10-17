'use client';

/// Public guide for launching on Urufu (Robinhood chain). Written for
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
  NFT_LAUNCHES_ENABLED,
  type ChainKey,
} from '@/lib/config';
import styles from '@/styles/guide.module.css';

type Section = { id: string; label: string; show: boolean };

const CHAIN: ChainKey = CHAINS_ENABLED[0]!;
const NFTS_ON = NFT_LAUNCHES_ENABLED[CHAIN] === true;
const DN404_ON = DN404_LAUNCHES_ENABLED[CHAIN] === true;

const SECTIONS: Section[] = [
  { id: 'start', label: 'what you can launch', show: true },
  { id: 'coins', label: 'coins', show: true },
  { id: 'whitelist', label: 'early access for a community', show: true },
  { id: 'graduation', label: 'graduation', show: true },
  { id: 'nfts', label: 'nft collections', show: NFTS_ON },
  { id: 'dn404', label: 'dn404 (coin + nfts)', show: DN404_ON },
  { id: 'fees', label: 'fees and discounts', show: true },
  { id: 'risk', label: 'risks', show: true },
  { id: 'faq', label: 'faq', show: true },
];

const COIN_STEPS = [
  {
    n: '01',
    title: 'name it',
    body: 'pick a name, ticker, picture, description and links. this is what people see on the coin page.',
  },
  {
    n: '02',
    title: 'pick a setup',
    body: 'quick launch uses safe defaults. custom lets you add extras like a community early-access window, a short trading pause at graduation, or a buy-and-burn on every trade.',
  },
  {
    n: '03',
    title: 'launch',
    body: 'you pay the launch fee and sign one transaction. the coin goes live right away and nobody, including you, keeps admin control over it.',
  },
  {
    n: '04',
    title: 'trade on the curve',
    body: 'people buy and sell straight away. the price rises as people buy and falls as they sell.',
  },
  {
    n: '05',
    title: 'graduate',
    body: 'once enough has been bought, the coin moves to a Uniswap trading pool at the same price, and that pool money is locked forever.',
  },
];

export default function DocsPage() {
  const sections = SECTIONS.filter((s) => s.show);
  const launchTypes = ['coins', NFTS_ON ? 'nft collections' : null, DN404_ON ? 'dn404 coins with nfts' : null].filter(
    (t): t is string => t !== null,
  );

  return (
    <main className={styles.page}>
      <header className={styles.header} aria-labelledby="docs-title">
        <div>
          <p className={styles.eyebrow}>urufu guide</p>
          <h1 id="docs-title" className={styles.title}>How launching works</h1>
          <p className={styles.lede}>
            Everything you need to launch and trade on Urufu, in plain words. If something here
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
              Right now you can launch {launchTypes.join(', ').replace(/, ([^,]*)$/, ' and $1')} on
              Robinhood chain. You do not need to write any code.
            </p>
            <FactList
              items={[
                'coin: a token people trade. it starts on a price curve and moves to Uniswap once enough is bought.',
                ...(NFTS_ON
                  ? ['nft collection: art people mint at a price you set. you keep 90% of the mint money.']
                  : []),
                ...(DN404_ON
                  ? ['dn404: a coin and an nft collection in one. hold enough of the coin and you own an nft.']
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
                  'the curve: the coin starts with all of its supply on a price curve. every buy pushes the price up a little, every sell pulls it down.',
                  'each trade on the curve pays a 1% fee to the platform.',
                  'a coin that never graduates can keep trading on its curve.',
                  'nobody can change the coin after launch. that is on purpose, so buyers are not trusting a person with a kill switch.',
                ]}
              />
            </div>
          </section>

          <DocSection id="whitelist" title="Early access for a community">
            <p className={styles.prose}>
              On a custom launch you can give holders of another token or nft collection a head
              start. You paste that collection&apos;s address and we take a snapshot of who holds it.
            </p>
            <FactList
              items={[
                'for the first hour, only wallets in the snapshot can buy.',
                '60% of the coin supply on the curve is set aside for them during that hour.',
                'one wallet can buy at most a fifth of that set-aside amount, so a single holder cannot take it all.',
                'after the hour, anyone can buy.',
                'early-access buyers collect their coins once the coin graduates.',
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
                'the pool opens at the same price the curve ended on, so there is no sudden jump or drop.',
                'the money in the pool is locked forever. nobody, including you and us, can pull it out.',
                "each trade in the pool pays Uniswap's normal 0.3% fee, plus 1% to the platform and 1% to the creator.",
                'creator earnings only start after graduation.',
                'if you turned it on, trading in the new pool can be paused for a short while right after graduation to stop bots from jumping in first.',
              ]}
            />
          </DocSection>

          {NFTS_ON && (
            <DocSection id="nfts" title="NFT collections">
              <p className={styles.prose}>
                Launch a collection of art that people mint. Make your art in urufu studio, publish
                it, then hit &ldquo;launch as nft&rdquo; and the form fills itself in. Or start from{' '}
                <Link href="/create/nft">the nft launch page</Link> with your own art link.
              </p>
              <FactList
                items={[
                  'you choose the total number of nfts and how many one wallet can mint.',
                  'price can stay the same for every mint, or go up by a set amount after each mint.',
                  'buyers pay in ETH or URU, your choice.',
                  'optional early access: a list of wallets that can mint first, for a set window.',
                  'optional discounts for people who hold another collection, like urufu gemu nft.',
                  'you keep 90% of every mint. 10% goes to the platform flywheel.',
                  'withdraw your earnings from your profile page any time after the first mint.',
                  'after launch, set the collection name, picture and description that OpenSea shows from your collection page.',
                ]}
              />
              <Callout tone="info" label="launch fee">
                5,000 URU, before holder discounts. The fee is paid in URU.
              </Callout>
            </DocSection>
          )}

          {DN404_ON && (
            <DocSection id="dn404" title="DN404: a coin and NFTs in one">
              <p className={styles.prose}>
                A dn404 launch is a coin and an nft collection that move together. You decide how
                many coins make one nft. Hold that many and you own an nft. Buy past the next
                multiple and another one shows up in your wallet. Sell or send below it and one
                disappears. There is no separate minting.
              </p>
              <h3 className={styles.groupTitle}>setting it up</h3>
              <FactList
                items={[
                  'make your art in urufu studio and hit "launch as dn404", or fill in the form yourself.',
                  'collection size: up to 10,000 nfts.',
                  'coins per nft: you pick. total supply is collection size times coins per nft.',
                  'pair: buyers pay with ETH or URU.',
                  'founder share: optionally keep up to 20% of the supply in your own wallet at launch. buyers can see this.',
                  'launch fee: 10,000 URU, before holder discounts.',
                ]}
              />
              <h3 className={styles.groupTitle}>trading and graduation</h3>
              <FactList
                items={[
                  'it trades on a price curve first, just like a coin. curve trades have a 1% fee.',
                  'when enough has been bought it moves to a Uniswap pool at the same price. leftover coins are burned and the pool money is locked forever.',
                  'optional: pause trading in the pool for a short while after graduation (up to 7,200 blocks, about 12 minutes) to stop bots.',
                  'optional: burn part of every pool buy (up to 20%), which slowly shrinks supply.',
                ]}
              />
              <Callout tone="warn" label="big trades">
                One buy or sell can create or remove at most 2,000 nfts. That is a Robinhood chain
                limit, not ours. If a trade would go over, the site tells you the most you can do
                in one go so you can split it.
              </Callout>
              <h3 className={styles.groupTitle}>optional tax</h3>
              <p className={styles.prose}>
                You can add a tax of 0% to 5%. You pick the rate at launch and it can never change.
                The tax is taken when someone buys from the trading pool and when coins move from
                one wallet to another. It is not taken on curve trades or on sells into the
                trading pool. Here is what the tax can do:
              </p>
              <FactList
                items={DN404_TAX_MODES.filter((m) => m.value !== 0).map(
                  (m) => `${m.label.toLowerCase()}: ${m.description}.`,
                )}
              />
              <FactList
                items={[
                  'our automated helper collects the tax and carries out your choice for you. it keeps 5% of each payout to cover gas and upkeep.',
                  'some trading apps that route through their own contracts may fail to sell taxed coins. selling on this site and in the Uniswap app works.',
                ]}
              />
            </DocSection>
          )}

          <DocSection id="fees" title="Fees and discounts">
            <div className={styles.metrics}>
              <Metric label="curve trades" value="1%" />
              <Metric label="pool trades" value="0.3% + 2%" />
              <Metric label="max holder discount" value="50%" />
            </div>
            <FactList
              items={[
                'launch fees go 40% to buying back URU, 35% to urufu gemu nft holders, and 25% to the treasury.',
                "pool trades pay Uniswap's 0.3%, plus 1% to the platform and 1% to the creator.",
                'hold at least one urufu gemu nft: 20% off launch fees.',
                'hold at least 100,000 URU: 40% off.',
                'hold both: 50% off.',
                'discounts only lower the launch fee. gas and trading fees still apply.',
              ]}
            />
          </DocSection>

          <DocSection id="risk" title="Risks">
            <div className={styles.cards}>
              <Risk title="anyone can launch" body="We do not check what creators promise, whether their art is original, or whether anyone will want to buy." />
              <Risk title="selling can be hard" body="You can only sell if there are buyers or enough money on the curve or in the pool. A coin can lose most of its value." />
              <Risk title="locked forever" body="Pool money is locked forever. That stops rug pulls, but it also means nobody can rescue a market that goes badly." />
              <Risk title="fees add up" body="Launch fees, trade fees and gas are real costs, even with a discount." />
              <Risk title="platform controls" body="Some platform-level settings can still be changed by us, like fee routing. Coins themselves cannot be changed after launch." />
              <Risk title="not audited yet" body="The contracts have had internal reviews and heavy testing, but no outside audit yet. Only put in what you can afford to lose." />
            </div>
          </DocSection>

          <DocSection id="faq" title="FAQ">
            <div className={styles.faq}>
            <FAQ q="Do I need to code?">
              No. You fill in a form and sign one transaction.
            </FAQ>
            <FAQ q="Can I launch an NFT collection here?">
              {NFTS_ON || DN404_ON
                ? 'Yes. Use the nft launch for art people mint, or dn404 for a coin that comes with nfts.'
                : 'Not yet. Right now you can launch coins. You can still use an nft collection as the community for an early-access window.'}
            </FAQ>
            {DN404_ON && (
              <FAQ q="Why did one of my dn404 nfts disappear?">
                Your coin balance dropped below a multiple of the coins-per-nft number, usually
                because you sold or sent some coins. Buy back over the line and you get an nft
                again, though it may be a different one.
              </FAQ>
            )}
            <FAQ q="What if my coin never graduates?">
              It keeps trading on its curve. Creator earnings from the pool only start after
              graduation.
            </FAQ>
            <FAQ q="How do creators get paid?">
              Coin creators earn 1% of every trade in the pool after graduation.
              {NFTS_ON ? ' Nft creators keep 90% of every mint and withdraw from their profile page.' : ''}
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
            <span className={styles.calloutLabel}>you can launch</span>
            <b>{launchTypes.join(', ')}</b>
            <p>All on Robinhood chain.</p>
          </section>
          <section className={styles.railCard}>
            <span className={styles.calloutLabel}>before you launch</span>
            <FactList
              compact
              items={[
                'pick a name and ticker you are happy with. they cannot change later.',
                'quick launch is the safe choice if you are unsure.',
                'read the fee and the wallet prompt before you sign.',
              ]}
            />
          </section>
          <section className={styles.railCard} data-tone="warn">
            <span className={styles.calloutLabel}>what counts</span>
            <p>
              Fees and settings shown when you sign are the real ones. Old screenshots and copied
              posts can be out of date.
            </p>
          </section>
          <section className={styles.railCard}>
            <span className={styles.calloutLabel}>old curves</span>
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
