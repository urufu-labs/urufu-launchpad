'use client';

import Link from 'next/link';

import type { BaseType } from '@/lib/modules';
import type { ChainKey, ContractSet } from '@/lib/config';
import { explorerAddressUrl } from '@/lib/wagmi';

interface Props {
  chainKey: ChainKey | null;
  contracts: ContractSet | null;
  base: BaseType;
  selectedModules: string[];
  configHash: `0x${string}`;
  factoryAddress: `0x${string}` | undefined;
  implAddress: `0x${string}` | null | undefined;
  predictedTokenAddress: `0x${string}` | null | undefined;
}

function link(chain: ChainKey | null, addr: string | undefined | null): React.ReactNode {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    return <span className="text-neutral-600">—</span>;
  }
  if (!chain) return <code className="font-mono text-neutral-400">{short(addr)}</code>;
  return (
    <Link
      href={explorerAddressUrl(chain, addr)}
      target="_blank"
      className="font-mono text-blue-400 hover:underline"
    >
      {short(addr)}
    </Link>
  );
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// Shows the "vending machine" architecture for the currently selected composition:
/// template + factory + impl + configHash + predicted token address.
export function CompositionInfo(props: Props) {
  const { chainKey, contracts, base, selectedModules, configHash, factoryAddress, implAddress, predictedTokenAddress } =
    props;

  const templateImpl: `0x${string}` | undefined = contracts
    ? base === 'ERC20'
      ? contracts.ERC20TemplateImpl
      : base === 'ERC721A'
        ? contracts.ERC721ATemplateImpl
        : contracts.ERC1155TemplateImpl
    : undefined;

  const implMissing = implAddress === '0x0000000000000000000000000000000000000000' || implAddress == null;

  return (
    <div className="rounded-lg border border-neutral-800 p-4 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <div className="uppercase tracking-widest text-neutral-500">Composition</div>
        {implMissing && contracts && (
          <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-amber-300">
            impl not registered
          </span>
        )}
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-neutral-500">Base</dt>
        <dd className="font-mono">{base}</dd>

        <dt className="text-neutral-500">Modules</dt>
        <dd className="font-mono">{selectedModules.length === 0 ? 'none' : selectedModules.join(' · ')}</dd>

        <dt className="text-neutral-500">Base template</dt>
        <dd>{link(chainKey, templateImpl)}</dd>

        <dt className="text-neutral-500">Factory</dt>
        <dd>{link(chainKey, factoryAddress)}</dd>

        <dt className="text-neutral-500">Config hash</dt>
        <dd>
          <code className="break-all font-mono text-neutral-400">{configHash}</code>
        </dd>

        <dt className="text-neutral-500">Impl for hash</dt>
        <dd>{link(chainKey, implAddress ?? undefined)}</dd>

        <dt className="text-neutral-500">Predicted deploy</dt>
        <dd>{link(chainKey, predictedTokenAddress ?? undefined)}</dd>
      </dl>

      {implMissing && contracts && (
        <div className="mt-3 rounded border border-amber-800 bg-amber-950/40 p-2 text-[11px] text-amber-200">
          This composition hasn't been registered on {chainKey}. The launch will revert with
          <code className="mx-1 font-mono">UnknownConfig</code>. Pick a curated combination — bare
          ERC-20, ERC-20 + AntiBot, ERC-20 + Fee-on-transfer, bare ERC-721A, ERC-721A + On-chain
          SVG, ERC-721A + Royalty, ERC-721A + both, or bare ERC-1155.
        </div>
      )}
    </div>
  );
}
