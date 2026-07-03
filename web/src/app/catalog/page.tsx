'use client';

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

const TILTS = ['n7', 'p3', 'n4', 'p11', 'p2', 'n11', 'p13', 'n2'] as const;

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
  const activeChain = CHAIN_ID_TO_KEY[chainId] ?? null;
  const targetChain: ChainKey = CHAINS_ENABLED[0]!;
  const chainKey = activeChain && CHAINS_ENABLED.includes(activeChain) ? activeChain : targetChain;
  const contracts = CONTRACTS[chainKey];

  const shipped = MODULES.filter((m) => m.status === 'shipped');
  const planned = MODULES.filter((m) => m.status === 'planned');

  return (
    <>
      {/* marquee ribbon */}
      <div className="uru-marquee-wrap">
        <div className="uru-marquee">
          <div className="uru-marquee-track">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i}>
                ✿ the shelf ✿ 20 modules shipped ❀ 3 planned (B20 compliance) ★ 33 curated impls ~~{' '}
                <span style={{ fontFamily: 'var(--font-jp), monospace' }}>品揃え</span> ❁
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* HERO CLUSTER */}
        <header className="relative pb-10">
          <span
            className="uru-stamp uru-stamp-pink"
            style={{ position: 'absolute', top: 26, left: 90, transform: 'rotate(-1.5deg)' }}
          >
            ✿ menu
          </span>
          <span
            className="uru-stamp uru-stamp-mizuiro"
            style={{ position: 'absolute', top: 12, right: 40, transform: 'rotate(2deg)' }}
          >
            好き
          </span>
          <span
            className="uru-tape"
            style={{ width: 96, height: 18, top: 6, right: 160, transform: 'rotate(2deg)' }}
          />

          <div className="flex flex-col items-center text-center">
            <Mascot size={92} mood="happy" className="uru-idle-bob" />
            <h1 className="uru-h1 mt-3" style={{ fontSize: 'clamp(36px, 6vw, 52px)', lineHeight: 1.05 }}>
              the <span style={{ color: 'var(--pink-hot)' }}>shelf</span>
            </h1>
            <p
              className="mt-3"
              style={{
                fontFamily: 'var(--font-round), Klee One, cursive',
                fontSize: 15,
                color: 'var(--anchor-soft)',
                maxWidth: 460,
                lineHeight: 1.4,
              }}
            >
              every fragment, every factory, every impl — the whole vending machine, laid out (◕‿◕✿)
            </p>
          </div>
        </header>

        {contracts === null && (
          <div className="uru-shell mb-8" style={{ padding: 14, background: 'var(--yolk)' }}>
            <div className="flex items-start gap-3">
              <Mascot size={40} mood="confused" />
              <div>
                <div className="uru-h2" style={{ fontSize: 14 }}>not deployed on {CHAIN_LABELS[chainKey]} yet ~~</div>
                <div style={{ fontSize: 11, color: 'var(--anchor-soft)', marginTop: 2 }}>
                  addresses fill in after DeployPhase1 broadcasts. shapes are correct tho.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* CORE STACK */}
        <Section title="core stack" jp="骨組み" sub="the plumbing every launch runs through">
          <div className="uru-shell-inner">
            <StackRow name="NameRegistry" role="reserves names + tickers" chain={chainKey} addr={contracts?.NameRegistry} />
            <StackRow name="Router" role="entry point · fee · dispatch" chain={chainKey} addr={contracts?.Router} />
            <StackRow name="FeeReceiver" role="fee sink → treasury" chain={chainKey} addr={contracts?.FeeReceiver} />
          </div>
        </Section>

        {/* BASES + FACTORIES */}
        <Section title="bases & factories" jp="型" sub="one factory per base, cloned via lib-clone">
          <div className="grid gap-4 sm:grid-cols-3">
            <BaseCard
              tilt="rotate(-1.5deg)"
              accent="var(--pink-warm)"
              kanji="通貨"
              label="erc-20"
              factory={contracts?.ERC20Factory}
              impl={contracts?.ERC20TemplateImpl}
              chain={chainKey}
            />
            <BaseCard
              tilt="rotate(1deg)"
              accent="var(--mint-deep)"
              kanji="絵"
              label="erc-721a"
              factory={contracts?.ERC721AFactory}
              impl={contracts?.ERC721ATemplateImpl}
              chain={chainKey}
            />
            <BaseCard
              tilt="rotate(-1deg)"
              accent="var(--mizuiro-deep)"
              kanji="多品"
              label="erc-1155"
              factory={contracts?.ERC1155Factory}
              impl={contracts?.ERC1155TemplateImpl}
              chain={chainKey}
            />
          </div>
        </Section>

        {/* MODULES SHIPPED */}
        <Section title="modules · shipped" jp="出来" sub="audited fragments u can drag into ur cart today">
          <div className="grid gap-4 sm:grid-cols-2">
            {shipped.map((mod, i) => (
              <ModCard key={mod.id} mod={mod} tilt={TILTS[i % TILTS.length]!} />
            ))}
          </div>
        </Section>

        {/* MODULES PLANNED */}
        <Section title="modules · planned" jp="予定" sub="on the roadmap — spec'd, not spliced yet">
          <div className="grid gap-3 sm:grid-cols-2">
            {planned.map((mod, i) => (
              <ModRow key={mod.id} mod={mod} tilt={TILTS[(i + 3) % TILTS.length]!} />
            ))}
          </div>
        </Section>

        {/* CURATED MENU */}
        <Section title="curated impl menu" jp="定食" sub="pre-registered combos — launch any of these day-one">
          <div className="uru-shell-inner">
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
              {CURATED.map((c) => {
                const hash = configHashFor(c.base, c.modules);
                const implAddress = contracts?.[c.implKey] as string | undefined;
                return (
                  <li
                    key={c.label}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '3.4rem minmax(0,1fr) auto',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 8px',
                      borderBottom: '1px dotted var(--anchor)',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--font-jp), monospace',
                        fontSize: 22,
                        textAlign: 'center',
                        color: 'var(--anchor)',
                      }}
                    >
                      {c.jp}
                    </div>
                    <div>
                      <div className="uru-h2" style={{ fontSize: 13 }}>
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
                    <div style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          fontFamily: 'var(--font-pixel), monospace',
                          fontSize: 9,
                          color: 'var(--anchor-soft)',
                        }}
                      >
                        impl
                      </div>
                      <AddrLink chain={chainKey} addr={implAddress} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </Section>

        {/* CTA */}
        <section
          style={{
            padding: '40px 0 20px',
            textAlign: 'center',
            fontFamily: 'var(--font-round), Klee One, cursive',
          }}
        >
          <p style={{ fontSize: 14, color: 'var(--anchor-soft)', marginBottom: 14 }}>
            ok?? go pick some stuff ~~
          </p>
          <Link href="/create" className="uru-btn uru-btn-primary">
            launch a token <span className="uru-arrow">→</span>
          </Link>
        </section>
      </div>
    </>
  );
}

