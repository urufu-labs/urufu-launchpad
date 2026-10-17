'use client';

/// "What you can add" page. Plain-language list of the options a creator can
/// pick for each launch type. Contract addresses, config hashes and module ids
/// live in one collapsed "for developers" section at the bottom so nothing is
/// lost for builders. NFT and DN404 sections follow their launch flags.
/// Copy rules are enforced by src/app/docs/copy.test.mjs.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useChainId } from 'wagmi';

import styles from '@/styles/guide.module.css';
import { GuideToc } from '@/components/GuideToc';
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
  Permit: { name: 'Gasless approvals', what: 'Holders can approve a trade with a signature instead of a separate transaction, which saves gas.' },
  Votes: { name: 'Voting power', what: 'Holders can hand their voting power to themselves or someone else. You need this if you want on-chain votes later.' },
  Staking: { name: 'Staking pool', what: 'Holders lock the coin to earn more of it. You put the rewards in up front and they pay out evenly over a set time.' },
  Vesting: { name: 'Vesting schedule', what: 'Part of the supply goes to one wallet and is released bit by bit between a start date and an end date.' },
  AntiBot: { name: 'Bot gate', what: 'Only wallets you approve can buy for the first few blocks.' },
  AntiWhale: { name: 'Whale caps', what: 'Limits how much one wallet can hold or move for a while after launch.' },
  Pausable: { name: 'Emergency pause', what: 'Lets the owner stop all transfers.' },
  FeeOnTransfer: { name: 'Tax on trade', what: 'Every transfer pays a small tax that is burned or sent to a wallet.' },
  Blocklist: { name: 'Blocklist', what: 'The owner could block specific wallets from sending or receiving the coin.' },
  Jailable: { name: 'Fund recovery', what: 'The owner could move coins out of a blocked wallet to a recovery wallet.' },
  B20PolicyAware: { name: 'Rules registry', what: 'Every transfer would be checked against a shared rules list before it goes through.' },
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
  { label: 'Plain coin', stance: 'The default coin contract', modules: [], implKey: 'ERC20TemplateImpl' },
  { label: 'Bot gate coin', stance: 'Adds the bot gate; not usable with curve launches', modules: ['AntiBot'], implKey: 'ERC20WithAntiBotImpl' },
  { label: 'Taxed coin', stance: 'Adds a transfer tax; not usable with curve launches', modules: ['FeeOnTransfer'], implKey: 'ERC20WithFoTImpl' },
];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AddrLink({ chain, addr }: { chain: ChainKey | null; addr: string | undefined }) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    return <span className={styles.faint}>not deployed</span>;
  }
  if (!chain) return <code className={styles.mono}>{short(addr)}</code>;
  return (
    <Link href={explorerAddressUrl(chain, addr)} target="_blank" className={styles.addr}>
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
    { id: 'coins', label: 'Coins', show: true },
    { id: 'nfts', label: 'NFT collections', show: nftsOn },
    { id: 'dn404', label: 'DN404', show: dn404On },
    { id: 'later', label: 'Coming later', show: true },
    { id: 'developers', label: 'For developers', show: true },
  ].filter((e) => e.show);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>launch options · {CHAIN_LABELS[chainKey]}</p>
          <h1 className={styles.title}>What you can add</h1>
          <p className={styles.lede}>Every launch comes with safe defaults. Here is what is included, what you can switch on, and what is not available on curve launches.</p>
        </div>
        <div className={styles.actions}>
          <Link href="/docs" className="ui-btn" data-size="lg">
            How it works
          </Link>
          <Link href="/create" className="ui-btn" data-variant="primary" data-size="lg">
            Create
          </Link>
        </div>
      </header>

      <div className={styles.layout} data-rail="none">
        <GuideToc label="Sections" items={index.map((e) => ({ id: e.id, label: e.label }))} />

        <section className={styles.content} aria-label="Launch options">
          <section id="coins" className={styles.section}>
            <SectionHead
              title="Coins"
              sub="Quick launch uses safe defaults. Advanced launch lets you add the extras below."
            />
            <PlainList
              title="Every coin comes with"
              items={[
                { name: 'Price curve', what: 'Trading starts right away. The price goes up as people buy and down as they sell.' },
                { name: 'Locked pool', what: 'When it graduates, the coin moves to a Uniswap pool and that money is locked forever.' },
                { name: 'Creator earnings', what: 'After graduation you earn 1% of every trade in the pool.' },
                { name: 'No admin keys', what: 'Nobody, including you, can change or pause the coin after launch.' },
              ]}
            />
            <PlainList
              title="Extras you can add"
              items={[
                { name: 'Early access for a community', what: 'Holders of another token or NFT collection get the first hour to buy, with 60% of the curve set aside for them.' },
                { name: 'Graduation pause', what: 'Pool trading waits a short while after graduation (up to 7,200 blocks, about 12 minutes) so bots cannot jump in first.' },
                { name: 'Buy and burn', what: 'Part of every pool buy (up to 20%) is burned, so supply slowly shrinks.' },
                ...extras.map((m) => PLAIN[m.id] ?? { name: m.label.replace(/^✿\s*/, ''), what: m.description }),
              ]}
            />
            {notOnCurve.length > 0 && (
              <PlainList
                muted
                title="Not available on curve launches"
                note="These need an owner who keeps control, or they tax every transfer. Curve coins have no owner and no transfer tax, so these are switched off."
                items={notOnCurve.map((m) => PLAIN[m.id] ?? { name: m.label.replace(/^✿\s*/, ''), what: m.description })}
              />
            )}
          </section>

          {nftsOn && (
            <section id="nfts" className={styles.section}>
              <SectionHead
                title="NFT collections"
                sub="Art that people mint. Start from urufu studio with launch as nft, or fill in the form."
              />
              <PlainList
                title="You choose"
                items={[
                  { name: 'Size', what: 'The total number of NFTs, and how many one wallet can mint.' },
                  { name: 'Price', what: 'The same price for every mint, or a price that goes up by a set amount after each mint.' },
                  { name: 'Payment', what: 'Buyers pay in ETH or URU.' },
                  { name: 'Early access', what: 'A list of wallets that can mint first, for a set window.' },
                  { name: 'Holder discounts', what: 'A lower price for people who hold another collection, like urufu gemu nft.' },
                  { name: 'OpenSea info', what: 'After launch, set the collection name, picture and description OpenSea shows.' },
                ]}
              />
              <PlainList
                title="How money moves"
                items={[
                  { name: 'Your cut', what: 'You keep 90% of every mint and withdraw it from your profile page.' },
                  { name: 'Platform cut', what: '10% of every mint goes to the platform flywheel.' },
                  { name: 'Launch fee', what: '5,000 URU, before holder discounts.' },
                ]}
              />
            </section>
          )}

          {dn404On && (
            <section id="dn404" className={styles.section}>
              <SectionHead
                title="DN404"
                sub="A coin and an nft collection in one. Hold enough coins and you own an nft."
              />
              <PlainList
                title="You choose"
                items={[
                  { name: 'Collection size', what: 'Up to 10,000 NFTs.' },
                  { name: 'Coins per NFT', what: 'How many coins equal one NFT. Holding a multiple gives you that many NFTs.' },
                  { name: 'Pair', what: 'Buyers pay with ETH or URU.' },
                  { name: 'Founder share', what: 'Keep up to 20% of the supply in your wallet at launch.' },
                  { name: 'Graduation pause', what: 'Pool trading waits up to 7,200 blocks (about 12 minutes) after graduation.' },
                  { name: 'Buy and burn', what: 'Part of every pool buy (up to 20%) is burned.' },
                  { name: 'Tax', what: '0% to 5%, fixed forever at launch. Taken on pool buys and wallet transfers, not on sells into the pool or curve trades.' },
                ]}
              />
              <PlainList
                title="What the tax can do"
                note="Our automated helper carries out your choice and keeps 5% of each payout for gas and upkeep."
                items={DN404_TAX_MODES.filter((m) => m.value !== 0).map((m) => ({
                  name: m.label.toLowerCase(),
                  what: `${m.description}.`,
                }))}
              />
              <PlainList
                title="Good to know"
                items={[
                  { name: 'Big trades', what: 'One buy or sell can create or remove at most 2,000 NFTs, a Robinhood Chain limit. Split bigger trades.' },
                  { name: 'Launch fee', what: '10,000 URU, before holder discounts.' },
                  { name: 'Trading apps', what: 'Some apps that route through their own contracts may fail to sell taxed coins. This site and the Uniswap app work.' },
                ]}
              />
            </section>
          )}

          <section id="later" className={styles.section}>
            <SectionHead title="Coming later" sub="Planned, not available yet." />
            <PlainList muted items={later.map((m) => PLAIN[m.id] ?? { name: m.label, what: m.description })} />
          </section>

          <section id="developers" className={styles.section}>
            <SectionHead title="For developers" sub="Contract addresses, module ids and config hashes." />
            <details className={styles.devDetails}>
              <summary>Show contract details</summary>
              <h3 className={styles.groupTitle}>coin launch contracts</h3>
              <div className={styles.table}>
                <StackRow name="NameRegistry" role="reserves names and tickers" chain={chainKey} addr={contracts?.NameRegistry} />
                <StackRow name="Router" role="launch entry point and fee handling" chain={chainKey} addr={contracts?.Router} />
                <StackRow name="FeeReceiver" role="platform fee receiver" chain={chainKey} addr={contracts?.FeeReceiver} />
                <StackRow name="ERC20Factory" role="deploys coin contracts" chain={chainKey} addr={contracts?.ERC20Factory} />
              </div>
              <h3 className={styles.groupTitle}>nft launch contracts</h3>
              <div className={styles.table}>
                <StackRow name="NftLaunchFactory" role="deploys collection and mint module" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.LaunchFactory} />
                <StackRow name="ERC721 impl" role="copied per collection" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.Erc721Impl} />
                <StackRow name="Mint module impl" role="pricing, discounts, mint accounting" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.MintModuleImpl} />
                <StackRow name="Whitelist module impl" role="optional early-access gate" chain={chainKey} addr={NFT_LAUNCHES[chainKey]?.WhitelistModuleImpl} />
              </div>
              <h3 className={styles.groupTitle}>dn404 launch contracts</h3>
              <div className={styles.table}>
                <StackRow name="Dn404LaunchFactory" role="deploys coin, mirror nft and curve" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.LaunchFactory} />
                <StackRow name="Dn404CurveFactory" role="curves for ERC-20 pairs (URU)" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.CurveFactory} />
                <StackRow name="DN404 MultiHookHost" role="pool hook for ERC-20-paired graduations" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.MultiHookHost} />
                <StackRow name="Base impl" role="dn404 coin template" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.BaseImpl} />
                <StackRow name="Mirror impl" role="dn404 nft template" chain={chainKey} addr={DN404_LAUNCHES[chainKey]?.MirrorImpl} />
              </div>
              <h3 className={styles.groupTitle}>coin modules</h3>
              <div className={styles.table}>
                <div className={styles.tableRow} data-head="true">
                  <span>module</span>
                  <span>name</span>
                  <span>status</span>
                </div>
                {coinModules.map((mod) => (
                  <ModSpecimen key={mod.id} mod={mod} />
                ))}
              </div>
              <h3 className={styles.groupTitle}>registered coin configurations</h3>
              <div className={styles.table} role="table" aria-label="Registered coin configurations">
                <div className={styles.tableRow} data-head="true" role="row">
                  <span>configuration</span>
                  <span>modules · hash</span>
                  <span>impl</span>
                </div>
                {RECIPES.map((recipe) => {
                  const hash = configHashFor('ERC20', recipe.modules);
                  const implAddress = contracts?.[recipe.implKey] as string | undefined;
                  return (
                    <div key={recipe.label} className={styles.tableRow} role="row">
                      <div>
                        <b>{recipe.label}</b>
                        <div className={styles.faint}>{recipe.stance}</div>
                      </div>
                      <span>
                        {recipe.modules.length ? recipe.modules.join(' + ') : 'none'} · <code className={styles.mono}>{hash.slice(0, 22)}…</code>
                      </span>
                      <AddrLink chain={chainKey} addr={implAddress} />
                    </div>
                  );
                })}
              </div>
            </details>
          </section>
        </section>
      </div>
    </main>
  );
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className={styles.sub}>{sub}</p>
    </>
  );
}

function PlainList({
  title,
  note,
  items,
  muted = false,
}: {
  title?: string;
  note?: string;
  items: Array<{ name: string; what: string }>;
  muted?: boolean;
}) {
  return (
    <div>
      {title && <h3 className={styles.groupTitle}>{title}</h3>}
      {note && <p className={styles.note}>{note}</p>}
      <div className={styles.rows} data-muted={muted ? 'true' : undefined}>
        {items.map((item) => (
          <div key={item.name} className={styles.row}>
            <h4 className={styles.rowName}>{item.name}</h4>
            <p className={styles.rowWhat}>{item.what}</p>
          </div>
        ))}
      </div>
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
    <div className={styles.tableRow}>
      <b>{name}</b>
      <span>{role}</span>
      <AddrLink chain={chain} addr={addr} />
    </div>
  );
}

function ModSpecimen({ mod }: { mod: ModuleSpec }) {
  return (
    <div className={styles.tableRow}>
      <b>{mod.id}</b>
      <span>{(PLAIN[mod.id]?.name ?? mod.label).replace(/^✿\s*/, '')} · {mod.category}</span>
      <span className={styles.faint}>{mod.status === 'planned' ? 'planned' : `v${mod.version}`}</span>
    </div>
  );
}
