'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useChainId } from 'wagmi';

import { MODULES, configHashFor, type ModuleSpec } from '@/lib/modules';
import { CHAINS_ENABLED, CONTRACTS, CHAIN_LABELS, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, explorerAddressUrl } from '@/lib/wagmi';
import { Mascot } from '@/components/Mascot';

const CURATED: Array<{
  label: string;
  jp: string;
  base: 'ERC20' | 'ERC721A' | 'ERC1155';
  modules: string[];
  implKey:
    | 'ERC20TemplateImpl'
    | 'ERC20WithAntiBotImpl'
    | 'ERC20WithFoTImpl'
    | 'ERC721ATemplateImpl'
    | 'ERC721AWithSvgImpl'
    | 'ERC721AWithRoyaltyImpl'
    | 'ERC721AWithSvgAndRoyaltyImpl'
    | 'ERC1155TemplateImpl';
}> = [
  { label: 'bare erc-20', jp: '素', base: 'ERC20', modules: [], implKey: 'ERC20TemplateImpl' },
  { label: 'erc-20 + antibot', jp: '守', base: 'ERC20', modules: ['AntiBot'], implKey: 'ERC20WithAntiBotImpl' },
  { label: 'erc-20 + fee', jp: '税', base: 'ERC20', modules: ['FeeOnTransfer'], implKey: 'ERC20WithFoTImpl' },
  { label: 'bare erc-721a', jp: '絵', base: 'ERC721A', modules: [], implKey: 'ERC721ATemplateImpl' },
  { label: '721a + svg', jp: '筆', base: 'ERC721A', modules: ['OnChainSVG'], implKey: 'ERC721AWithSvgImpl' },
  { label: '721a + royalty', jp: '金', base: 'ERC721A', modules: ['ERC2981Royalty'], implKey: 'ERC721AWithRoyaltyImpl' },
  { label: '721a + svg + royalty', jp: '金絵', base: 'ERC721A', modules: ['ERC2981Royalty', 'OnChainSVG'], implKey: 'ERC721AWithSvgAndRoyaltyImpl' },
  { label: 'bare erc-1155', jp: '多', base: 'ERC1155', modules: [], implKey: 'ERC1155TemplateImpl' },
];

const SECTIONS: Array<{ id: string; label: string; jp: string }> = [
  { id: 'core', label: 'core', jp: '骨組' },
  { id: 'bases', label: 'bases', jp: '型' },
  { id: 'modules', label: 'modules', jp: '出来' },
  { id: 'planned', label: 'planned', jp: '予定' },
  { id: 'curated', label: 'curated', jp: '定食' },
];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AddrLink({ chain, addr }: { chain: ChainKey | null; addr: string | undefined }) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    return <span style={{ color: 'var(--anchor-soft)' }}>—</span>;
  }
  if (!chain)
    return (
      <code style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor)' }}>
        {short(addr)}
      </code>
    );
  return (
    <Link
      href={explorerAddressUrl(chain, addr)}
      target="_blank"
      style={{
        color: 'var(--link-blue)',
        textDecoration: 'underline',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 10,
      }}
    >
      {short(addr)}
    </Link>
  );
}

