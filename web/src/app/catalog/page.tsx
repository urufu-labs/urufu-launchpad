'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useChainId } from 'wagmi';

import styles from './catalog.module.css';
import { MODULES, configHashFor, type ModuleSpec } from '@/lib/modules';
import { CHAINS_ENABLED, CONTRACTS, CHAIN_LABELS, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, explorerAddressUrl } from '@/lib/wagmi';

const RECIPES: Array<{
  label: string;
  jp: string;
  stance: string;
  modules: string[];
  implKey: 'ERC20TemplateImpl' | 'ERC20WithAntiBotImpl' | 'ERC20WithFoTImpl';
}> = [
  {
    label: 'plain creator coin',
    jp: '素',
    stance: 'clean ERC-20 implementation for the simplest release path',
    modules: [],
    implKey: 'ERC20TemplateImpl',
  },
  {
    label: 'guarded opening',
    jp: '守',
    stance: 'adds the shipped bot gate module for the first launch blocks',
    modules: ['AntiBot'],
    implKey: 'ERC20WithAntiBotImpl',
  },
  {
    label: 'taxed transfer coin',
    jp: '税',
    stance: 'registered implementation for creator-directed transfer fees',
    modules: ['FeeOnTransfer'],
    implKey: 'ERC20WithFoTImpl',
  },
];

const INDEX = [
  { id: 'inventory', label: 'inventory', jp: '棚卸' },
  { id: 'core', label: 'core stack', jp: '骨組' },
  { id: 'hooks', label: 'v4 hooks', jp: '針' },
  { id: 'guards', label: 'guards', jp: '守' },
  { id: 'modules', label: 'modules', jp: '出来' },
  { id: 'planned', label: 'planned', jp: '予定' },
  { id: 'recipes', label: 'configurations', jp: '定食' },
];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AddrLink({ chain, addr }: { chain: ChainKey | null; addr: string | undefined }) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    return <span className={styles.muted}>pending</span>;
  }
  if (!chain) return <code className={styles.address}>{short(addr)}</code>;
  return (
    <Link href={explorerAddressUrl(chain, addr)} target="_blank" className={styles.addressLink}>
      {short(addr)}
    </Link>
  );
}

function publicModule(mod: ModuleSpec) {
  return mod.bases.includes('ERC20');
}

