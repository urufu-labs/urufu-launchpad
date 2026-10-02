'use client';

/// "What you can add" page. Plain-language list of the options a creator can
/// pick for each launch type. Contract addresses, config hashes and module ids
/// live in one collapsed "for developers" section at the bottom so nothing is
/// lost for builders. NFT and DN404 sections follow their launch flags.
/// Copy rules are enforced by src/app/docs/copy.test.mjs.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useChainId } from 'wagmi';

import styles from './catalog.module.css';
import { MODULES, configHashFor, type ModuleSpec } from '@/lib/modules';
import {
  CHAINS_ENABLED,
  CONTRACTS,
  CHAIN_LABELS,
  DN404_LAUNCHES,
  DN404_LAUNCHES_ENABLED,
  DN404_TAX_MODES,
  NFT_LAUNCHES,
  NFT_LAUNCHES_ENABLED,
  type ChainKey,
} from '@/lib/config';
import { CHAIN_ID_TO_KEY, explorerAddressUrl } from '@/lib/wagmi';

/// Plain-language text for each coin module, keyed by module id. The module
/// registry (shared/matrix.json) is shared with the build service, so the
/// friendly wording lives here instead of editing that file.
const PLAIN: Record<string, { name: string; what: string }> = {
  Permit: { name: 'gasless approvals', what: 'holders can approve a trade with a signature instead of a separate transaction, which saves gas.' },
  Votes: { name: 'voting power', what: 'holders can hand their voting power to themselves or someone else. you need this if you want on-chain votes later.' },
  Staking: { name: 'staking pool', what: 'holders lock the coin to earn more of it. you put the rewards in up front and they pay out evenly over a set time.' },
  Vesting: { name: 'vesting schedule', what: 'part of the supply goes to one wallet and is released bit by bit between a start date and an end date.' },
  AntiBot: { name: 'bot gate', what: 'only wallets you approve can buy for the first few blocks.' },
  AntiWhale: { name: 'whale caps', what: 'limits how much one wallet can hold or move for a while after launch.' },
  Pausable: { name: 'emergency pause', what: 'lets the owner stop all transfers.' },
  FeeOnTransfer: { name: 'tax on trade', what: 'every transfer pays a small tax that is burned or sent to a wallet.' },
  Blocklist: { name: 'blocklist', what: 'the owner could block specific wallets from sending or receiving the coin.' },
  Jailable: { name: 'fund recovery', what: 'the owner could move coins out of a blocked wallet to a recovery wallet.' },
  B20PolicyAware: { name: 'rules registry', what: 'every transfer would be checked against a shared rules list before it goes through.' },
};

/// Built into every coin launch automatically (the bonding curve graduates
/// into a pool on the platform hook), so they are not choices.
const BUILT_IN_HOOKS = new Set(['LPLocked', 'FeeRedirect', 'MultiHookHost']);
/// Pool options picked at launch time, applied at graduation.
const POOL_OPTIONS = new Set(['AntiSniper', 'BuybackBurn']);

const RECIPES: Array<{
  label: string;
  stance: string;
  modules: string[];
  implKey: 'ERC20TemplateImpl' | 'ERC20WithAntiBotImpl' | 'ERC20WithFoTImpl';
}> = [
  { label: 'plain coin', stance: 'the default coin contract', modules: [], implKey: 'ERC20TemplateImpl' },
  { label: 'bot gate coin', stance: 'adds the bot gate; not usable with curve launches', modules: ['AntiBot'], implKey: 'ERC20WithAntiBotImpl' },
  { label: 'taxed coin', stance: 'adds a transfer tax; not usable with curve launches', modules: ['FeeOnTransfer'], implKey: 'ERC20WithFoTImpl' },
];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AddrLink({ chain, addr }: { chain: ChainKey | null; addr: string | undefined }) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    return <span className={styles.muted}>not deployed</span>;
  }
  if (!chain) return <code className={styles.address}>{short(addr)}</code>;
  return (
    <Link href={explorerAddressUrl(chain, addr)} target="_blank" className={styles.addressLink}>
      {short(addr)}
    </Link>
  );
}

