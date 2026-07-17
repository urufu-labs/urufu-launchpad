'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useSimulateContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  encodeAbiParameters,
  formatEther,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import Link from 'next/link';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';

import { playSfx } from '@/lib/audio/sfx';
import { curveFactoryAbi, erc20FactoryAbi, nameRegistryAbi, routerAbi } from '@/lib/abis';
import { CHAIN_LABELS, CONTRACTS } from '@/lib/config';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID, explorerAddressUrl, explorerTxUrl } from '@/lib/wagmi';
import {
  BASE_TYPE_TO_UINT,
  configHashFor,
  shippedModulesForBase,
  moduleById,
  type BaseType,
  type ModuleSpec,
} from '@/lib/modules';
import { encodeModuleSlice } from '@/components/ModulePicker';
import { persistMetadata, readFileAsDataUrl, safeBackgroundImage, type TokenMetadata } from '@/lib/metadata';
import { saveTokenMetadata } from '@/lib/socialApi';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';

type OwnershipMode = 'Renounce' | 'TransferToMultisig' | 'KeepEOA';
const OWNERSHIP_TO_UINT: Record<OwnershipMode, 0 | 1 | 2> = {
  Renounce: 0,
  TransferToMultisig: 1,
  KeepEOA: 2,
};

const BASE_LABELS: Record<BaseType, { label: string; jp: string; desc: string }> = {
  ERC20: { label: 'erc-20', jp: '通貨', desc: 'ur basic token ✿' },
  ERC721A: { label: 'erc-721a', jp: '絵', desc: 'nft collection ❀' },
  ERC1155: { label: 'erc-1155', jp: '多品', desc: 'multi items ❁' },
};

// Phase-1 launch: only ERC-20 is enabled. NFT + multi-item bases are wired
// end-to-end in contracts + tests, but held back at the UI level so we can
// prove the flywheel on fungibles first. Set to true here to unlock the cards.
const NFT_BASES_ENABLED = false;
const DISABLED_BASES: readonly BaseType[] = NFT_BASES_ENABLED ? [] : ['ERC721A', 'ERC1155'];

// Prime rotations — never multiples of 5 per SKILL.md §rotation
const TILTS: Array<'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2'> = [
  'n7', 'p3', 'n4', 'p11', 'p2', 'n11', 'p13', 'n2',
];