export default function CatalogPage() {
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const activeChain = mounted ? (CHAIN_ID_TO_KEY[chainId] ?? null) : null;
  const targetChain: ChainKey = CHAINS_ENABLED[0]!;
  const chainKey = activeChain && CHAINS_ENABLED.includes(activeChain) ? activeChain : targetChain;
  const contracts = CONTRACTS[chainKey];

  const shipped = MODULES.filter((m) => m.status === 'shipped');
  const planned = MODULES.filter((m) => m.status === 'planned');

  return (
    <div className="mx-auto max-w-6xl px-3 sm:px-4 py-4">
      {/* ================================================================
          COMPACT HERO — mascot + title + chain + shipped-count on one row
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
          <div className="uru-eyebrow" style={{ marginBottom: 2 }}>❀ shelf · {CHAIN_LABELS[chainKey]}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1 }}>the shelf</h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              品揃え
            </span>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
              · {shipped.length} shipped · {planned.length} planned · {CURATED.length} combos
            </span>
          </div>
        </div>
        <Link href="/create" className="uru-btn uru-btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}>
          launch a token <span className="uru-arrow">→</span>
        </Link>
      </section>

      {/* ================================================================
          SECTION JUMP BAR — chips scroll the page down
          ================================================================ */}
      <nav
        style={{
          display: 'flex',
          gap: 5,
          flexWrap: 'wrap',
          marginBottom: 12,
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

      {contracts === null && (
        <div
          style={{
            padding: '6px 12px',
            marginBottom: 10,
            background: 'var(--yolk)',
            borderLeft: '4px solid var(--anchor)',
            border: '1.5px solid var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10.5,
            color: 'var(--anchor)',
          }}
        >
          <b>◐ not deployed on {CHAIN_LABELS[chainKey]}</b> ~ addresses fill in after DeployPhase1
          broadcasts. shapes are correct tho.
        </div>
      )}

      {/* ================================================================
          CORE STACK — tight rows
          ================================================================ */}
      <SectionHead id="core" title="core stack" jp="骨組み" sub="the plumbing every launch runs through" />
      <div className="uru-shell-tight" style={{ padding: 0, marginBottom: 18 }}>
        <StackRow name="NameRegistry" role="reserves names + tickers" chain={chainKey} addr={contracts?.NameRegistry} />
        <StackRow name="Router" role="entry point · fee · dispatch" chain={chainKey} addr={contracts?.Router} />
        <StackRow name="FeeReceiver" role="fee sink → treasury" chain={chainKey} addr={contracts?.FeeReceiver} last />
      </div>

      {/* ================================================================
          BASES + FACTORIES — 3-col tile grid (no more tilted polaroids)
          ================================================================ */}
      <SectionHead id="bases" title="bases & factories" jp="型" sub="one factory per base, cloned via lib-clone" />
      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <BaseTile
          accent="var(--pink-warm)"
          kanji="通貨"
          label="erc-20"
          factory={contracts?.ERC20Factory}
          impl={contracts?.ERC20TemplateImpl}
          chain={chainKey}
        />
        <BaseTile
          accent="var(--mint)"
          kanji="絵"
          label="erc-721a"
          factory={contracts?.ERC721AFactory}
          impl={contracts?.ERC721ATemplateImpl}
          chain={chainKey}
        />
        <BaseTile
          accent="var(--mizuiro)"
          kanji="多品"
          label="erc-1155"
          factory={contracts?.ERC1155Factory}
          impl={contracts?.ERC1155TemplateImpl}
          chain={chainKey}
        />
      </div>

      {/* ================================================================
          MODULES — SHIPPED (denser 3-col grid)
          ================================================================ */}
      <SectionHead id="modules" title="modules · shipped" jp="出来" sub={`${shipped.length} audited fragments u can drag into ur cart today`} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-4">
        {shipped.map((mod) => (
          <ModTile key={mod.id} mod={mod} />
        ))}
      </div>

      {/* ================================================================
          MODULES — PLANNED (compact strip)
          ================================================================ */}
      <SectionHead id="planned" title="modules · planned" jp="予定" sub="on the roadmap — spec'd, not spliced yet" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-4">
        {planned.map((mod) => (
          <ModTile key={mod.id} mod={mod} planned />
        ))}
      </div>

      {/* ================================================================
          CURATED — table of pre-registered combos
          ================================================================ */}
      <SectionHead id="curated" title="curated impl menu" jp="定食" sub="pre-registered combos — launch any of these day-one" />
      <div
        className="uru-shell-tight"
        style={{ padding: 0, marginBottom: 18, overflow: 'hidden' }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2.4rem minmax(0, 1fr) auto auto',
            gap: 10,
            padding: '6px 10px',
            background: 'var(--cream-deep)',
            borderBottom: '1.5px solid var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            letterSpacing: '0.08em',
            color: 'var(--anchor-soft)',
            textTransform: 'uppercase',
          }}
        >
          <span></span>
          <span>combo · config hash</span>
          <span style={{ textAlign: 'right' }}>base</span>
          <span style={{ textAlign: 'right' }}>impl</span>
        </div>
        {CURATED.map((c, i) => {
          const hash = configHashFor(c.base, c.modules);
          const implAddress = contracts?.[c.implKey] as string | undefined;
          return (
            <div
              key={c.label}
              style={{
                display: 'grid',
                gridTemplateColumns: '2.4rem minmax(0, 1fr) auto auto',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderBottom: i === CURATED.length - 1 ? 'none' : '1px dotted var(--anchor)',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-jp), monospace',
                  fontSize: 20,
                  textAlign: 'center',
                  color: 'var(--anchor)',
                  lineHeight: 1,
                }}
              >
                {c.jp}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="uru-h2" style={{ fontSize: 12, lineHeight: 1.1 }}>
                  {c.label}
                </div>
                <code
                  style={{
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 9,
                    color: 'var(--anchor-soft)',
                    wordBreak: 'break-all',
                  }}
                >
                  {hash.slice(0, 22)}…
                </code>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--anchor)',
                  textAlign: 'right',
                }}
              >
                {c.base.toLowerCase()}
              </div>
              <div style={{ textAlign: 'right' }}>
                <AddrLink chain={chainKey} addr={implAddress} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ================================================================
          CTA — bottom of shelf
          ================================================================ */}
      <section
        style={{
          padding: '18px 12px',
          textAlign: 'center',
          border: '1.5px dashed var(--anchor)',
          background: 'var(--cream)',
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
          done browsing? go pick some stuff ~~
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
    <div id={id} style={{ scrollMarginTop: 60, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="uru-h1" style={{ fontSize: 18, lineHeight: 1 }}>{title}</span>
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
      <p
        style={{
          marginTop: 2,
          fontSize: 11,
          color: 'var(--anchor-soft)',
        }}
      >
        {sub}
      </p>
    </div>
  );
}

function StackRow({
  name,
  role,
  chain,
  addr,
  last,
}: {
  name: string;
  role: string;
  chain: ChainKey | null;
  addr: string | undefined;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '10rem minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        borderBottom: last ? 'none' : '1px dotted var(--anchor)',
      }}
    >
      <div className="uru-h2" style={{ fontSize: 13 }}>
        {name}
      </div>
      <div style={{ fontSize: 12, color: 'var(--anchor-soft)' }}>{role}</div>
      <AddrLink chain={chain} addr={addr} />
    </div>
  );
}

function BaseTile({
  accent,
  kanji,
  label,
  factory,
  impl,
  chain,
}: {
  accent: string;
  kanji: string;
  label: string;
  factory: string | undefined;
  impl: string | undefined;
  chain: ChainKey | null;
}) {
  return (
    <div
      className="uru-shell-tight"
      style={{
        padding: 12,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 8,
          background: accent,
          border: '1.5px solid var(--anchor)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-jp), monospace',
          fontSize: 24,
          color: 'var(--anchor)',
          flexShrink: 0,
        }}
      >
        {kanji}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="uru-h2" style={{ fontSize: 13 }}>{label}</div>
        <div
          style={{
            marginTop: 2,
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            color: 'var(--anchor-soft)',
            lineHeight: 1.4,
          }}
        >
          <div>factory: <AddrLink chain={chain} addr={factory} /></div>
          <div>impl: <AddrLink chain={chain} addr={impl} /></div>
        </div>
      </div>
    </div>
  );
}

function ModTile({ mod, planned }: { mod: ModuleSpec; planned?: boolean }) {
  const stampClass =
    mod.category === 'token'
      ? 'uru-stamp-mint'
      : mod.category === 'nft'
        ? 'uru-stamp-mizuiro'
        : mod.category === 'allocation'
          ? 'uru-stamp-cream'
          : '';

  return (
    <div
      className="uru-shell-tight"
      style={{
        padding: 10,
        opacity: planned ? 0.75 : 1,
        background: planned ? 'var(--cream-deep)' : 'var(--cream)',
      }}
    >
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5, alignItems: 'center' }}>
        <span
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            background: planned ? 'transparent' : 'var(--pink-warm)',
            border: '1px solid var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {planned ? 'planned' : `v${mod.version}`}
        </span>
        <span className={`uru-stamp ${stampClass}`} style={{ transform: 'none', fontSize: 9, padding: '2px 6px', boxShadow: 'none' }}>
          {mod.category}
        </span>
      </div>
      <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.1 }}>
        {planned ? '❀' : '✿'} {mod.label}
      </div>
      <p
        style={{
          fontSize: 11,
          lineHeight: 1.4,
          color: 'var(--anchor-soft)',
          margin: '4px 0 0 0',
        }}
      >
        {mod.description}
      </p>
      <div
        style={{
          marginTop: 6,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 9,
          color: 'var(--anchor-soft)',
        }}
      >
        {mod.bases.join(' · ')}
        {!planned && (
          <>
            {' · '}
            <span style={{ opacity: 0.7 }}>{mod.abiEncode}</span>
          </>
        )}
      </div>
    </div>
  );
}