export default function CatalogPage() {
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const activeChain = mounted ? (CHAIN_ID_TO_KEY[chainId] ?? null) : null;
  const targetChain: ChainKey = CHAINS_ENABLED[0]!;
  const chainKey = activeChain && CHAINS_ENABLED.includes(activeChain) ? activeChain : targetChain;
  const contracts = CONTRACTS[chainKey];
  const nftsOn = NFT_LAUNCHES_ENABLED[chainKey] === true;
  const dn404On = DN404_LAUNCHES_ENABLED[chainKey] === true;

  const coinModules = useMemo(() => MODULES.filter((m) => m.bases.includes('ERC20')), []);
  const shipped = coinModules.filter((m) => m.status === 'shipped');
  const extras = shipped.filter(
    (m) => !BUILT_IN_HOOKS.has(m.id) && !POOL_OPTIONS.has(m.id) && !m.requiresOwner && !m.taxesTransfers,
  );
  const notOnCurve = shipped.filter((m) => m.requiresOwner || m.taxesTransfers);
  const later = coinModules.filter((m) => m.status === 'planned');

  const index = [
    { id: 'coins', label: 'coins', jp: '硬貨', show: true },
    { id: 'nfts', label: 'nft collections', jp: '絵札', show: nftsOn },
    { id: 'dn404', label: 'dn404', jp: '二重', show: dn404On },
    { id: 'later', label: 'coming later', jp: '予定', show: true },
    { id: 'developers', label: 'for developers', jp: '開発', show: true },
  ].filter((e) => e.show);

  return (
    <main className={styles.page}>
      <header className={styles.specHeader}>
        <div>
          <p>launch options · {CHAIN_LABELS[chainKey]}</p>
          <h1>What you can add</h1>
        </div>
      </header>

      <div className={styles.referenceLayout}>
        <aside className={styles.indexRail} aria-label="Sections">
          <div className={styles.indexTitle}>
            <span>sections</span>
            <small>目次</small>
          </div>
          <nav>
            {index.map((entry) => (
              <a key={entry.id} href={`#${entry.id}`}>
                <span>{entry.label}</span>
                <small>{entry.jp}</small>
              </a>
            ))}
          </nav>
          <div className={styles.indexActions}>
            <Link href="/create" className="uru-btn uru-btn-primary">
              create <span className="uru-arrow">→</span>
            </Link>
            <Link href="/docs" className="uru-btn uru-btn-cream">
              how it works
            </Link>
          </div>
        </aside>

        <section className={styles.sheet} aria-label="Launch options">
          <SectionHead
            id="coins"
            title="Coins"
            jp="硬貨"
            sub="Quick launch uses safe defaults. Custom launch lets you add the extras below."
          />
          <PlainList
            title="every coin comes with"
            items={[
              { name: 'price curve', what: 'trading starts right away. the price goes up as people buy and down as they sell.' },
              { name: 'locked pool', what: 'when it graduates, the coin moves to a Uniswap pool and that money is locked forever.' },
              { name: 'creator earnings', what: 'after graduation you earn 1% of every trade in the pool.' },
              { name: 'no admin keys', what: 'nobody, including you, can change or pause the coin after launch.' },
            ]}
          />
          <PlainList
            title="extras you can add"
            items={[
              { name: 'early access for a community', what: 'holders of another token or nft collection get the first hour to buy, with 60% of the curve set aside for them.' },
              { name: 'graduation pause', what: 'pool trading waits a short while after graduation (up to 7,200 blocks, about 12 minutes) so bots cannot jump in first.' },
              { name: 'buy and burn', what: 'part of every pool buy (up to 20%) is burned, so supply slowly shrinks.' },
              ...extras.map((m) => PLAIN[m.id] ?? { name: m.label.replace(/^✿\s*/, ''), what: m.description }),
            ]}
          />
          {notOnCurve.length > 0 && (
            <PlainList
              title="not available on curve launches"
              note="These need an owner who keeps control, or they tax every transfer. Curve coins have no owner and no transfer tax, so these are switched off."
              items={notOnCurve.map((m) => PLAIN[m.id] ?? { name: m.label.replace(/^✿\s*/, ''), what: m.description })}
            />
          )}

          {nftsOn && (
            <>
              <SectionHead
                id="nfts"
                title="NFT collections"
                jp="絵札"
                sub="Art that people mint. Start from urufu studio with launch as nft, or fill in the form."
              />
              <PlainList
                title="you choose"
                items={[
                  { name: 'size', what: 'the total number of nfts, and how many one wallet can mint.' },
                  { name: 'price', what: 'the same price for every mint, or a price that goes up by a set amount after each mint.' },
                  { name: 'payment', what: 'buyers pay in ETH or URU.' },
                  { name: 'early access', what: 'a list of wallets that can mint first, for a set window.' },
                  { name: 'holder discounts', what: 'a lower price for people who hold another collection, like urufu gemu nft.' },
                  { name: 'opensea info', what: 'after launch, set the collection name, picture and description OpenSea shows.' },
                ]}
              />
              <PlainList
                title="how money moves"
                items={[
                  { name: 'your cut', what: 'you keep 90% of every mint and withdraw it from your profile page.' },
                  { name: 'platform cut', what: '10% of every mint goes to the platform flywheel.' },
                  { name: 'launch fee', what: '5,000 URU, before holder discounts.' },
                ]}
              />
            </>
          )}

          {dn404On && (
            <>
              <SectionHead
                id="dn404"
                title="DN404"
                jp="二重"
                sub="A coin and an nft collection in one. Hold enough coins and you own an nft."
              />
              <PlainList
                title="you choose"
                items={[
                  { name: 'collection size', what: 'up to 10,000 nfts.' },
                  { name: 'coins per nft', what: 'how many coins equal one nft. holding a multiple gives you that many nfts.' },
                  { name: 'pair', what: 'buyers pay with ETH or URU.' },
                  { name: 'founder share', what: 'keep up to 20% of the supply in your wallet at launch.' },
                  { name: 'graduation pause', what: 'pool trading waits up to 7,200 blocks (about 12 minutes) after graduation.' },
                  { name: 'buy and burn', what: 'part of every pool buy (up to 20%) is burned.' },
                  { name: 'tax', what: '0% to 5%, fixed forever at launch. taken on pool buys and wallet transfers, not on sells into the pool or curve trades.' },
                ]}
              />
              <PlainList
                title="what the tax can do"
                note="Our automated helper carries out your choice and keeps 5% of each payout for gas and upkeep."
                items={DN404_TAX_MODES.filter((m) => m.value !== 0).map((m) => ({
                  name: m.label.toLowerCase(),
                  what: `${m.description}.`,
                }))}
              />
              <PlainList
                title="good to know"
                items={[
                  { name: 'big trades', what: 'one buy or sell can create or remove at most 2,000 nfts, a Robinhood chain limit. split bigger trades.' },
                  { name: 'launch fee', what: '10,000 URU, before holder discounts.' },
                  { name: 'trading apps', what: 'some apps that route through their own contracts may fail to sell taxed coins. this site and the Uniswap app work.' },
                ]}
              />
            </>
          )}

          <SectionHead id="later" title="Coming later" jp="予定" sub="Planned, not available yet." />
          <PlainList items={later.map((m) => PLAIN[m.id] ?? { name: m.label, what: m.description })} />

          <div id="developers" className={styles.sectionHead}>
            <div>
              <h2>For developers</h2>
              <span>開発</span>
            </div>
            <p>Contract addresses, module ids and config hashes.</p>
          </div>
          <details>
            <summary>show contract details</summary>
            <h3>coin launch contracts</h3>
            <div className={styles.coreTable}>
              <StackRow name="NameRegistry" role="reserves names and tickers" chain={chainKey} addr={contracts?.NameRegistry} />
              <StackRow name="Router" role="launch entry point and fee handling" chain={chainKey} addr={contracts?.Router} />
              <StackRow name="FeeReceiver" role="platform fee receiver" chain={chainKey} addr={contracts?.FeeReceiver} />
              <StackRow name="ERC20Factory" role="deploys coin contracts" chain={chainKey} addr={contracts?.ERC20Factory} />
            </div>
            <h3>nft launch contracts</h3>
            <div className={styles.coreTable}>
              <StackRow name="NftLaunchFactory" role="deploys collection and mint module" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.LaunchFactory} />
              <StackRow name="ERC721 impl" role="copied per collection" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.Erc721Impl} />
              <StackRow name="Mint module impl" role="pricing, discounts, mint accounting" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.MintModuleImpl} />
              <StackRow name="Whitelist module impl" role="optional early-access gate" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.WhitelistModuleImpl} />
            </div>
            <h3>dn404 launch contracts</h3>
            <div className={styles.coreTable}>
              <StackRow name="Dn404LaunchFactory" role="deploys coin, mirror nft and curve" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.LaunchFactory} />
              <StackRow name="Dn404CurveFactory" role="curves for ERC-20 pairs (URU)" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.CurveFactory} />
              <StackRow name="Dn404 MultiHookHost" role="pool hook for ERC-20-paired graduations" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.MultiHookHost} />
              <StackRow name="Base impl" role="dn404 coin template" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.BaseImpl} />
              <StackRow name="Mirror impl" role="dn404 nft template" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.MirrorImpl} />
            </div>
            <h3>coin modules</h3>
            <div className={styles.specimenList}>
              {coinModules.map((mod) => (
                <ModSpecimen key={mod.id} mod={mod} />
              ))}
            </div>
            <h3>registered coin configurations</h3>
            <div className={styles.recipeTable} role="table" aria-label="Registered coin configurations">
              <div className={styles.recipeHead} role="row">
                <span>configuration</span>
                <span>modules</span>
                <span>hash</span>
                <span>impl</span>
              </div>
              {RECIPES.map((recipe) => {
                const hash = configHashFor('ERC20', recipe.modules);
                const implAddress = contracts?.[recipe.implKey] as string | undefined;
                return (
                  <div key={recipe.label} className={styles.recipeRow} role="row">
                    <div>
                      <b>{recipe.label}</b>
                      <p>{recipe.stance}</p>
                    </div>
                    <span>{recipe.modules.length ? recipe.modules.join(' + ') : 'none'}</span>
                    <code>{hash.slice(0, 22)}…</code>
                    <AddrLink chain={chainKey} addr={implAddress} />
                  </div>
                );
              })}
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}