export default function CreatePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  // Wagmi + useActiveChain flip after client-side hydration (isConnected false → true,
  // chainId 1 → wallet's real chain). Any banner that keys off those values will
  // hydration-mismatch unless we gate its first render behind `mounted`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // The user's PICKED chain (from the header switcher) is the launch target — not the
  // wallet's current chain. When the wallet is on a different chain than the pick, we
  // surface a "switch to X" nudge before the launch button works.
  const targetChain = useActiveChain();
  const walletChain = CHAIN_ID_TO_KEY[chainId] ?? null;
  const isOnEnabledChain = walletChain === targetChain;
  const contracts = CONTRACTS[targetChain];
  const activeChain = targetChain; // legacy alias — every downstream ref stays valid

  const [base, setBase] = useState<BaseType>('ERC20');
  const [mechanic, setMechanic] = useState<'direct' | 'bonding-curve'>('direct');
  const mechanicOnMount = useRef<'direct' | 'bonding-curve'>('direct');
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [supplyInput, setSupplyInput] = useState('1000000');
  const [baseURI, setBaseURI] = useState('');
  const [maxSupplyInput, setMaxSupplyInput] = useState('10000');
  const [uri1155, setUri1155] = useState('');
  const [ownership, setOwnership] = useState<OwnershipMode>('Renounce');
  const [multisigTarget, setMultisigTarget] = useState('');
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [moduleParams, setModuleParams] = useState<Record<string, Record<string, unknown>>>({});
  const [metadata, setMetadata] = useState<TokenMetadata>({ savedAt: 0 });
  const [logoError, setLogoError] = useState<string | null>(null);
  const [dragMod, setDragMod] = useState<ModuleSpec | null>(null);
  // Center-of-screen reject-stamp shown when the user tries to add a blocked
  // module (already in basket, wont-stack, curve-mode owner-block, etc.). The
  // sidebar tile also greys out but that's easy to miss; the popup is loud.
  const [rejectStamp, setRejectStamp] = useState<{ modLabel: string; reason: string; key: number } | null>(null);
  const rejectClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Switching mechanic (direct <-> bonding-curve) fundamentally changes which
  // modules are compatible: curve mode grays out requiresOwner + taxesTransfers.
  // Silently keeping a now-blocked module in the basket would leave a stale
  // selection that trips the launch-blocker banner without the user knowing
  // why. Empty the basket on switch so the state resets to a clean slate.
  useEffect(() => {
    if (mechanic === mechanicOnMount.current) return;
    mechanicOnMount.current = mechanic;
    setSelectedModules([]);
    setModuleParams({});
  }, [mechanic]);

  async function onPickLogo(file: File | undefined) {
    setLogoError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLogoError('pls pick an image file ~~');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setMetadata((prev) => ({ ...prev, logoDataUrl: dataUrl }));
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'could not read file');
    }
  }

  // Touch devices: skip DnD entirely — tap "add to basket" is the mobile-first UX so we
  // don't want the whole card acting as a drag handle (a tap that doesn't reach a drop
  // zone reads as a broken interaction). Desktop keeps the drag-to-basket flair.
  const coarsePointer = useCoarsePointer();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Shop shelf shows only shipped modules — planned ones (B20 compliance tier etc.) live in
  // /catalog so ppl can still see they're on the roadmap without clogging the launch flow.
  //
  // The platform MultiHookHost (LP lock + creator fee split) is baked into every
  // graduated pool — users can't opt out and can't reconfigure the always-on parts.
  // We therefore hide LPLocked / FeeRedirect / MultiHookHost from the shelf (they'd
  // be no-op picks).
  //
  // AntiSniper + BuybackBurn ARE per-launch: the shop sends their params to the
  // Router, Router forwards to CurveFactory.createCurveWithConfig, and the Graduator
  // writes them onto the pool via MultiHookHost.setPoolConfig at graduation. Show
  // them only when the launcher picks a bonding curve (direct-mint tokens never
  // graduate → no pool → these would do nothing).
  const ALWAYS_ON_HOOKS = new Set(['LPLocked', 'FeeRedirect', 'MultiHookHost']);
  const PER_LAUNCH_HOOKS = new Set(['AntiSniper', 'BuybackBurn']);
  const available = useMemo(
    () =>
      shippedModulesForBase(base).filter((m) => {
        if (m.category !== 'hook') return true;
        if (ALWAYS_ON_HOOKS.has(m.id)) return false;
        if (PER_LAUNCH_HOOKS.has(m.id)) return mechanic === 'bonding-curve';
        return false;
      }),
    [base, mechanic],
  );

  /// True blockers only — module can't coexist with something already in the basket
  /// OR the module's post-launch admin functions would be uncallable in the current
  /// launch config. Missing `requires` is NOT a block; picking a module auto-adds
  /// its deps.
  const blockedReasons = useMemo(() => {
    const map: Record<string, string> = {};
    const labelOf = (id: string) => moduleById(id)?.label ?? id;
    for (const mod of available) {
      if (mod.status !== 'shipped') { map[mod.id] = 'not shipped yet ~~'; continue; }
      if (selectedModules.includes(mod.id)) { map[mod.id] = 'already in basket ✿'; continue; }
      const blocker = selectedModules.find((sid) => moduleById(sid)?.incompatibleWith.includes(mod.id));
      if (blocker) { map[mod.id] = `wont stack with ${labelOf(blocker)}`; continue; }
      const conflict = mod.incompatibleWith.find((iid) => selectedModules.includes(iid));
      if (conflict) { map[mod.id] = `wont stack with ${labelOf(conflict)}`; continue; }
      // Curve mechanic auto-renounces ownership (Router forces OwnershipMode.Renounce
      // when installBondingCurve is true — see create page's launch payload). That
      // means every `onlyOwner` function on the token becomes dead after launch.
      // Modules whose whole point is a post-launch owner action would silently
      // ship broken. Grey them out here + surface the reason in the shelf tile.
      // `useCurve` is declared further down — recompute inline to avoid TDZ.
      const curveModeOn = mechanic === 'bonding-curve' && base === 'ERC20';
      if (curveModeOn && mod.requiresOwner) {
        map[mod.id] = 'needs an owner — bonding curve renounces at launch ~';
        continue;
      }
      // Transfer-tax modules (FoT) hook into every ERC-20 transfer. Bonding curve
      // buys are ERC-20 transfers from the curve to the buyer, so a fee would drain
      // curve reserves on every trade + break graduation. Direct-launch is fine.
      if (curveModeOn && mod.taxesTransfers) {
        map[mod.id] = 'transfer tax — would break curve trading + graduation ~';
        continue;
      }
      map[mod.id] = '';
    }
    return map;
  }, [available, selectedModules, mechanic, base]);

  /// Selected modules that would silently break on curve mechanic:
  ///   - `requiresOwner`: admin functions dead (curve auto-renounces)
  ///   - `taxesTransfers`: FoT would tax curve trades + break graduation
  /// Surfaced as a top-of-cart warning + used to block the launch button so
  /// users don't ship a token whose modules don't work with their mechanic.
  const ownerlessDeadModules = useMemo(() => {
    const curveModeOn = mechanic === 'bonding-curve' && base === 'ERC20';
    if (!curveModeOn) return [];
    return selectedModules
      .map((id) => moduleById(id))
      .filter((m): m is ModuleSpec => !!m && (m.requiresOwner === true || m.taxesTransfers === true));
  }, [mechanic, base, selectedModules]);

  /// Deps that a module would auto-pull in when picked — surfaces "+ pulls in Votes"
  /// hints on the tile so the user isn't surprised when the cart gains an extra item.
  const bundleHints = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const mod of available) {
      const missing = mod.requires.filter((r) => !selectedModules.includes(r));
      map[mod.id] = missing.map((r) => moduleById(r)?.label ?? r);
    }
    return map;
  }, [available, selectedModules]);

  function addModule(id: string) {
    const mod = moduleById(id);
    if (!mod || mod.status !== 'shipped') return;
    // Already-in-basket taps aren't errors — silent no-op keeps the drag-drop
    // affordance feeling forgiving. Only the "wont stack" / curve-blocker / etc.
    // reasons trigger the popup below.
    if (selectedModules.includes(id)) return;
    if (blockedReasons[id]) {
      // Show the animated reject stamp with the specific reason. Key increments
      // so React remounts the element and the entrance animation re-fires even
      // when the same module is tapped repeatedly.
      const reason = blockedReasons[id];
      setRejectStamp((prev) => ({ modLabel: mod.label, reason, key: (prev?.key ?? 0) + 1 }));
      if (rejectClearRef.current) clearTimeout(rejectClearRef.current);
      rejectClearRef.current = setTimeout(() => setRejectStamp(null), 2600);
      // Same rejection thud the sidebar tile plays — surface the blocked action
      // through sound too so keyboard-only users get feedback.
      playSfx('stamp');
      return;
    }

    // Basket "drop" thud. Fires for drag-drops AND quick-add clicks since both funnel here.
    playSfx('stamp');

    // Walk the requires chain and pull in every missing dependency.
    const toAdd = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentMod = moduleById(current);
      if (!currentMod) continue;
      for (const req of currentMod.requires) {
        if (!selectedModules.includes(req) && !toAdd.has(req)) {
          toAdd.add(req);
          queue.push(req);
        }
      }
    }

    setSelectedModules((prev) => [...prev, ...toAdd].sort((a, b) => a.localeCompare(b)));
    setModuleParams((prev) => {
      const next = { ...prev };
      for (const newId of toAdd) {
        if (next[newId]) continue;
        const newMod = moduleById(newId);
        if (!newMod) continue;
        const seeded: Record<string, unknown> = {};
        for (const p of newMod.params) if (p.defaultValue !== undefined) seeded[p.key] = p.defaultValue;
        next[newId] = seeded;
      }
      return next;
    });
  }
  function removeModule(id: string) {
    setSelectedModules((prev) => prev.filter((m) => m !== id));
  }
  function onDragStart(e: DragStartEvent) {
    const modId = e.active.data.current?.moduleId as string | undefined;
    if (modId) setDragMod(moduleById(modId) ?? null);
  }
  function onDragEnd(e: DragEndEvent) {
    setDragMod(null);
    if (e.over?.id === 'cart') {
      const modId = e.active.data.current?.moduleId as string | undefined;
      if (modId) addModule(modId);
    }
  }

  // Registry probes
  const nameQuery = useReadContract({
    abi: nameRegistryAbi,
    address: contracts?.NameRegistry,
    functionName: 'isNameAvailable',
    args: [name],
    query: { enabled: !!contracts && name.trim().length > 0, staleTime: 3_000 },
  });
  const tickerQuery = useReadContract({
    abi: nameRegistryAbi,
    address: contracts?.NameRegistry,
    functionName: 'isTickerAvailable',
    args: [ticker],
    query: { enabled: !!contracts && ticker.trim().length >= 2, staleTime: 3_000 },
  });

  // Hook modules (LPLocked, FeeRedirect, AntiSniper, MultiHookHost, BuybackBurn) attach to
  // the Uniswap v4 pool at graduation — they are NOT baked into the token template. Exclude
  // them from the hash + the template moduleData so the factory can find the right impl.
  const templateModuleIds = useMemo(
    () => selectedModules.filter((id) => moduleById(id)?.category !== 'hook'),
    [selectedModules],
  );
  const configHash = useMemo(() => configHashFor(base, templateModuleIds), [base, templateModuleIds]);
  const factoryAddress = contracts
    ? base === 'ERC20'
      ? contracts.ERC20Factory
      : base === 'ERC721A'
        ? contracts.ERC721AFactory
        : contracts.ERC1155Factory
    : undefined;

  const implQuery = useReadContract({
    abi: erc20FactoryAbi,
    address: factoryAddress,
    functionName: 'implFor',
    args: [configHash],
    query: { enabled: !!factoryAddress, staleTime: 5_000 },
  });

  // When bonding curve is selected, initial supply comes from the curve factory (fixed
  // ~800M) and recipient MUST be the Router (which then forwards to the curve on launch).
  const curveDefaultSupplyQuery = useReadContract({
    abi: curveFactoryAbi,
    address: contracts?.CurveFactory,
    functionName: 'defaultCurveSupply',
    query: { enabled: !!contracts && mechanic === 'bonding-curve', staleTime: 60_000 },
  });
  const curveSupplyWei = (curveDefaultSupplyQuery.data as bigint | undefined) ?? 800_000_000n * 10n ** 18n;
  const useCurve = mechanic === 'bonding-curve' && base === 'ERC20';

  const initialSupplyWei = useMemo(() => {
    if (useCurve) return curveSupplyWei;
    try { return parseUnits(supplyInput || '0', 18); } catch { return 0n; }
  }, [supplyInput, useCurve, curveSupplyWei]);
  const initialRecipient = useCurve
    ? ((contracts?.Router ?? zeroAddress) as Address)
    : ((address ?? zeroAddress) as Address);
  const maxSupplyBigint = useMemo(() => {
    try { return BigInt(maxSupplyInput || '0'); } catch { return 0n; }
  }, [maxSupplyInput]);

  const moduleDataArray = useMemo<Hex[]>(() => {
    // Match the on-chain expectation: sorted by id, template modules only (hooks excluded).
    const sorted = [...templateModuleIds].sort((a, b) => a.localeCompare(b));
    return sorted.map((id) => {
      const mod = moduleById(id);
      if (!mod) return '0x' as Hex;
      return encodeModuleSlice(mod, moduleParams[id] ?? {});
    });
  }, [templateModuleIds, moduleParams]);

  const initData = useMemo(() => {
    if (base === 'ERC20')
      return encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes[]' }],
        [initialSupplyWei, initialRecipient, moduleDataArray],
      );
    if (base === 'ERC721A')
      return encodeAbiParameters(
        [{ type: 'string' }, { type: 'uint256' }, { type: 'bytes[]' }],
        [baseURI, maxSupplyBigint, moduleDataArray],
      );
    return encodeAbiParameters([{ type: 'string' }, { type: 'bytes[]' }], [uri1155, moduleDataArray]);
  }, [base, initialSupplyWei, initialRecipient, baseURI, maxSupplyBigint, uri1155, moduleDataArray]);

  const multisigValid = ownership !== 'TransferToMultisig' || isAddress(multisigTarget);

  // Per-launch hook config — read straight out of the ModulePicker's param state.
  // Only meaningful when useCurve is true (Router revert-guards on non-bonding-curve
  // launches too, but the frontend should send zeros to keep the invariant obvious).
  const antiSniperBlocks = useMemo<number>(() => {
    if (!useCurve || !selectedModules.includes('AntiSniper')) return 0;
    const raw = moduleParams['AntiSniper']?.gateBlocks;
    const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }, [useCurve, selectedModules, moduleParams]);

  const buybackBurnBps = useMemo<number>(() => {
    if (!useCurve || !selectedModules.includes('BuybackBurn')) return 0;
    const raw = moduleParams['BuybackBurn']?.burnBps;
    const pct = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    // percent → bps, capped at MAX_BUYBACK_BPS = 2000 (matches MultiHookHost).
    return Math.min(2000, Math.floor(pct * 100));
  }, [useCurve, selectedModules, moduleParams]);

  const params = useMemo(
    () =>
      ({
        base: BASE_TYPE_TO_UINT[base],
        name,
        ticker,
        configHash,
        initData,
        moduleCount: BigInt(Math.max(1, templateModuleIds.length)),
        installHook: false,
        installGovernance: false,
        installBondingCurve: useCurve,
        ownership: useCurve ? OWNERSHIP_TO_UINT.Renounce : OWNERSHIP_TO_UINT[ownership],
        ownerTargetIfMultisig:
          !useCurve && ownership === 'TransferToMultisig' && multisigValid ? (multisigTarget as Address) : zeroAddress,
        antiSniperBlocks,
        buybackBurnBps,
      }) as const,
    [base, name, ticker, configHash, initData, templateModuleIds.length, ownership, multisigTarget, multisigValid, useCurve, antiSniperBlocks, buybackBurnBps],
  );

  // Quote paths:
  //   grossQuote  — Router.quote(params) → pre-discount fee, drives the display of
  //                 "gross" so users can see how much the loyalty discount saved them.
  //   quote       — Router.quoteFor(params, wallet) → actual fee they'll pay. When
  //                 wallet isn't connected yet, falls through to grossQuote so first-
  //                 paint still shows a price. This is what msg.value + button disable
  //                 gate on so the on-chain check matches what we display.
  const grossQuote = useReadContract({
    abi: routerAbi,
    address: contracts?.Router,
    functionName: 'quote',
    args: [params],
    query: { enabled: !!contracts && name.length > 0 && ticker.length >= 2 },
  });
  const discountedQuote = useReadContract({
    abi: routerAbi,
    address: contracts?.Router,
    functionName: 'quoteFor',
    args: address ? [params, address] : undefined,
    query: { enabled: !!contracts && !!address && name.length > 0 && ticker.length >= 2 },
  });
  const quote = (discountedQuote.data !== undefined ? discountedQuote : grossQuote);
  const discountBps = useMemo(() => {
    if (!grossQuote.data || !discountedQuote.data) return 0;
    const gross = grossQuote.data as bigint;
    const net = discountedQuote.data as bigint;
    if (gross === 0n) return 0;
    return Number(((gross - net) * 10_000n) / gross);
  }, [grossQuote.data, discountedQuote.data]);

  // Live fee schedule — the receipt breakdown reads from these so the display always
  // matches what Router.quote() actually charges, even after owner-side setFee /
  // setAddOnFees calls. Prior version hardcoded 0.05 ETH base / 0.01 ETH module which
  // silently drifted whenever fees were tuned on-chain.
  const feeReads = useReadContracts({
    contracts: contracts?.Router
      ? [
          { abi: routerAbi, address: contracts.Router, functionName: 'fees' as const, args: [BASE_TYPE_TO_UINT[base]] },
          { abi: routerAbi, address: contracts.Router, functionName: 'moduleAddOnFee' as const },
          { abi: routerAbi, address: contracts.Router, functionName: 'hookAddOnFee' as const },
          { abi: routerAbi, address: contracts.Router, functionName: 'governanceAddOnFee' as const },
        ]
      : [],
    query: { enabled: !!contracts?.Router, staleTime: 30_000 },
  });
  const feeSchedule = useMemo(() => {
    const r = feeReads.data;
    return {
      base: (r?.[0]?.result as bigint | undefined) ?? 0n,
      module: (r?.[1]?.result as bigint | undefined) ?? 0n,
      hook: (r?.[2]?.result as bigint | undefined) ?? 0n,
      gov: (r?.[3]?.result as bigint | undefined) ?? 0n,
    };
  }, [feeReads.data]);
  // Modules array in the launch params: first N-1 modules are the payable ones per
  // Router.quote math. Templates + base module don't get charged separately.
  const moduleCount = Math.max(0, selectedModules.length - 1);

  const implRegistered = implQuery.data && implQuery.data !== zeroAddress;

  // Popup for "combo not shipped". Fires when the user has added modules that
  // individually pass compat checks but combine into a configHash the
  // ERC20Factory doesn't have an impl for. The launch button also greys out
  // (canLaunch gates on !!implRegistered), but a small "impl: not registered"
  // line at the cart bottom is easy to miss — the loud stamp explains it.
  // Skips: the initial render (implQuery.isLoading), the bare-token case
  // (no modules selected), and when a combo is registered.
  useEffect(() => {
    if (implQuery.isLoading || implQuery.data === undefined) return;
    if (selectedModules.length === 0) return;
    if (implRegistered) return;
    // What modules got combined into the unregistered hash? Show all of them
    // in the popup so the user knows exactly which selection tripped it.
    const label = selectedModules.map((id) => moduleById(id)?.label ?? id).join(' + ');
    setRejectStamp((prev) => ({
      modLabel: label,
      reason: 'this combo isn\'t shipped yet — try fewer modules or a different mix',
      key: (prev?.key ?? 0) + 1,
    }));
    if (rejectClearRef.current) clearTimeout(rejectClearRef.current);
    rejectClearRef.current = setTimeout(() => setRejectStamp(null), 3400);
    playSfx('stamp');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [implRegistered, implQuery.isLoading, implQuery.data, selectedModules.join(',')]);

  // Cart preview silently substitutes zeroAddress / 0 for empty required fields so viem
  // doesn't crash on every keystroke. That safety valve must NOT propagate into a real
  // launch — walk the selected modules and block if anything required is still blank.
  const moduleParamsFilled = useMemo(() => {
    for (const id of selectedModules) {
      const mod = moduleById(id);
      if (!mod) continue;
      const p = moduleParams[id] ?? {};
      for (const field of mod.params) {
        const raw = p[field.key];
        if (field.type === 'address') {
          if (typeof raw !== 'string' || !isAddress(raw)) return false;
        } else if (field.type === 'integer' || field.type === 'percent') {
          if (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) return false;
        } else if (field.type === 'string') {
          if (typeof raw !== 'string' || raw.length === 0) return false;
        } else if (field.type === 'eth') {
          if (typeof raw !== 'string' || raw.trim().length === 0) return false;
          try { parseUnits(raw, 18); } catch { return false; }
        }
      }
    }
    return true;
  }, [selectedModules, moduleParams]);

  const canLaunch =
    !!contracts && isConnected && isOnEnabledChain &&
    (nameQuery.data ?? false) && (tickerQuery.data ?? false) &&
    multisigValid && moduleParamsFilled && !!implRegistered && typeof quote.data === 'bigint'
    // Prevent shipping a token that would have dead owner-only functions. If the
    // basket has any requiresOwner module while curve mechanic is on, the launch
    // would silently install those admin functions with owner=address(0) at
    // graduation — pause() etc. would revert forever. Force the user to remove
    // one or the other before the button unlocks.
    && ownerlessDeadModules.length === 0;

  const simulate = useSimulateContract({
    abi: routerAbi,
    address: contracts?.Router,
    functionName: 'launch',
    args: [params],
    value: (quote.data as bigint | undefined) ?? 0n,
    account: address,
    query: { enabled: canLaunch },
  });

  const { writeContract, isPending: launchPending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const launchedTokenAddress = useMemo(() => {
    if (!receipt.data) return null;
    const launched = receipt.data.logs.find(
      (log) => log.address.toLowerCase() === contracts?.Router.toLowerCase(),
    );
    if (!launched || launched.topics.length < 2) return null;
    const t1 = launched.topics[1];
    if (!t1) return null;
    return `0x${t1.slice(-40)}` as Address;
  }, [receipt.data, contracts]);

  // useRef, not useMemo — React 19 compiler treats memoized values as immutable; mutable
  // "did this happen already" flags belong in a ref. Refs also don't trigger re-renders.
  const savedRef = useRef(false);
  const { signMessageAsync } = useSignMessage();
  if (launchedTokenAddress && !savedRef.current) {
    const hasAny = metadata.logoDataUrl || metadata.description || metadata.website || metadata.twitter;
    if (hasAny) {
      savedRef.current = true;
      // Two-phase persist:
      //   1. persistMetadata — writes localStorage synchronously + kicks off Pinata pin (if
      //      NEXT_PUBLIC_PINATA_JWT is set). Returns the { cid, gatewayUrl } once pinned.
      //   2. saveTokenMetadata — POSTs the resulting gateway URL to compile-service so every
      //      other browser can render the image. Requires one wallet signature; if the user
      //      cancels, the local snapshot is still there so THEIR view is unaffected.
      void (async () => {
        const pinned = await persistMetadata(chainId, launchedTokenAddress, metadata);
        if (!address) return;
        try {
          await saveTokenMetadata(
            address as Address,
            {
              chainId,
              tokenAddress: launchedTokenAddress,
              imageUrl: pinned.gatewayUrl ?? null,
              description: metadata.description ?? null,
              website: metadata.website ?? null,
              twitter: metadata.twitter ?? null,
              telegram: metadata.telegram ?? null,
              discord: metadata.discord ?? null,
              tiktok: metadata.tiktok ?? null,
            },
            ({ message }) => signMessageAsync({ message }),
          );
        } catch {
          // User cancelled signature or network hiccup — local persistence still succeeded.
        }
      })();
    }
  }

  const mascotMood = launchedTokenAddress
    ? 'gasp'
    : selectedModules.length > 3
      ? 'gasp'
      : selectedModules.length === 0
        ? 'sleepy'
        : 'happy';

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {/* Center-of-screen reject stamp — fires when the user taps a blocked
          module. Rides the existing uru-pop keyframes for its entrance so it
          matches the paper/stamp aesthetic. Auto-dismisses in 2.6s (managed
          via rejectClearRef in addModule). Pointer-events off so the popup
          doesn't steal clicks. */}
      {rejectStamp && (
        <div
          key={rejectStamp.key}
          aria-live="polite"
          role="status"
          style={{
            position: 'fixed',
            top: '38%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 9999,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div
            className="uru-pop"
            style={{
              background: 'var(--pink-warm)',
              border: '3px solid var(--anchor)',
              boxShadow: '6px 6px 0 var(--anchor)',
              padding: '18px 28px',
              borderRadius: 6,
              minWidth: 260,
              textAlign: 'center',
              fontFamily: 'inherit',
              transform: 'rotate(-2deg)',
            }}
          >
            <div
              className="uru-stamp uru-stamp-pink"
              style={{ display: 'inline-block', transform: 'rotate(-6deg)', fontSize: 14, marginBottom: 6 }}
            >
              ✗ REJECTED
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--anchor)', marginTop: 4 }}>
              {rejectStamp.modLabel}
            </div>
            <div style={{ fontSize: 12, color: 'var(--anchor-soft)', marginTop: 4, fontStyle: 'italic' }}>
              {rejectStamp.reason}
            </div>
          </div>
        </div>
      )}
      {/* Top marquee lives in the root layout — see components/TokenTicker.tsx */}
      <div className="mx-auto max-w-6xl px-4 py-4">
        {/* Header cluster — high density anchor zone per SKILL.md §density */}
        <header className="relative mb-3" style={{ paddingTop: 20 }}>
          {/* stamps cluster — kept above the content strip so nothing overlaps the eyebrow */}
          <span className="uru-stamp uru-stamp-pink" style={{ position: 'absolute', top: 0, right: 140, transform: 'rotate(-7deg)' }}>
            ★ new
          </span>
          <span className="uru-stamp uru-stamp-mint" style={{ position: 'absolute', top: 4, right: 78, transform: 'rotate(3deg)' }}>
            v1.2
          </span>
          <span className="uru-stamp uru-stamp-mizuiro" style={{ position: 'absolute', top: 0, right: 8, transform: 'rotate(11deg)' }}>
            fresh~
          </span>

          <div className="flex items-end gap-4">
            <div className="flex items-end gap-3">
              <Mascot size={72} mood={mascotMood} className="uru-idle-bob" />
              <div style={{ paddingBottom: 6 }}>
                <div
                  className="uru-h1"
                  style={{
                    fontSize: 26,
                    lineHeight: 1,
                    letterSpacing: '-0.5px',
                  }}
                >
                  urufu<span style={{ color: 'var(--pink-hot)' }}>labs</span>
                  <sup style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, marginLeft: 2, color: 'var(--anchor-soft)' }}>®</sup>
                </div>
                <div className="uru-eyebrow" style={{ marginTop: 4 }}>front counter</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <h1 className="uru-h1" style={{ fontSize: '38px' }}>
              pick <span style={{ color: 'var(--pink-hot)' }}>u</span>r modules
              <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: '24px', marginLeft: 8 }}>
                好き
              </span>
            </h1>
            <p className="uru-h2" style={{ fontSize: 15, fontWeight: 400, marginTop: 4, maxWidth: 620 }}>
              drag stuff from the shelf into the basket. every module gets spliced right into ur token's
              solidity — not a wrapper, real code (◕‿◕✿). alphabetical order bc that's what the splicer
              wants.
            </p>
          </div>
        </header>

        {mounted && !contracts && (
          <div className="uru-shell uru-shell-tight mb-3" style={{ background: 'var(--yolk)' }}>
            <div className="flex items-start gap-3">
              <Mascot size={40} mood="confused" />
              <div>
                <div className="uru-h2" style={{ fontSize: 15 }}>oh no,, contracts arent live on this chain yet ~~</div>
                <div style={{ fontSize: 12, marginTop: 4, color: 'var(--anchor-soft)' }}>
                  u can browse everything, but launch stays disabled til DeployPhase1 broadcasts and addresses
                  land in <code style={{ fontFamily: 'var(--font-pixel), monospace' }}>web/src/lib/config.ts</code>.
                </div>
              </div>
            </div>
          </div>
        )}

        {mounted && isConnected && !isOnEnabledChain && (
          <div className="uru-shell uru-shell-tight mb-3" style={{ background: 'var(--pink-warm)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Mascot size={40} mood="gasp" />
                <div>
                  <div className="uru-h2" style={{ fontSize: 15 }}>wrong network!!</div>
                  <div style={{ fontSize: 12, marginTop: 2 }}>pls switch to {CHAIN_LABELS[targetChain]} ~~</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => switchChain({ chainId: CHAIN_KEY_TO_ID[targetChain] })}
                disabled={switchPending}
                className="uru-btn uru-btn-primary"
              >
                {switchPending ? 'switching..' : `switch >>`}
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          {/* MAIN — the shop counter */}
          <div className="space-y-3">
            {/* STEP 1 — base picker with prime-tilt polaroids */}
            <section className="uru-shell">
              <span className="uru-tape" style={{ width: 74, height: 16, top: -8, left: 42, transform: 'rotate(-7deg)' }} />
              <span className="uru-tape uru-tape-mizuiro" style={{ width: 62, height: 16, top: -6, right: 60, transform: 'rotate(3deg)' }} />
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>step 1 ✿ pick a base</div>

              <div className="uru-shell-inner">
                <div className="grid gap-3 sm:grid-cols-3">
                  {(['ERC20', 'ERC721A', 'ERC1155'] as const).map((b, i) => {
                    const info = BASE_LABELS[b];
                    const active = base === b;
                    const disabled = DISABLED_BASES.includes(b);
                    const tilt = TILTS[i]!;
                    return (
                      <button
                        key={b}
                        type="button"
                        onClick={() => { if (!disabled) { setBase(b); setSelectedModules([]); } }}
                        disabled={disabled}
                        aria-disabled={disabled}
                        title={disabled ? 'coming soon ✿' : undefined}
                        className="uru-polaroid text-left relative"
                        data-tilt={active ? undefined : tilt}
                        style={{
                          boxShadow: active ? '4px 4px 0 var(--pink-hot)' : undefined,
                          background: active ? 'var(--pink-warm)' : '#fff',
                          opacity: disabled ? 0.45 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          filter: disabled ? 'grayscale(0.6)' : undefined,
                        }}
                      >
                        {disabled && (
                          <span
                            className="uru-tape"
                            style={{
                              position: 'absolute',
                              top: 4,
                              right: 4,
                              padding: '2px 6px',
                              fontFamily: 'var(--font-pixel), monospace',
                              fontSize: 9,
                              background: 'var(--anchor)',
                              color: 'var(--cream)',
                              transform: 'rotate(6deg)',
                              width: 'auto',
                              height: 'auto',
                              letterSpacing: '0.05em',
                            }}
                          >
                            soon ✧
                          </span>
                        )}
                        <div style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 28, textAlign: 'center', color: 'var(--anchor)' }}>
                          {info.jp}
                        </div>
                        <div className="uru-h2" style={{ fontSize: 14, textAlign: 'center', marginTop: 2 }}>
                          {info.label}
                        </div>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, textAlign: 'center', color: 'var(--anchor-soft)', marginTop: 2 }}>
                          {info.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* STEP 1B — launch mechanic */}
            <section className="uru-shell">
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>step 1.5 ✿ launch mechanic</div>
              <div className="uru-shell-inner">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setMechanic('direct')}
                    className="uru-polaroid text-left"
                    style={{
                      background: mechanic === 'direct' ? 'var(--pink-warm)' : '#fff',
                      boxShadow: mechanic === 'direct' ? '4px 4px 0 var(--pink-hot)' : undefined,
                    }}
                  >
                    <div className="uru-h2" style={{ fontSize: 14 }}>
                      ✿ direct launch
                      <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 12, marginLeft: 6 }}>直</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--anchor-soft)', marginTop: 4, lineHeight: 1.4 }}>
                      supply lands in ur wallet. u decide what to do with it (add LP yourself, airdrop, whatever)
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (base === 'ERC20') setMechanic('bonding-curve'); }}
                    disabled={base !== 'ERC20'}
                    className="uru-polaroid text-left"
                    style={{
                      background: mechanic === 'bonding-curve' ? 'var(--mint)' : '#fff',
                      boxShadow: mechanic === 'bonding-curve' ? '4px 4px 0 var(--anchor)' : undefined,
                      opacity: base !== 'ERC20' ? 0.4 : 1,
                      cursor: base !== 'ERC20' ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <div className="uru-h2" style={{ fontSize: 14 }}>
                      ✿ bonding curve
                      <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 12, marginLeft: 6 }}>曲線</span>
                      {base !== 'ERC20' && (
                        <span className="uru-stamp" style={{ marginLeft: 8, transform: 'rotate(-2deg)', background: 'var(--pink-warm)' }}>erc-20 only</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--anchor-soft)', marginTop: 4, lineHeight: 1.4 }}>
                      pump.fun style. supply goes to a curve, ppl trade against it, graduates to uniswap v4 at 4 ETH raised ★
                    </div>
                    {mechanic === 'bonding-curve' && (
                      <div style={{ marginTop: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor)' }}>
                        + supply auto-set to 800M · fee 1% · target 4 ETH → grad
                      </div>
                    )}
                  </button>
                </div>
              </div>
            </section>

            {/* STEP 2 — shelf */}
            <section className="uru-shell">
              <span className="uru-tape uru-tape-mint" style={{ width: 82, height: 16, top: -8, right: 30, transform: 'rotate(11deg)' }} />
              <div className="flex items-baseline justify-between mb-2">
                <div className="uru-eyebrow">step 2 ✿ the shelf</div>
                <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                  drag <span className="uru-arrow">→</span> or click add
                </span>
              </div>

              <div className="uru-shell-inner">
                {available.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center' }}>
                    <Mascot size={40} mood="sleepy" />
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--anchor-soft)' }}>
                      no modules on the shelf for this base yet~~
                    </div>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {available.map((mod, i) => (
                    <ShelfItem
                      key={mod.id}
                      mod={mod}
                      tilt={TILTS[(i + 2) % TILTS.length]!}
                      blockedReason={blockedReasons[mod.id] ?? ''}
                      bundleWith={bundleHints[mod.id] ?? []}
                      onQuickAdd={() => addModule(mod.id)}
                      draggable={!coarsePointer}
                    />
                  ))}
                </div>
                {base === 'ERC20' && mechanic === 'bonding-curve' && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      background: 'var(--mint)',
                      border: '1.5px dashed var(--anchor)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      fontFamily: 'var(--font-round), Klee One, cursive',
                    }}
                  >
                    ✿ <b>on graduation</b>, ur curve auto-installs the platform hook:{' '}
                    <b>LP locked forever</b> on Uniswap v4 + <b>1% creator fee</b> on every
                    swap (claim it anytime from ur profile). opt-in extras from the shelf —{' '}
                    <b>sniper gate</b> + <b>buy → burn</b> — get wired into the same pool at
                    graduation using the params u picked ~
                  </div>
                )}
              </div>
            </section>

            {/* STEP 3 — identity */}
            <section className="uru-shell">
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>step 3 ✿ name ur baby</div>
              <div className="uru-shell-inner space-y-3">
                <FieldGrid>
                  <Field label="name">
                    <input
                      className="uru-input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="urufu labs coin"
                      maxLength={32}
                    />
                    <NameStatus data={nameQuery.data} isFetching={nameQuery.isFetching} enabled={name.length > 0} />
                  </Field>
                  <Field label="ticker">
                    <input
                      className="uru-input uppercase"
                      value={ticker}
                      onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      placeholder="URUFU"
                      maxLength={10}
                    />
                    <NameStatus data={tickerQuery.data} isFetching={tickerQuery.isFetching} enabled={ticker.length >= 2} />
                  </Field>
                </FieldGrid>

                {base === 'ERC20' && !useCurve && (
                  <Field label="initial supply">
                    <input className="uru-input" type="number" value={supplyInput} onChange={(e) => setSupplyInput(e.target.value)} />
                  </Field>
                )}
                {base === 'ERC20' && useCurve && (
                  <div style={{ padding: 10, background: 'var(--mint)', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, lineHeight: 1.5 }}>
                    ✿ curve mode: supply auto = <b>800,000,000</b>. all of it goes to the bonding
                    curve, ownership auto-renounces. u can trade against it at{' '}
                    <code>/trade/&lt;tokenAddress&gt;</code> right after launch~
                  </div>
                )}

                {base === 'ERC721A' && (
                  <FieldGrid>
                    <Field label="base uri">
                      <input
                        className="uru-input"
                        value={baseURI}
                        onChange={(e) => setBaseURI(e.target.value)}
                        placeholder={selectedModules.includes('OnChainSVG') ? '(svg module handles it~)' : 'ipfs://Qm.../'}
                      />
                    </Field>
                    <Field label="max supply">
                      <input className="uru-input" type="number" value={maxSupplyInput} onChange={(e) => setMaxSupplyInput(e.target.value)} />
                    </Field>
                  </FieldGrid>
                )}

                {base === 'ERC1155' && (
                  <Field label="uri template">
                    <input className="uru-input" value={uri1155} onChange={(e) => setUri1155(e.target.value)} placeholder="ipfs://Qm.../{id}.json" />
                  </Field>
                )}
              </div>
            </section>

            {/* STEP 4 — ownership. Curve mechanic force-renounces ownership on-chain
                (see the launch payload's `ownership: useCurve ? Renounce : ...` line
                below), so showing an interactive picker would silently lie to the
                user. When curve is on we render a fixed "auto-renounced" card
                instead. When direct-launch, the three-mode radio is live. */}
            <section className="uru-shell">
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>step 4 ✿ ownership</div>
              <div className="uru-shell-inner">
                {useCurve ? (
                  <div
                    style={{
                      padding: 10,
                      background: 'var(--cream-deep)',
                      border: '1.5px dashed var(--anchor)',
                      fontFamily: 'var(--font-round), Klee One, cursive',
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    <b>auto-renounced</b> ~ bonding-curve launches must renounce so the
                    curve is trustless to trade. no admin, no pause switch, no owner-only
                    knobs. pick <b>direct launch</b> back on step 1 if u want to keep
                    ownership.
                  </div>
                ) : (
                  <>
                    <ul className="uru-list-flower" style={{ display: 'grid', gap: 8 }}>
                      {(
                        [
                          ['Renounce', 'renounce ownership (recommended ~ immutable behavior)'],
                          ['TransferToMultisig', 'transfer to a multisig u control'],
                          ['KeepEOA', 'keep it on ur launcher wallet'],
                        ] as const
                      ).map(([mode, desc]) => (
                        <li key={mode}>
                          <label style={{ display: 'flex', gap: 8, cursor: 'pointer', alignItems: 'flex-start' }}>
                            <input
                              type="radio"
                              name="ownership"
                              checked={ownership === mode}
                              onChange={() => setOwnership(mode)}
                              style={{ marginTop: 2 }}
                            />
                            <div>
                              <div style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontWeight: 700, fontSize: 13 }}>{mode}</div>
                              <div style={{ fontSize: 12, color: 'var(--anchor-soft)' }}>{desc}</div>
                            </div>
                          </label>
                        </li>
                      ))}
                    </ul>
                    {ownership === 'TransferToMultisig' && (
                      <input
                        className="uru-input mt-3"
                        style={{ marginTop: 10 }}
                        value={multisigTarget}
                        onChange={(e) => setMultisigTarget(e.target.value)}
                        placeholder="0x…"
                      />
                    )}
                  </>
                )}
              </div>
            </section>

            {/* STEP 5 — metadata (tiny) */}
            <section className="uru-shell">
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>step 5 ✿ vibes (metadata)</div>
              <div className="uru-shell-inner space-y-3">
                <div style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>
                  optional. saved locally til we ship a real ipfs pipeline lol.
                </div>

                <Field label="logo">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 12,
                        border: '1.5px solid var(--anchor)',
                        boxShadow: '2px 2px 0 var(--anchor)',
                        background: safeBackgroundImage(metadata.logoDataUrl),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 10,
                        color: 'var(--anchor-soft)',
                        textAlign: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {!metadata.logoDataUrl && <span>no<br />logo</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label
                        className="uru-btn uru-btn-mint"
                        style={{ cursor: 'pointer', fontSize: 12, padding: '6px 12px', display: 'inline-flex' }}
                      >
                        {metadata.logoDataUrl ? 'change logo' : '✿ upload logo'}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => onPickLogo(e.target.files?.[0])}
                          style={{ display: 'none' }}
                        />
                      </label>
                      {metadata.logoDataUrl && (
                        <button
                          type="button"
                          onClick={() => { setMetadata({ ...metadata, logoDataUrl: undefined }); setLogoError(null); }}
                          style={{
                            marginLeft: 8,
                            background: 'transparent',
                            border: '1.5px solid var(--anchor)',
                            fontFamily: 'var(--font-pixel), monospace',
                            fontSize: 11,
                            padding: '5px 10px',
                            cursor: 'pointer',
                            color: 'var(--anchor)',
                          }}
                        >
                          remove
                        </button>
                      )}
                      <div style={{ marginTop: 6, fontSize: 10, fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)' }}>
                        png / jpg / svg / gif ~ max 256KB · stored inline til ipfs lands
                      </div>
                      {logoError && (
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pink-hot)' }}>~~ {logoError}</div>
                      )}
                    </div>
                  </div>
                </Field>

                <Field label="description">
                  <textarea
                    className="uru-input"
                    rows={2}
                    maxLength={500}
                    value={metadata.description ?? ''}
                    onChange={(e) => setMetadata({ ...metadata, description: e.target.value })}
                    placeholder="what is this thing?? tell people~~"
                  />
                </Field>
                <FieldGrid>
                  <Field label="website">
                    <input className="uru-input" value={metadata.website ?? ''} onChange={(e) => setMetadata({ ...metadata, website: e.target.value })} placeholder="https://…" />
                  </Field>
                  <Field label="twitter">
                    <input className="uru-input" value={metadata.twitter ?? ''} onChange={(e) => setMetadata({ ...metadata, twitter: e.target.value })} placeholder="https://x.com/…" />
                  </Field>
                  <Field label="telegram">
                    <input className="uru-input" value={metadata.telegram ?? ''} onChange={(e) => setMetadata({ ...metadata, telegram: e.target.value })} placeholder="https://t.me/…" />
                  </Field>
                  <Field label="discord">
                    <input className="uru-input" value={metadata.discord ?? ''} onChange={(e) => setMetadata({ ...metadata, discord: e.target.value })} placeholder="https://discord.gg/…" />
                  </Field>
                  <Field label="tiktok">
                    <input className="uru-input" value={metadata.tiktok ?? ''} onChange={(e) => setMetadata({ ...metadata, tiktok: e.target.value })} placeholder="https://tiktok.com/@…" />
                  </Field>
                </FieldGrid>
              </div>
            </section>
          </div>

          {/* SIDEBAR — cart + widgets + webring */}
          <aside className="space-y-3 lg:sticky lg:top-4 lg:h-fit">
            {/* Shopkeeper speech bubble */}
            <div className="flex items-start gap-2">
              <Mascot size={44} mood={mascotMood} className="uru-idle-bob" />
              <div className="uru-bubble">
                {launchedTokenAddress ? (
                  <>yayyy!! ur token is live 好き!! (づ｡◕‿‿◕｡)づ</>
                ) : selectedModules.length === 0 ? (
                  <>hi hi!! pls drag something into the basket ~ i sorted em by category for u (◕‿◕✿)</>
                ) : selectedModules.length === 1 ? (
                  <>1 module in the basket ★ add more or checkout below</>
                ) : (
                  <>{selectedModules.length} modules stacked!! ✿ splicer will sort alphabetical bc thats the rule</>
                )}
              </div>
            </div>

            <CartDropZone
              selectedModules={selectedModules}
              moduleParams={moduleParams}
              onRemove={removeModule}
              onParamsChange={(id, v) => setModuleParams((prev) => ({ ...prev, [id]: v }))}
            />

            {/* Curve + owner-module conflict warning. Renders only when the basket
                has a requiresOwner module while curve mechanic is on. The launch
                button is already gated on this in canLaunch, so this is the
                "why is my launch button greyed out?" explanation. */}
            {ownerlessDeadModules.length > 0 && (
              <div
                style={{
                  background: 'var(--pink-warm)',
                  border: '1.5px solid var(--pink-hot)',
                  padding: 10,
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>~~ heads up ✿</div>
                <span>
                  ur basket has{' '}
                  <b>{ownerlessDeadModules.map((m) => m.label.replace(/^✿\s*/, '')).join(', ')}</b>
                  {' '}— these have owner-only functions (pause, allowlist, etc). bonding-curve
                  launches auto-renounce ownership so those buttons would be dead forever.
                  drop these modules, or switch to <b>direct launch</b> up top.
                </span>
              </div>
            )}

            {/* Receipt + launch */}
            <div className="uru-shell uru-shell-tight">
              <div className="flex items-baseline justify-between">
                <div className="uru-eyebrow">receipt</div>
                <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 20, fontWeight: 700, color: 'var(--anchor)' }}>
                  {typeof quote.data === 'bigint' ? formatEther(quote.data) : '—'}
                  <span style={{ fontSize: 10, color: 'var(--anchor-soft)', marginLeft: 4 }}>ETH</span>
                </div>
              </div>
              <ul style={{ margin: '10px 0 12px 0', fontSize: 11, color: 'var(--anchor-soft)', listStyle: 'none', padding: 0 }}>
                <li>✿ base fee: {formatEther(feeSchedule.base)} ETH</li>
                <li>✿ module add-on: {formatEther(feeSchedule.module)} ea × {moduleCount}</li>
                {discountBps > 0 && grossQuote.data && (
                  <>
                    <li style={{ marginTop: 4, color: 'var(--anchor-soft)', textDecoration: 'line-through' }}>
                      subtotal: {formatEther(grossQuote.data as bigint)} ETH
                    </li>
                    <li style={{ color: 'var(--mint-hot,#2b8a3e)', fontWeight: 700 }}>
                      ✿ loyalty discount: −{(discountBps / 100).toFixed(0)}% (holding urufu gemu nft {'&'} URU)
                    </li>
                  </>
                )}
              </ul>

              <button
                type="button"
                onClick={() => simulate.data && writeContract(simulate.data.request)}
                disabled={!canLaunch || !simulate.data || launchPending || receipt.isLoading}
                className="uru-btn uru-btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {launchPending
                  ? 'confirming ~~'
                  : receipt.isLoading
                    ? 'waiting..'
                    : implRegistered
                      ? '✿ launch ✿'
                      : 'impl not registered'}
              </button>

              {simulate.error && (
                <div style={{ marginTop: 8, padding: 8, background: 'var(--pink-warm)', border: '1px solid var(--anchor)', fontSize: 10, color: 'var(--anchor)' }}>
                  sim failed: {simulate.error.message.slice(0, 120)}
                </div>
              )}

              {txHash && (
                <div style={{ marginTop: 8, fontSize: 11 }}>
                  tx:{' '}
                  <Link href={activeChain ? explorerTxUrl(activeChain, txHash) : '#'} target="_blank" style={{ color: 'var(--link-blue)', textDecoration: 'underline', fontFamily: 'var(--font-pixel), monospace' }}>
                    {short(txHash)}
                  </Link>
                </div>
              )}

              {launchedTokenAddress && (
                <div className="uru-pop" style={{ marginTop: 8, padding: 10, background: 'var(--mint)', border: '2px double var(--anchor)' }}>
                  <div className="uru-h2" style={{ fontSize: 13 }}>✿ deployed ✿</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    at{' '}
                    <Link href={activeChain ? explorerAddressUrl(activeChain, launchedTokenAddress) : '#'} target="_blank" style={{ color: 'var(--link-blue)', textDecoration: 'underline', fontFamily: 'var(--font-pixel), monospace' }}>
                      {short(launchedTokenAddress)}
                    </Link>
                  </div>
                  {useCurve && (
                    <Link
                      href={`/trade/${launchedTokenAddress}`}
                      className="uru-btn uru-btn-primary"
                      style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                    >
                      ✿ trade this token →
                    </Link>
                  )}
                </div>
              )}
            </div>

            {/* "currently" widget — cheap author-trace signal */}
            <div className="uru-shell uru-shell-tight">
              <div className="uru-eyebrow" style={{ marginBottom: 6 }}>✿ currently</div>
              <ul className="uru-list-flower" style={{ fontSize: 11, lineHeight: 1.6 }}>
                <li>listening — Perfume, <i>Polyrhythm</i></li>
                <li>testing — sepolia forks</li>
                <li>obsessed with — dnd-kit spring physics </li>
                <li>mood — 好き 好き 大好き</li>
              </ul>
            </div>

            {/* 88x31 webring — reciprocal embedding signal */}
            <div>
              <div className="uru-eyebrow" style={{ marginBottom: 4, color: 'var(--cream)' }}>friends of urufu ✿</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <span className="uru-88 uru-88-pink"><strong>urufu</strong>labs</span>
                <span className="uru-88 uru-88-mint">chibi-<strong>wolf</strong></span>
                <span className="uru-88 uru-88-mizuiro">solady<strong>.gg</strong></span>
                <span className="uru-88">forge<strong>&hearts;</strong></span>
              </div>
            </div>

            {/* Composition info — tiny receipt strip */}
            <div className="uru-shell uru-shell-tight">
              <div className="uru-eyebrow" style={{ marginBottom: 4 }}>tech</div>
              <dl style={{ fontSize: 10, fontFamily: 'var(--font-pixel), monospace', lineHeight: 1.6, color: 'var(--anchor-soft)' }}>
                <div>base: <span style={{ color: 'var(--anchor)' }}>{base}</span></div>
                <div>modules: <span style={{ color: 'var(--anchor)' }}>{selectedModules.length === 0 ? 'none' : selectedModules.join(', ')}</span></div>
                <div>configHash: <span style={{ color: 'var(--anchor)' }}>{configHash.slice(0, 10)}…</span></div>
                <div>impl: <span style={{ color: implRegistered ? 'var(--anchor)' : 'var(--pink-hot)' }}>{implRegistered ? short(implQuery.data as string) : 'not registered'}</span></div>
              </dl>
            </div>
          </aside>
        </div>
      </div>

      <DragOverlay>
        {dragMod ? (
          <div className="uru-polaroid" data-tilt="n7" style={{ boxShadow: '8px 8px 0 var(--pink-hot)', width: 240, padding: 10, cursor: 'grabbing' }}>
            <div className="uru-h2" style={{ fontSize: 13 }}>{dragMod.label}</div>
            <div style={{ fontSize: 10, color: 'var(--anchor-soft)', marginTop: 2 }}>dropping into basket~</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ============================================================================
// small subcomponents kept in-file — one-page-deep beats scattered
// ============================================================================

function ShelfItem({
  mod,
  tilt,
  blockedReason,
  bundleWith,
  onQuickAdd,
  draggable,
}: {
  mod: ModuleSpec;
  tilt: 'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2';
  blockedReason: string;
  bundleWith: string[];
  onQuickAdd: () => void;
  /// Desktop = true; touch = false. When false the card renders as plain UI (no drag
  /// handle, no grab cursor) and the "add to basket" button is the only entry point.
  draggable: boolean;
}) {
  const planned = mod.status === 'planned';
  const blocked = blockedReason.length > 0;
  const disabled = planned || blocked || !draggable;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `shelf-${mod.id}`,
    data: { moduleId: mod.id },
    disabled,
  });

  // dnd-kit assigns `aria-describedby` from an internal counter that drifts between the
  // server render and the client mount, throwing a hydration warning. Only attach the
  // drag ref + listeners after mount so the first client paint matches the server output.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const dragRef = mounted ? setNodeRef : undefined;
  const dragListeners = mounted ? listeners : {};
  const dragAttributes = mounted ? attributes : {};
  const stampClass =
    mod.category === 'token' ? 'uru-stamp-mint'
    : mod.category === 'nft' ? 'uru-stamp-mizuiro'
    : mod.category === 'allocation' ? 'uru-stamp-cream'
    : 'uru-stamp';

  return (
    <div
      ref={dragRef}
      {...dragListeners}
      {...dragAttributes}
      className="uru-polaroid"
      data-tilt={tilt}
      data-dragging={isDragging}
      data-planned={disabled}
      title={blockedReason || undefined}
      style={{
        cursor: !draggable ? 'default' : disabled ? 'not-allowed' : 'grab',
        opacity: blocked ? 0.42 : undefined,
        filter: blocked ? 'grayscale(0.85)' : undefined,
        touchAction: draggable ? undefined : 'auto',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        <span className={`uru-stamp ${stampClass}`} style={{ transform: 'rotate(-3deg)' }}>
          {mod.category}
        </span>
        {planned ? (
          <span className="uru-stamp" style={{ transform: 'rotate(3deg)', background: '#eee' }}>planned</span>
        ) : (
          <span className="uru-stamp uru-stamp-pink" style={{ transform: 'rotate(3deg)' }}>v{mod.version}</span>
        )}
        {blocked && !planned && (
          <span className="uru-stamp" style={{ transform: 'rotate(-2deg)', background: 'var(--pink-warm)', border: '1.5px solid var(--pink-hot)', color: 'var(--anchor)' }}>
            × incompatible
          </span>
        )}
      </div>
      <div className="uru-h2" style={{ fontSize: 14 }}>{mod.label}</div>
      <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--anchor-soft)', marginTop: 4 }}>{mod.description}</div>
      {!blocked && !planned && bundleWith.length > 0 && (
        <div style={{ marginTop: 4, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--pink-hot)' }}>
          + auto-adds {bundleWith.join(', ')}
        </div>
      )}
      {blocked && !planned && (
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10,
            color: 'var(--pink-hot)',
          }}
        >
          ~~ {blockedReason}
        </div>
      )}
      {!planned && (
        // Blocked tiles keep a button too — clicking it doesn't add the module
        // but DOES fire the reject-stamp popup in addModule() so the user gets
        // loud feedback instead of a silent dead tile. Non-draggable non-blocked
        // (draggable=false) stays hidden to keep the shelf tidy.
        !disabled ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onQuickAdd(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="uru-btn uru-btn-mint"
            style={{ width: '100%', marginTop: 8, justifyContent: 'center', fontSize: 11, padding: '4px 8px' }}
          >
            <span className="uru-arrow">→</span> add to basket
          </button>
        ) : blocked && draggable !== false ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onQuickAdd(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="uru-btn"
            style={{
              width: '100%',
              marginTop: 8,
              justifyContent: 'center',
              fontSize: 11,
              padding: '4px 8px',
              background: 'var(--pink-warm)',
              color: 'var(--anchor-soft)',
              cursor: 'not-allowed',
              opacity: 0.75,
            }}
            title={blockedReason}
          >
            ✗ blocked ~~
          </button>
        ) : null
      )}
    </div>
  );
}