// ============================================================================
// Sections + subcomponents
// ============================================================================

function Section({
  title,
  jp,
  sub,
  children,
}: {
  title: string;
  jp: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-8">
      <div className="flex items-baseline gap-3 mb-4">
        <span
          className="uru-h1"
          style={{ fontSize: 30, lineHeight: 1 }}
        >
          {title}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 20,
            color: 'var(--anchor-soft)',
          }}
        >
          {jp}
        </span>
      </div>
      <p
        style={{
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 13,
          color: 'var(--anchor-soft)',
          margin: '0 0 16px 0',
          maxWidth: 520,
        }}
      >
        {sub}
      </p>
      <div className="uru-shell" style={{ padding: 16 }}>
        {children}
      </div>
    </section>
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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '10rem 1fr auto',
        alignItems: 'center',
        gap: 12,
        padding: '10px 6px',
        borderBottom: '1px dotted var(--anchor)',
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

function BaseCard({
  tilt,
  accent,
  kanji,
  label,
  factory,
  impl,
  chain,
}: {
  tilt: string;
  accent: string;
  kanji: string;
  label: string;
  factory: string | undefined;
  impl: string | undefined;
  chain: ChainKey | null;
}) {
  return (
    <div
      className="uru-polaroid"
      style={{
        transform: tilt,
        padding: '14px 12px 20px 12px',
        boxShadow: `3px 3px 0 ${accent}`,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-jp), monospace',
          fontSize: 40,
          color: 'var(--anchor)',
          lineHeight: 1,
        }}
      >
        {kanji}
      </div>
      <div className="uru-h2" style={{ fontSize: 14, marginTop: 6 }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 9,
          color: 'var(--anchor-soft)',
          lineHeight: 1.5,
        }}
      >
        <div>
          factory: <AddrLink chain={chain} addr={factory} />
        </div>
        <div>
          impl: <AddrLink chain={chain} addr={impl} />
        </div>
      </div>
    </div>
  );
}

function ModCard({ mod, tilt }: { mod: ModuleSpec; tilt: string }) {
  const stampClass =
    mod.category === 'token'
      ? 'uru-stamp-mint'
      : mod.category === 'nft'
        ? 'uru-stamp-mizuiro'
        : mod.category === 'allocation'
          ? 'uru-stamp-cream'
          : '';

  return (
    <div className="uru-polaroid" data-tilt={tilt} style={{ padding: '10px 10px 20px 10px' }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className={`uru-stamp ${stampClass}`} style={{ transform: 'rotate(-3deg)' }}>
          {mod.category}
        </span>
        <span className="uru-stamp uru-stamp-pink" style={{ transform: 'rotate(1deg)' }}>
          v{mod.version}
        </span>
      </div>
      <div className="uru-h2" style={{ fontSize: 14 }}>
        ✿ {mod.label}
      </div>
      <p
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--anchor-soft)',
          margin: '6px 0 0 0',
        }}
      >
        {mod.description}
      </p>
      <div
        style={{
          marginTop: 8,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 9,
          color: 'var(--anchor-soft)',
        }}
      >
        {mod.bases.join(' ✿ ')} · <span style={{ opacity: 0.7 }}>{mod.abiEncode}</span>
      </div>
    </div>
  );
}

function ModRow({ mod, tilt }: { mod: ModuleSpec; tilt: string }) {
  return (
    <div
      className="uru-polaroid"
      data-tilt={tilt}
      data-planned="true"
      style={{ padding: '8px 10px 14px 10px' }}
    >
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
        <span className="uru-stamp" style={{ transform: 'rotate(-3deg)', background: '#eee' }}>
          planned
        </span>
        <span className="uru-stamp uru-stamp-cream" style={{ transform: 'rotate(1deg)' }}>
          {mod.category}
        </span>
      </div>
      <div className="uru-h2" style={{ fontSize: 13 }}>
        ❀ {mod.label}
      </div>
      <p
        style={{
          fontSize: 11,
          lineHeight: 1.45,
          color: 'var(--anchor-soft)',
          margin: '4px 0 0 0',
        }}
      >
        {mod.description}
      </p>
    </div>
  );
}