function SectionHead({ id, title, jp, sub }: { id: string; title: string; jp: string; sub: string }) {
  return (
    <div id={id} className={styles.sectionHead}>
      <div>
        <h2>{title}</h2>
        <span>{jp}</span>
      </div>
      <p>{sub}</p>
    </div>
  );
}

function PlainList({
  title,
  note,
  items,
}: {
  title?: string;
  note?: string;
  items: Array<{ name: string; what: string }>;
}) {
  return (
    <div className={styles.specimenList}>
      {title && <h3>{title}</h3>}
      {note && <p>{note}</p>}
      {items.map((item) => (
        <article key={item.name} className={styles.specimen}>
          <div className={styles.specimenBody}>
            <div className={styles.specimenTitle}>
              <h3>{item.name}</h3>
            </div>
            <p>{item.what}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function StackRow({
  name,
  role,
  chain,
  addr,
}: {
  name: string;
  role: string;
  chain: ChainKey | null;
  addr: string | undefined;
}) {
  return (
    <div className={styles.stackRow}>
      <b>{name}</b>
      <span>{role}</span>
      <AddrLink chain={chain} addr={addr} />
    </div>
  );
}

function ModSpecimen({ mod }: { mod: ModuleSpec }) {
  return (
    <article className={styles.specimen} data-planned={mod.status === 'planned' ? 'true' : undefined}>
      <div className={styles.specimenCode}>
        <span>{mod.id}</span>
        <code>{mod.status === 'planned' ? 'planned' : mod.abiEncode}</code>
      </div>
      <div className={styles.specimenBody}>
        <div className={styles.specimenTitle}>
          <h3>{(PLAIN[mod.id]?.name ?? mod.label).replace(/^✿\s*/, '')}</h3>
          <span>{mod.status === 'planned' ? 'planned' : `v${mod.version}`}</span>
          <span>{mod.category}</span>
        </div>
      </div>
    </article>
  );
}