function CartDropZone({
  selectedModules, moduleParams, onRemove, onParamsChange,
}: {
  selectedModules: string[];
  moduleParams: Record<string, Record<string, unknown>>;
  onRemove: (id: string) => void;
  onParamsChange: (id: string, v: Record<string, unknown>) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: 'cart' });
  return (
    <div ref={setNodeRef} className="uru-cart" data-active={isOver}>
      <div className="flex items-center justify-between mb-3">
        <div className="uru-eyebrow">✿ ur basket</div>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          {selectedModules.length} thing{selectedModules.length === 1 ? '' : 's'}
        </span>
      </div>
      {selectedModules.length === 0 ? (
        <div style={{ padding: 18, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
            drop stuff here ~~<br />
            <span style={{ fontSize: 20 }}>(っ˘ ˘)っ ✿</span>
          </div>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {selectedModules.map((id, i) => {
            const mod = moduleById(id);
            if (!mod) return null;
            const tilt = TILTS[(i + 4) % TILTS.length]!;
            return (
              <li key={id}>
                <CartItem mod={mod} params={moduleParams[id] ?? {}} tilt={tilt} onRemove={() => onRemove(id)} onParamsChange={(v) => onParamsChange(id, v)} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CartItem({
  mod, params, tilt, onRemove, onParamsChange,
}: {
  mod: ModuleSpec;
  params: Record<string, unknown>;
  tilt: 'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2';
  onRemove: () => void;
  onParamsChange: (v: Record<string, unknown>) => void;
}) {
  return (
    <div className="uru-polaroid uru-pop" data-tilt={tilt} style={{ padding: '8px 8px 14px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div className="uru-h2" style={{ fontSize: 12 }}>✿ {mod.label}</div>
        <button
          type="button"
          onClick={onRemove}
          style={{ background: 'transparent', border: 'none', color: 'var(--anchor)', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}
          aria-label="remove"
        >✕</button>
      </div>
      {mod.params.length > 0 && (
        <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
          {mod.params.map((p) => {
            const v = params[p.key];
            // 'percent' → number input w/ % suffix. 'eth' → text input w/ ETH suffix (decimals ok).
            // Everything else keeps its old behavior.
            const isNumberInput = p.type === 'integer' || p.type === 'percent';
            const inputType = isNumberInput ? 'number' : 'text';
            const suffix =
              p.type === 'percent' ? '%'
              : p.type === 'eth' ? 'ETH'
              : p.type === 'address' ? undefined
              : undefined;

            let missing = false;
            if (p.type === 'address') missing = typeof v !== 'string' || !isAddress(v);
            else if (p.type === 'string') missing = typeof v !== 'string' || v.length === 0;
            else if (p.type === 'integer' || p.type === 'percent') missing = v === undefined || v === null || v === '' || !Number.isFinite(Number(v));
            else if (p.type === 'eth') {
              missing = typeof v !== 'string' || v.trim().length === 0;
              if (!missing) { try { parseUnits(v as string, 18); } catch { missing = true; } }
            }

            const rangeHint =
              p.type === 'percent' && p.min !== undefined && p.max !== undefined
                ? ` ${p.min}–${p.max}%`
                : p.type === 'integer' && p.min !== undefined && p.max !== undefined
                  ? ` [${p.min}–${p.max}]`
                  : '';

            return (
              <label key={p.key} style={{ display: 'block' }}>
                <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)' }}>
                  {p.label}
                  {rangeHint && <span>{rangeHint}</span>}
                </span>
                <div style={{ position: 'relative' }}>
                  <input
                    className="uru-input"
                    type={inputType}
                    step={p.type === 'percent' ? (p.step ?? 0.01) : p.type === 'eth' ? 'any' : undefined}
                    inputMode={p.type === 'eth' ? 'decimal' : undefined}
                    value={(v as string | number | undefined) ?? ''}
                    placeholder={p.type === 'address' ? '0x…' : p.type === 'eth' ? '0.0' : undefined}
                    onChange={(e) => onParamsChange({
                      ...params,
                      [p.key]: p.type === 'integer' || p.type === 'percent'
                        ? (e.target.value === '' ? '' : Number(e.target.value))
                        : e.target.value,
                    })}
                    style={{
                      ...(missing ? { borderColor: 'var(--pink-hot)' } : undefined),
                      ...(suffix ? { paddingRight: 34 } : undefined),
                    }}
                  />
                  {suffix && (
                    <span
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 10,
                        color: 'var(--anchor-soft)',
                        pointerEvents: 'none',
                      }}
                    >
                      {suffix}
                    </span>
                  )}
                </div>
                {p.description && (
                  <div style={{ marginTop: 2, fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 10, color: 'var(--anchor-soft)', lineHeight: 1.35 }}>
                    {p.description}
                  </div>
                )}
                {missing && (
                  <div style={{ marginTop: 2, fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--pink-hot)' }}>
                    ~~ fill this before launch
                  </div>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>{children}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>{label}</span>
      <div style={{ marginTop: 3 }}>{children}</div>
    </label>
  );
}

function NameStatus({ data, isFetching, enabled }: { data: unknown; isFetching: boolean; enabled: boolean }) {
  if (!enabled) return null;
  let msg = '';
  let color = 'var(--anchor-soft)';
  if (isFetching) msg = 'checking..';
  else if (data === true) { msg = 'available ✿'; color = 'var(--anchor)'; }
  else if (data === false) { msg = 'taken ~~ try another'; color = 'var(--pink-hot)'; }
  else return null;
  return <div style={{ marginTop: 3, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color }}>{msg}</div>;
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