function isGuardModule(mod: ModuleSpec) {
  return (
    mod.id === 'AntiBot' ||
    mod.id === 'AntiWhale' ||
    mod.id === 'Pausable' ||
    mod.requiresOwner === true ||
    mod.flagged !== null
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

  const publicModules = useMemo(() => MODULES.filter(publicModule), []);
  const shipped = publicModules.filter((m) => m.status === 'shipped');
  const planned = publicModules.filter((m) => m.status === 'planned');
  const hooks = shipped.filter((m) => m.category === 'hook');
  const guards = shipped.filter(isGuardModule);
  const otherModules = shipped.filter((m) => m.category !== 'hook' && !isGuardModule(m));

  return (
    <main className={styles.page}>
      <header className={styles.specHeader}>
        <div>
          <p>module reference · {CHAIN_LABELS[chainKey]}</p>
          <h1>Module catalog</h1>
        </div>
        <div className={styles.headerMeta} aria-label="Catalog counts">
          <Meta label="shipped" value={String(shipped.length)} />
          <Meta label="planned" value={String(planned.length)} />
          <Meta label="hooks" value={String(hooks.length)} />
          <Meta label="configs" value={String(RECIPES.length)} />
        </div>
      </header>

      {contracts === null && (
        <div className={styles.notice}>
          <b>◐ not deployed on {CHAIN_LABELS[chainKey]}</b>
          <span>addresses fill in after DeployPhase1 broadcasts; registry status is still shown.</span>
        </div>
      )}

      <div className={styles.referenceLayout}>
        <aside className={styles.indexRail} aria-label="Catalog index">
          <div className={styles.indexTitle}>
            <span>index</span>
            <small>目次</small>
          </div>
          <nav>
            {INDEX.map((entry) => (
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
            <Link href="/discover" className="uru-btn uru-btn-cream">
              discover
            </Link>
          </div>
        </aside>

        <section className={styles.sheet} aria-label="ERC-20 module reference">
          <SectionHead
            id="inventory"
            title="Available modules"
            jp="棚卸"
            sub="Public module catalog for ERC-20 launches. Planned work is marked separately from shipped code."
          />
          <div className={styles.inventory}>
            <InventoryRow label="Shipped ERC-20 modules" value={String(shipped.length)} note="available in the local registry" />
            <InventoryRow label="V4 hook modules" value={String(hooks.length)} note="pool behavior after graduation" />
            <InventoryRow label="Guarded launch modules" value={String(guards.length)} note="owner/risk-sensitive controls" />
            <InventoryRow label="Planned policy modules" value={String(planned.length)} note="roadmap only, not selectable as shipped" />
          </div>

          <SectionHead
            id="core"
            title="Core Stack"
            jp="骨組"
            sub="Contracts a public ERC-20 launch routes through."
          />
          <div className={styles.coreTable}>
            <StackRow name="NameRegistry" role="reserves names and tickers" chain={chainKey} addr={contracts?.NameRegistry} />
            <StackRow name="Router" role="entry point, fee handling, launch dispatch" chain={chainKey} addr={contracts?.Router} />
            <StackRow name="FeeReceiver" role="platform fee receiver" chain={chainKey} addr={contracts?.FeeReceiver} />
            <StackRow name="ERC20Factory" role="registered ERC-20 implementation factory" chain={chainKey} addr={contracts?.ERC20Factory} />
          </div>

          <ModuleSection
            id="hooks"
            title="V4 hook modules"
            jp="針"
            sub="Shipped pool behavior modules for ERC-20 releases."
            modules={hooks}
          />
          <ModuleSection
            id="guards"
            title="Launch Guards"
            jp="守"
            sub="Controls that change trust assumptions or launch access."
            modules={guards}
          />
          <ModuleSection
            id="modules"
            title="Contract Modules"
            jp="出来"
            sub="Other shipped ERC-20 fragments in the registry."
            modules={otherModules}
          />
          <ModuleSection
            id="planned"
            title="Planned Policy Work"
            jp="予定"
            sub="Roadmap modules only. These are not presented as shipped launch pieces."
            modules={planned}
            planned
          />

          <SectionHead
            id="recipes"
            title="Registered configurations"
            jp="定食"
            sub="ERC-20 implementation addresses and config hashes."
          />
          <div className={styles.recipeTable} role="table" aria-label="Registered ERC-20 configurations">
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
                    <small>{recipe.jp}</small>
                    <p>{recipe.stance}</p>
                  </div>
                  <span>{recipe.modules.length ? recipe.modules.join(' + ') : 'none'}</span>
                  <code>{hash.slice(0, 22)}…</code>
                  <AddrLink chain={chainKey} addr={implAddress} />
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.meta}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function SectionHead({
  id,
  title,
  jp,
  sub,
}: {
  id: string;
  title: string;
  jp: string;
  sub: string;
}) {
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

function InventoryRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className={styles.inventoryRow}>
      <span>{label}</span>
      <b>{value}</b>
      <p>{note}</p>
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

function ModuleSection({
  id,
  title,
  jp,
  sub,
  modules,
  planned,
}: {
  id: string;
  title: string;
  jp: string;
  sub: string;
  modules: ModuleSpec[];
  planned?: boolean;
}) {
  return (
    <>
      <SectionHead id={id} title={title} jp={jp} sub={sub} />
      <div className={styles.specimenList}>
        {modules.map((mod) => (
          <ModSpecimen key={mod.id} mod={mod} planned={planned} />
        ))}
      </div>
    </>
  );
}

function ModSpecimen({ mod, planned }: { mod: ModuleSpec; planned?: boolean }) {
  const warnings = [
    mod.requiresOwner ? 'owner-controlled after launch' : null,
    mod.taxesTransfers ? 'transfer-tax behavior; compatibility depends on launch mechanic' : null,
    mod.flagged,
  ].filter((note): note is string => Boolean(note));

  return (
    <article className={styles.specimen} data-planned={planned ? 'true' : undefined}>
      <div className={styles.specimenCode}>
        <span>{mod.id}</span>
        <code>{planned ? 'planned' : mod.abiEncode}</code>
      </div>
      <div className={styles.specimenBody}>
        <div className={styles.specimenTitle}>
          <h3>{mod.label}</h3>
          <span>{planned ? 'planned' : `v${mod.version} shipped`}</span>
          <span>{mod.category}</span>
        </div>
        <p>{mod.description}</p>
        {warnings.length > 0 && (
          <ul className={styles.warnings}>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
