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
  parseEther,
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
import { curveFactoryAbi, erc20FactoryAbi, erc20TokenAbi, nameRegistryAbi, routerAbi, v4StateViewAbi } from '@/lib/abis';
import { CHAIN_LABELS, CONTRACTS, COMPILE_SERVICE_URL, URU_PAY, V4_STATE_VIEWS } from '@/lib/config';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID, explorerAddressUrl, explorerTxUrl } from '@/lib/wagmi';
import { useMockDataMode } from '@/lib/mockDataMode';
import {
  BASE_TYPE_TO_UINT,
  configHashFor,
  shippedModulesForBase,
  moduleById,
  type BaseType,
  type ModuleSpec,
} from '@/lib/modules';
import { encodeModuleSlice } from '@/components/ModulePicker';
import { persistMetadata, readFileAsDataUrl, safeBackgroundImage, saveMetadata, type TokenMetadata } from '@/lib/metadata';
import { saveTokenMetadata } from '@/lib/socialApi';
import { saveMockLaunch } from '@/lib/mockLaunches';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { useLoyaltyDiscountReady } from '@/hooks/useLoyaltyDiscountReady';
import styles from './create-studio.module.css';

type OwnershipMode = 'Renounce' | 'TransferToMultisig' | 'KeepEOA';
const OWNERSHIP_TO_UINT: Record<OwnershipMode, 0 | 1 | 2> = {
  Renounce: 0,
  TransferToMultisig: 1,
  KeepEOA: 2,
};

// Prime rotations — never multiples of 5 per SKILL.md §rotation
const TILTS: Array<'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2'> = [
  'n7', 'p3', 'n4', 'p11', 'p2', 'n11', 'p13', 'n2',
];
const ALWAYS_ON_HOOKS = new Set(['LPLocked', 'FeeRedirect', 'MultiHookHost']);
const PER_LAUNCH_HOOKS = new Set(['AntiSniper', 'BuybackBurn']);

export default function CreatePage() {
  if (!LAUNCHPAD_LIVE) {
    return <NotLiveYet />;
  }
  return <CreatePageContent />;
}

function CreatePageContent() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  // Wagmi + useActiveChain flip after client-side hydration (isConnected false → true,
  // chainId 1 → wallet's real chain). Any banner that keys off those values will
  // hydration-mismatch unless we gate its first render behind `mounted`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const mockData = useMockDataMode();
  const [mockLaunchedAddress, setMockLaunchedAddress] = useState<Address | null>(null);

  // The user's PICKED chain (from the header switcher) is the launch target — not the
  // wallet's current chain. When the wallet is on a different chain than the pick, we
  // surface a "switch to X" nudge before the launch button works.
  const targetChain = useActiveChain();
  const walletChain = CHAIN_ID_TO_KEY[chainId] ?? null;
  const isOnEnabledChain = walletChain === targetChain;
  const contracts = CONTRACTS[targetChain];
  const activeChain = targetChain; // legacy alias — every downstream ref stays valid

  // The launch type is fixed while ERC-20 is the only available offering. Keeping
  // the invariant in code avoids presenting a non-choice to creators; the lower
  // factory branches remain until the NFT launch work is actually reintroduced.
  const base = useMemo<BaseType>(() => 'ERC20', []);
  // Two launch mechanics for ERC-20:
  //   'quick'  — pump.fun style, safe defaults baked in (renounce, LP lock,
  //              anti-sniper, no modules). Only inputs are name/ticker/vibes
  //              + optional whitelist. Was previously "direct launch" but that
  //              flow (mint-to-wallet, no curve, add LP yourself) proved
  //              unsafe — no way to guarantee LP-lock or block dump vectors
  //              without taking the launcher's discretion away.
  //   'custom' — today's shop UX: full module shelf, ownership picker,
  //              per-launch hook params. Renamed from "bonding-curve".
  // NFT bases (ERC721A, ERC1155) don't get a mechanic choice — they can't be
  // curved and always render the shelf + ownership flow.
  const [mechanic, setMechanic] = useState<'quick' | 'custom'>('quick');
  const mechanicOnMount = useRef<'quick' | 'custom'>('quick');
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
  // Atomic first-buy at launch — deployer takes the very first curve trade so
  // no mempool bot can front-run them. Empty string = disabled (plain launch).
  // Parsed to bigint at simulate time via parseEther; a bad string just leaves
  // initialBuyEthWei === 0n and the flow falls back to plain launch.
  const [initialBuyEthInput, setInitialBuyEthInput] = useState('');
  const [metadata, setMetadata] = useState<TokenMetadata>({ savedAt: 0 });
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoNotice, setLogoNotice] = useState<string | null>(null);
  const [dragMod, setDragMod] = useState<ModuleSpec | null>(null);
  // Center-of-screen reject-stamp shown when the user tries to add a blocked
  // module (already in basket, wont-stack, curve-mode owner-block, etc.). The
  // sidebar tile also greys out but that's easy to miss; the popup is loud.
  const [rejectStamp, setRejectStamp] = useState<{ modLabel: string; reason: string; key: number } | null>(null);
  const rejectClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Records the modules added by the LAST addModule call so the "combo not shipped"
  // useEffect can roll them back if the resulting configHash has no registered impl.
  // Without this, an incompatible module lands in the cart, the popup fires, the user
  // dismisses it, and the offending selection silently persists — exactly the bug the
  // popup was supposed to prevent.
  const lastAddedRef = useRef<string[] | null>(null);

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
    setLogoNotice(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLogoError('pls pick an image file ~~');
      return;
    }
    try {
      const result = await readFileAsDataUrl(file);
      setMetadata((prev) => ({ ...prev, logoDataUrl: result.dataUrl }));
      if (result.optimized) {
        setLogoNotice(
          `optimized ${Math.ceil(result.originalBytes / 1024)}KB → ${Math.ceil(result.outputBytes / 1024)}KB for launch ~`,
        );
      }
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
  const available = useMemo(
    () =>
      shippedModulesForBase(base).filter((m) => {
        if (m.category !== 'hook') return true;
        if (ALWAYS_ON_HOOKS.has(m.id)) return false;
        if (PER_LAUNCH_HOOKS.has(m.id)) return mechanic === 'custom';
        return false;
      }),
    [base, mechanic],
  );

  // Keep the relationship as data, rather than only a sentence on a disabled
  // shelf tile. A selected module can block a candidate from either side of an
  // incompatibility declaration, and one candidate may be blocked by several
  // selected modules at once.
  const conflictBlockers = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const mod of available) {
      if (selectedModules.includes(mod.id)) continue;
      map[mod.id] = selectedModules.filter((selectedId) => {
        const selected = moduleById(selectedId);
        return !!selected && (
          selected.incompatibleWith.includes(mod.id)
          || mod.incompatibleWith.includes(selectedId)
        );
      });
    }
    return map;
  }, [available, selectedModules]);

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
      const blockers = conflictBlockers[mod.id] ?? [];
      if (blockers.length > 0) {
        map[mod.id] = `blocked by ${blockers.map(labelOf).join(' + ')}`;
        continue;
      }
      // Curve mechanic auto-renounces ownership (Router forces OwnershipMode.Renounce
      // when installBondingCurve is true — see create page's launch payload). That
      // means every `onlyOwner` function on the token becomes dead after launch.
      // Modules whose whole point is a post-launch owner action would silently
      // ship broken. Grey them out here + surface the reason in the shelf tile.
      // `useCurve` is declared further down — recompute inline to avoid TDZ.
      const curveModeOn = mechanic === 'custom' && base === 'ERC20';
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
  }, [available, selectedModules, conflictBlockers, mechanic, base]);

  /// Selected modules that would silently break on curve mechanic:
  ///   - `requiresOwner`: admin functions dead (curve auto-renounces)
  ///   - `taxesTransfers`: FoT would tax curve trades + break graduation
  /// Surfaced as a top-of-cart warning + used to block the launch button so
  /// users don't ship a token whose modules don't work with their mechanic.
  const ownerlessDeadModules = useMemo(() => {
    const curveModeOn = mechanic === 'custom' && base === 'ERC20';
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
      // Stays until user dismisses via backdrop click — no auto-clear. Popup
      // is loud enough that a soft 3s window felt too quick to read on first
      // encounter.
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

    // Record what THIS call adds so the combo-not-shipped useEffect can pop it back
    // if the resulting configHash isn't registered on-chain. Only the newly-added ids
    // get rolled back — modules the user chose earlier stay put.
    lastAddedRef.current = Array.from(toAdd);
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
    // A dependency is added automatically with the module that needs it. If the
    // creator removes that dependency later, remove dependent selections too so
    // the cart can never be left in an invalid, launch-blocking state.
    const toRemove = new Set<string>([id]);
    let foundDependent = true;
    while (foundDependent) {
      foundDependent = false;
      for (const selectedId of selectedModules) {
        const selected = moduleById(selectedId);
        if (selected && !toRemove.has(selectedId) && selected.requires.some((required) => toRemove.has(required))) {
          toRemove.add(selectedId);
          foundDependent = true;
        }
      }
    }

    setSelectedModules((prev) => prev.filter((selectedId) => !toRemove.has(selectedId)));
    setModuleParams((prev) => {
      const next = { ...prev };
      for (const removedId of toRemove) delete next[removedId];
      return next;
    });
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

  // Both mechanics ('quick' and 'custom') use a bonding curve for ERC-20 launches
  // — the difference is UX (baked defaults vs full module shelf), not stack.
  // NFT bases still take the mint-to-wallet path because our BondingCurve is
  // ERC-20 only (v4 pools can't trade non-fungible balances).
  const curveDefaultSupplyQuery = useReadContract({
    abi: curveFactoryAbi,
    address: contracts?.CurveFactory,
    functionName: 'defaultCurveSupply',
    query: { enabled: !!contracts && base === 'ERC20', staleTime: 60_000 },
  });
  const curveSupplyWei = (curveDefaultSupplyQuery.data as bigint | undefined) ?? 800_000_000n * 10n ** 18n;
  const useCurve = base === 'ERC20';
  /// Quick-launch defaults, evaluated once. Sniper gate hardcoded to 5 L1
  /// blocks (~60 sec on RH — one Ethereum block cadence); buyback-burn is
  /// intentionally 0 per product decision (users can still opt in via
  /// customizable curve).
  const QUICK_ANTI_SNIPER_BLOCKS = 5;
  /// L1 block cadence used to translate the launcher's seconds input into
  /// the blocks-based `params.antiSniperBlocks` the MHH gate uses. RH is on
  /// Arbitrum stack: `block.number` inside a contract returns the L1 block
  /// number, not the L2 fast block. Verified 2026-08-09 across ~275 blocks.
  const SEC_PER_L1_BLOCK = 12;
  const isQuick = mechanic === 'quick' && base === 'ERC20';

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
  //
  // Unit conversion: the UI accepts SECONDS (what a launcher understands) but the
  // MHH gate compares against `block.number`, which on Robinhood (an Arbitrum-stack
  // chain) returns the Ethereum L1 block number — ~12 sec cadence, verified
  // empirically. Convert seconds → blocks by ceil(seconds / SEC_PER_L1_BLOCK).
  const antiSniperBlocks = useMemo<number>(() => {
    if (!useCurve) return 0;
    if (isQuick) return QUICK_ANTI_SNIPER_BLOCKS;
    if (!selectedModules.includes('AntiSniper')) return 0;
    const raw = moduleParams['AntiSniper']?.gateBlocks;
    const seconds = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.ceil(seconds / SEC_PER_L1_BLOCK);
  }, [useCurve, isQuick, selectedModules, moduleParams]);

  const buybackBurnBps = useMemo<number>(() => {
    if (!useCurve || isQuick) return 0; // Quick mode intentionally skips buyback-burn (per product spec)
    if (!selectedModules.includes('BuybackBurn')) return 0;
    const raw = moduleParams['BuybackBurn']?.burnBps;
    const pct = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    // percent → bps, capped at MAX_BUYBACK_BPS = 2000 (matches MultiHookHost).
    return Math.min(2000, Math.floor(pct * 100));
  }, [useCurve, isQuick, selectedModules, moduleParams]);

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
  // Layer-3 release gate — the receipt "loyalty discount: -N%" line only
  // renders when the on-chain loyalty wiring is verified live. The router
  // still charges the discounted quote either way (quoteFor is what we
  // pay and simulate against), so degrading here is purely a copy safety
  // measure: we never advertise a specific % that isn't backed by live
  // read. If ready is false the receipt falls back to the plain net
  // total with no strikethrough / no callout — same UX as an unconnected
  // wallet or a chain without loyalty wiring.
  const loyaltyReady = useLoyaltyDiscountReady();

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

  // ---- URU pay path (Robinhood only) ---------------------------------------
  // Users can choose URU or ETH to pay the launch fee. When URU is picked the frontend
  // quotes the URU-equivalent of the ETH fee via a spot-price read on the URU/WETH v4
  // pool, and the launch call switches to `RouterV2.launchWithURU(params, uruAmount)`.
  // Only offered on chains where URU_PAY is populated + RouterV2 is deployed (RH today).
  const uruPay = URU_PAY[targetChain];
  const stateView = V4_STATE_VIEWS[targetChain];
  const [payToken, setPayToken] = useState<'ETH' | 'URU'>('ETH');
  // Force ETH when URU isn't wired for the target chain — avoids stale URU-picked state
  // surviving a chain switch back to a non-RH chain.
  useEffect(() => {
    if (!uruPay && payToken === 'URU') setPayToken('ETH');
  }, [uruPay, payToken]);

  const slot0 = useReadContract({
    abi: v4StateViewAbi,
    address: stateView ?? undefined,
    functionName: 'getSlot0',
    args: uruPay ? [uruPay.poolId] : undefined,
    query: { enabled: !!uruPay && !!stateView && payToken === 'URU', refetchInterval: 12_000 },
  });

  /// Convert `ethFeeWei` to a URU amount (in URU wei — URU has 18 decimals).
  /// v4 stores `sqrtPriceX96` as Q64.96 of √(currency1/currency0). If URU is
  /// currency1 (typical on RH — WETH `0x0Bd7…` sorts lower than URU `0x9fbe…`)
  /// then price = URU per WETH and `uruOut = ethIn * sqrtPriceX96² / 2¹⁹²`.
  /// If URU is currency0 the ratio inverts. Returns undefined until slot0 lands.
  // On-chain URU floor - RouterV2 V4 rejects launches below this even if the
  // spot-quoted amount is lower. Frontend must respect it or the launch tx
  // reverts with RouterV2__InsufficientUru after the user's already paid gas.
  const minUruFeeForUser = useReadContract({
    abi: routerAbi,
    address: contracts?.Router as Address | undefined,
    functionName: 'minUruFeeFor',
    args: address ? [address] : undefined,
    query: { enabled: !!uruPay && !!address && !!contracts?.Router && payToken === 'URU' },
  });

  const uruAmount = useMemo<bigint | undefined>(() => {
    if (!uruPay || !slot0.data) return undefined;
    const fee = quote.data as bigint | undefined;
    if (typeof fee !== 'bigint' || fee === 0n) return undefined;
    const sqrtPriceX96 = (slot0.data as readonly [bigint, number, number, number])[0];
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return undefined;
    const Q192 = 1n << 192n;
    const priceX192 = sqrtPriceX96 * sqrtPriceX96; // URU / WETH scaled by 2¹⁹²
    const spotAmount = uruPay.uruIsCurrency1
      ? (fee * priceX192) / Q192
      : (fee * Q192) / priceX192;
    // Bump to the on-chain floor if the spot quote falls below it. Users paying
    // in URU get either the discounted floor (loyalty applied by minUruFeeFor)
    // or the spot-quoted amount, whichever is HIGHER. This mirrors the router's
    // `uruAmount < required` gate.
    const floor = minUruFeeForUser.data as bigint | undefined;
    if (typeof floor === 'bigint' && floor > spotAmount) return floor;
    return spotAmount;
  }, [uruPay, slot0.data, quote.data, minUruFeeForUser.data]);

  // URU amounts run to 18 decimals — full string overflows the receipt box.
  // Trim to 4 decimals + strip trailing zeros for display; underlying bigint stays exact.
  const fmtCompact = (wei: bigint): string => {
    const s = formatEther(wei);
    const [int, frac = ''] = s.split('.');
    if (!frac) return int as string;
    const trimmed = frac.slice(0, 4).replace(/0+$/, '');
    return trimmed ? `${int}.${trimmed}` : (int as string);
  };

  const uruAllowance = useReadContract({
    abi: erc20TokenAbi,
    address: uruPay?.token,
    functionName: 'allowance',
    args: address && contracts?.Router ? [address, contracts.Router] : undefined,
    query: { enabled: !!uruPay && !!address && !!contracts?.Router && payToken === 'URU' },
  });
  const needsUruApprove = useMemo(() => {
    if (payToken !== 'URU') return false;
    if (typeof uruAmount !== 'bigint') return true;
    const allowed = (uruAllowance.data as bigint | undefined) ?? 0n;
    return allowed < uruAmount;
  }, [payToken, uruAmount, uruAllowance.data]);
  // -------------------------------------------------------------------------

  // ---- Community whitelist (optional, curve-only) --------------------------
  // Deployer pastes a source NFT/token address, clicks Apply → backend snapshots
  // holders + builds a Merkle root. WL config gets attached to the launch tx so
  // the resulting curve is initialized with the reserved slice already bound.
  // Hard-coded sensible defaults (25% reserved, 24h fallback, per-address cap =
  // reserved/5). Advanced knobs deferred to v2.
  const [wlSourceAddress, setWlSourceAddress] = useState<string>('');
  const [wlSnapshot, setWlSnapshot] = useState<{
    root: Hex;
    snapshotBlock: string;
    holderCount: number;
    listId: string;
    /// Present when the compile-service pinned the list to IPFS. Trade page reads
    /// this from token metadata to fetch the list + build proofs for eligible buyers.
    listCid?: string;
    /// WL-exclusive window end, captured when applyWhitelist ran (Date.now +1h).
    /// Frozen at apply time so useMemo below stays pure — reading Date.now in
    /// render trips react-hooks/purity in React 19.
    fallbackTs: bigint;
  } | null>(null);
  const [wlApplying, setWlApplying] = useState(false);
  const [wlError, setWlError] = useState<string | null>(null);
  const wlEnabled = wlSnapshot !== null;

  const applyWhitelist = async () => {
    setWlError(null);
    if (!isAddress(wlSourceAddress)) {
      setWlError('paste a valid contract address');
      return;
    }
    if (mockData.enabled) {
      setWlSnapshot({
        root: `0x${'d'.repeat(64)}` as Hex,
        snapshotBlock: 'demo',
        holderCount: 274,
        listId: 'demo-holder-snapshot',
        fallbackTs: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      });
      return;
    }
    setWlApplying(true);
    try {
      const chainId = CHAIN_KEY_TO_ID[targetChain];
      const res = await fetch(`${COMPILE_SERVICE_URL}/wl/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chainId, tokenAddress: wlSourceAddress }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || 'snapshot failed');
      }
      const data = await res.json();
      if (data.holderCount < 2) {
        throw new Error(`only ${data.holderCount} holders found — need at least 2 for a meaningful whitelist`);
      }
      setWlSnapshot({
        root: data.root,
        snapshotBlock: data.snapshotBlock,
        holderCount: data.holderCount,
        listId: data.listId,
        listCid: data.listCid,
        // Capture "now + 1h" at apply time — event handler, safe to call Date.now.
        // useMemo below reads from state so render stays pure.
        fallbackTs: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      });
    } catch (e) {
      setWlError(e instanceof Error ? e.message : String(e));
      setWlSnapshot(null);
    } finally {
      setWlApplying(false);
    }
  };
  const clearWhitelist = () => {
    setWlSnapshot(null);
    setWlSourceAddress('');
    setWlError(null);
  };

  // Build the WL struct passed to launchWithWhitelist. Time-gated design defaults:
  //   - 60% of curve supply reserved for WL (majority share vs. 40% public)
  //   - Per-address cap = reserved / 5 (top 5 wallets could fill it)
  //   - 1h WL-exclusive window (public buy() locked until then; WL uses buyWithProof)
  //
  // fallbackTs is captured at applyWhitelist time (see setWlSnapshot above) so this
  // useMemo stays pure — React 19's react-hooks/purity rule forbids Date.now() in
  // render, which is where a useMemo body runs.
  const wlStruct = useMemo(() => {
    if (!wlSnapshot || !useCurve) return null;
    const reservedTokens = (curveSupplyWei * 6000n) / 10_000n;
    const maxPerAddr = reservedTokens / 5n;
    return {
      root: wlSnapshot.root,
      reservedTokens,
      maxWlPerAddress: maxPerAddr,
      fallbackTs: wlSnapshot.fallbackTs,
      sourceTokenAddress: wlSourceAddress as Address,
      sourceChainId: CHAIN_KEY_TO_ID[targetChain],
      declaredHolderCount: wlSnapshot.holderCount,
    };
  }, [wlSnapshot, useCurve, curveSupplyWei, wlSourceAddress, targetChain]);
  // -------------------------------------------------------------------------

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
    if (implRegistered) {
      // Registered combos are good — clear the "last added" marker so a later
      // rejected combo doesn't retro-pop a since-approved selection.
      lastAddedRef.current = null;
      return;
    }
    // What modules got combined into the unregistered hash? Show all of them
    // in the popup so the user knows exactly which selection tripped it.
    const label = selectedModules.map((id) => moduleById(id)?.label ?? id).join(' + ');
    setRejectStamp((prev) => ({
      modLabel: label,
      reason: 'this combo isn\'t shipped yet — try fewer modules or a different mix',
      key: (prev?.key ?? 0) + 1,
    }));
    if (rejectClearRef.current) clearTimeout(rejectClearRef.current);
    // No auto-clear — user dismisses via backdrop click.
    playSfx('stamp');
    // Roll back JUST the modules added by the most recent addModule call. Modules
    // the user picked earlier stay put — the cart returns to its last-known-good
    // state. Popup stays visible so they know why.
    const toRevert = lastAddedRef.current;
    lastAddedRef.current = null;
    if (toRevert && toRevert.length > 0) {
      setSelectedModules((prev) => prev.filter((m) => !toRevert.includes(m)));
      setModuleParams((prev) => {
        const next = { ...prev };
        for (const id of toRevert) delete next[id];
        return next;
      });
    }
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

  function mkMockAddress(): Address {
    const seed = `${name}|${ticker}|${address ?? zeroAddress}|${CHAIN_KEY_TO_ID[targetChain] ?? chainId}`;
    let hash = 0x9e3779b9;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= (hash << 5) + (hash >> 2) + seed.charCodeAt(i);
    }
    const suffix = Math.abs(hash >>> 0).toString(16).padStart(8, '0').slice(-8);
    const stamped = `${Date.now().toString(16).slice(-4)}${suffix}`;
    const mockAddress = `0xbeadface${stamped}`.padEnd(42, '0').slice(0, 42);
    return mockAddress as Address;
  }

  const canLaunchLive =
    !!contracts && isConnected && isOnEnabledChain &&
    (nameQuery.data ?? false) && (tickerQuery.data ?? false) &&
    multisigValid && moduleParamsFilled && !!implRegistered && typeof quote.data === 'bigint'
    // Prevent shipping a token that would have dead owner-only functions. If the
    // basket has any requiresOwner module while curve mechanic is on, the launch
    // would silently install those admin functions with owner=address(0) at
    // graduation — pause() etc. would revert forever. Force the user to remove
    // one or the other before the button unlocks.
    && ownerlessDeadModules.length === 0
    // URU path additionally requires a resolved uruAmount (slot0 landed) + enough
    // allowance already approved. The approve button unlocks first, then launch.
    && (payToken === 'ETH' || (typeof uruAmount === 'bigint' && !needsUruApprove));

  // Parse the initial-buy input to a bigint. Only meaningful on the plain
  // ETH-paid non-WL curve launch — the URU + WL variants don't have a
  // *_AndBuy Router entrypoint (would need Router redeploy to add), so
  // gate the whole feature behind that combo.
  const initialBuyEthWei = useMemo<bigint>(() => {
    if (!useCurve || payToken !== 'ETH' || wlStruct) return 0n;
    const trimmed = initialBuyEthInput.trim();
    if (!trimmed) return 0n;
    try {
      const v = parseEther(trimmed);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [initialBuyEthInput, useCurve, payToken, wlStruct]);
  const initialBuyEnabled = initialBuyEthWei > 0n;

  // Simulate branches over the pay token, the WL flag, AND (for plain ETH
  // curve launches) whether the user asked for an atomic first buy. Five
  // possible entrypoints today: launch, launchAndBuy, launchWithURU,
  // launchWithWhitelist, launchWithURUAndWhitelist. Args + value assembled
  // below to match each.
  const simulateFn:
    | 'launch'
    | 'launchAndBuy'
    | 'launchWithURU'
    | 'launchWithWhitelist'
    | 'launchWithURUAndWhitelist' = wlStruct
    ? payToken === 'URU'
      ? 'launchWithURUAndWhitelist'
      : 'launchWithWhitelist'
    : payToken === 'URU'
      ? 'launchWithURU'
      : initialBuyEnabled
        ? 'launchAndBuy'
        : 'launch';
  const simulateArgs = (() => {
    const uAmt = typeof uruAmount === 'bigint' ? uruAmount : 0n;
    if (wlStruct && payToken === 'URU') return [params, uAmt, wlStruct] as const;
    if (wlStruct) return [params, wlStruct] as const;
    if (payToken === 'URU') return [params, uAmt] as const;
    if (initialBuyEnabled && address) {
      // minTokensOut = 0 because launch + first buy are atomic — no other
      // trade can wedge in between to shift the curve pricing. Slippage
      // only matters relative to other in-flight trades. Recipient is the
      // launcher's own wallet so they hold the initial position directly.
      return [params, initialBuyEthWei, 0n, address] as const;
    }
    return [params] as const;
  })();

  function launchMockToken() {
    if (!canLaunchMock) return;
    const launchChainId = CHAIN_KEY_TO_ID[targetChain] ?? chainId;
    const tokenAddress = mkMockAddress();
    const saved = saveMockLaunch({
      chainId: launchChainId,
      address: tokenAddress,
      name: name.trim(),
      ticker: ticker.trim(),
      creator: (address ?? zeroAddress) as Address,
      description: metadata.description ?? undefined,
      logoEmoji: '✿',
      logoBg: '#ffb3d1',
      imageUrl: metadata.logoDataUrl,
      website: metadata.website,
      twitter: metadata.twitter,
      telegram: metadata.telegram,
      targetEthRaised: '1',
      numTrades: 12,
      launchedAtHoursAgo: 1,
      kind: 'curve',
      tradeFeeBps: 100,
      graduated: false,
      hasWhitelist: wlEnabled,
    });
    saveMetadata(launchChainId, saved.address, {
      ...metadata,
      description: metadata.description,
      website: metadata.website,
      twitter: metadata.twitter,
      telegram: metadata.telegram,
      discord: metadata.discord,
      tiktok: metadata.tiktok,
    });
    setMockLaunchedAddress(saved.address);
  }

  const simulate = useSimulateContract({
    abi: routerAbi,
    address: contracts?.Router,
    functionName: simulateFn,
    // wagmi's typed args don't unify across five different function shapes — the
    // cast is safe because we branch on simulateFn to match args to signature.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: simulateArgs as any,
    value:
      payToken === 'URU'
        ? 0n
        : ((quote.data as bigint | undefined) ?? 0n) + initialBuyEthWei,
    account: address,
    query: { enabled: canLaunchLive },
  });

  // Separate simulate for the URU approve — same wagmi wrapper the launch button uses.
  const approveSimulate = useSimulateContract({
    abi: erc20TokenAbi,
    address: uruPay?.token,
    functionName: 'approve',
    args: contracts?.Router && typeof uruAmount === 'bigint' ? [contracts.Router, uruAmount] : undefined,
    account: address,
    query: { enabled: payToken === 'URU' && needsUruApprove && !!contracts?.Router && typeof uruAmount === 'bigint' },
  });

  const { writeContract, isPending: launchPending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const canLaunchMock = useMemo(
    () =>
      mounted &&
      mockData.enabled &&
      name.trim().length >= 2 &&
      ticker.trim().length >= 2 &&
      multisigValid &&
      moduleParamsFilled &&
      ownerlessDeadModules.length === 0 &&
      !launchPending &&
      !receipt.isLoading,
    [mounted, mockData.enabled, name, ticker, multisigValid, moduleParamsFilled, ownerlessDeadModules.length, launchPending, receipt.isLoading],
  );

  // Refetch URU allowance every time a tx confirms while on the URU path. Covers the
  // approve → launch handoff (approve confirms → allowance refetches → button flips
  // from "approve URU" to "✿ launch ✿"). Without this the button stays stuck on
  // approve until wagmi's stale-time expires.
  useEffect(() => {
    if (payToken === 'URU' && receipt.data) uruAllowance.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.data, payToken]);

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
  const displayedLaunchAddress = mockData.enabled ? mockLaunchedAddress : launchedTokenAddress;

  // useRef, not useMemo — React 19 compiler treats memoized values as immutable; mutable
  // "did this happen already" flags belong in a ref. Refs also don't trigger re-renders.
  const savedRef = useRef(false);
  const { signMessageAsync } = useSignMessage();
  if (!mockData.enabled && launchedTokenAddress && !savedRef.current) {
    const wlCid = wlSnapshot?.listCid;
    const hasAny =
      metadata.logoDataUrl || metadata.description || metadata.website || metadata.twitter || wlCid;
    if (hasAny) {
      savedRef.current = true;
      // Two-phase persist:
      //   1. persistMetadata — writes localStorage synchronously + kicks off Pinata pin (if
      //      NEXT_PUBLIC_PINATA_JWT is set). Returns the { cid, gatewayUrl } once pinned.
      //   2. saveTokenMetadata — POSTs the resulting gateway URL to compile-service so every
      //      other browser can render the image. Requires one wallet signature; if the user
      //      cancels, the local snapshot is still there so THEIR view is unaffected.
      // Merged with wlListCid when a whitelist was applied so the trade page can
      // fetch the pinned holder list + build proofs. Cross-device propagation of
      // wlListCid via the backend metadata endpoint is a v2 follow-up (needs a
      // schema addition); for now WL trades work on the deployer's browser +
      // any browser that visited the create flow.
      const metadataToSave = wlCid ? { ...metadata, wlListCid: wlCid } : metadata;
      void (async () => {
        const pinned = await persistMetadata(chainId, launchedTokenAddress, metadataToSave);
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
              // WL list CID lands here so any browser (not just the deployer's)
              // can fetch the pinned holder list + build proofs at trade time.
              wlListCid: wlCid ?? null,
            },
            ({ message }) => signMessageAsync({ message }),
          );
        } catch {
          // User cancelled signature or network hiccup — local persistence still succeeded.
        }
      })();
    }
  }

  const mascotMood = displayedLaunchAddress
    ? 'gasp'
    : selectedModules.length > 3
      ? 'gasp'
      : selectedModules.length === 0
        ? 'sleepy'
        : 'happy';
  const launchButtonLabel = launchPending
    ? 'confirming ~~'
    : receipt.isLoading
      ? 'waiting..'
      : mockData.enabled
        ? canLaunchMock
          ? 'create mock launch'
          : !mounted
            ? 'loading demo form'
            : !name.trim() || !ticker.trim()
                ? 'name + ticker first'
                : ownerlessDeadModules.length > 0
                  ? 'drop blocked modules'
                  : !multisigValid
                    ? 'fix owner address'
                    : !moduleParamsFilled
                      ? 'fill module params'
                      : 'launch blocked'
        : !mounted
          ? 'checking wallet'
          : !isConnected
            ? 'connect wallet to launch'
            : !contracts
              ? 'contracts not live'
              : !isOnEnabledChain
                ? `switch to ${CHAIN_LABELS[targetChain]}`
                : !name.trim() || !ticker.trim()
                  ? 'name + ticker first'
                  : ownerlessDeadModules.length > 0
                    ? 'drop blocked modules'
                    : !multisigValid
                      ? 'fix owner address'
                      : !moduleParamsFilled
                        ? 'fill module params'
                        : implRegistered
                          ? 'launch'
                          : 'impl not registered';

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {/* Center-of-screen reject stamp — fires when the user taps a blocked
          module. Rides the existing uru-pop keyframes for its entrance so it
          matches the paper/stamp aesthetic. Auto-dismisses in 2.6s (managed
          via rejectClearRef in addModule). Pointer-events off so the popup
          doesn't steal clicks. */}
      {rejectStamp && (
        <>
          {/* Dim backdrop — click anywhere to dismiss. Pointer-events on so it
              actually catches clicks; the popup body sits above it. */}
          <div
            role="button"
            aria-label="close notification"
            onClick={() => {
              if (rejectClearRef.current) clearTimeout(rejectClearRef.current);
              setRejectStamp(null);
            }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9998,
              background: 'rgba(58, 44, 58, 0.35)',
              backdropFilter: 'blur(2px)',
              cursor: 'pointer',
            }}
          />
          {/* Outer container handles centering — flexbox on a full-viewport
              overlay so nothing can knock it off-axis. The `uru-pop` entrance
              lives on the inner box because that keyframes rewrites `transform`
              at 100%, which would otherwise erase a translate(-50%, -50%). */}
          <div
            key={rejectStamp.key}
            aria-live="polite"
            role="status"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
          <div
            className="uru-pop"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              maxWidth: '92vw',
              width: 'min(520px, 92vw)',
            }}
          >
            {/* Urufu the wolf, confused. Sized big for center-screen presence. */}
            <div className="uru-idle-bob">
              <Mascot size={140} mood="confused" />
            </div>
            {/* Cream speech-bubble w/ tail pointing UP toward the wolf. Custom
                inline styling so the tail sits on top rather than the default
                left-side position from .uru-bubble. */}
            <div
              style={{
                position: 'relative',
                background: 'var(--cream)',
                border: '2.5px solid var(--anchor)',
                borderRadius: 16,
                padding: '22px 28px',
                boxShadow: '5px 5px 0 var(--anchor)',
                fontFamily: 'var(--font-round), "Klee One", cursive',
                textAlign: 'center',
                width: '100%',
                transform: 'rotate(-1deg)',
              }}
            >
              {/* Tail pointing up */}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -14,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: '12px solid transparent',
                  borderRight: '12px solid transparent',
                  borderBottom: '14px solid var(--anchor)',
                }}
              />
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -10,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: '9px solid transparent',
                  borderRight: '9px solid transparent',
                  borderBottom: '11px solid var(--cream)',
                }}
              />
              {/* Corner stamp — hand-placed */}
              <span
                className="uru-stamp uru-stamp-pink"
                style={{
                  position: 'absolute',
                  top: -18,
                  right: -14,
                  transform: 'rotate(11deg)',
                  fontSize: 12,
                  letterSpacing: 0.5,
                }}
              >
                ✗ nope~
              </span>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--anchor)', lineHeight: 1.2 }}>
                {rejectStamp.modLabel}
              </div>
              <div style={{ fontSize: 14, color: 'var(--anchor-soft)', marginTop: 10, fontStyle: 'italic', lineHeight: 1.4 }}>
                {rejectStamp.reason}
              </div>
              <div style={{ fontSize: 10, color: 'var(--anchor-soft)', marginTop: 14, opacity: 0.6 }}>
                (click anywhere to dismiss)
              </div>
            </div>
          </div>
          </div>
        </>
      )}
      {/* Top marquee lives in the root layout — see components/TokenTicker.tsx */}
      <div className={styles.studio}>
        {mounted && !contracts && (
          <div className="uru-shell uru-shell-tight mb-3" style={{ background: 'var(--yolk)' }}>
            <div className="flex items-start gap-3">
              <Mascot size={40} mood="confused" />
              <div>
                <div className="uru-h2" style={{ fontSize: 15 }}>oh no,, contracts arent live on this chain yet ~~</div>
                <div style={{ fontSize: 12, marginTop: 4, color: 'var(--anchor-soft)' }}>
                  u can browse everything, but launch stays disabled til Router deploy broadcasts and addresses
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

        {/* Small "launch with an agent" strip — alternative entry point for
            humans who'd rather let an AI walk them through it. Two buttons:
            copy the paste-ready prompt for their agent, or view the raw skill
            file. Kept small on purpose so it doesn't dominate the main flow. */}
        <AgentLaunchStrip />

        <div className={styles.workbench}>
          <nav className={styles.progressRail} aria-label="Create progress">
            <span className={styles.railLabel}>creation steps</span>
            <a href="#define-coin">
              <b>01</b>
              <span>token details</span>
            </a>
            <a href="#coin-media">
              <b>02</b>
              <span>artwork + links</span>
            </a>
            <a href="#contract-setup">
              <b>03</b>
              <span>contract</span>
            </a>
            <a href="#launch-review">
              <b>04</b>
              <span>launch</span>
            </a>
          </nav>

          {/* MAIN — the shop counter */}
          <div className={styles.mainStack}>
            {/* CUSTOMIZE — launch mechanic */}
            <section id="contract-setup" className={`${styles.contractPanel} uru-shell`}>
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>launch settings</div>
              <div className="uru-shell-inner">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => { if (base === 'ERC20') setMechanic('quick'); }}
                    title="Quick launch uses safe defaults: LP locked forever, ownership renounced, 1% fee, 10 ETH graduation target, 5-block sniper gate."
                    aria-label="quick launch, safe defaults"
                    className="uru-polaroid text-left"
                    style={{
                      background: mechanic === 'quick' ? 'var(--pink-warm)' : 'var(--paper-white, #fff)',
                      boxShadow: mechanic === 'quick' ? '4px 4px 0 var(--pink-hot)' : undefined,
                      color: '#3a2c3a',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="uru-h2" style={{ fontSize: 14, color: mechanic === 'quick' ? '#3a2c3a' : undefined }}>
                      quick launch
                      <span style={{ fontFamily: 'var(--font-jp), monospace', color: mechanic === 'quick' ? '#3a2c3a' : 'var(--anchor-soft)', fontSize: 12, marginLeft: 6 }}>速</span>
                    </div>
                    <div style={{ fontSize: 11, color: mechanic === 'quick' ? '#3a2c3a' : 'var(--anchor-soft)', marginTop: 4, lineHeight: 1.4 }}>
                      safe defaults. name, ticker, token details, launch.
                    </div>
                    {mechanic === 'quick' && base === 'ERC20' && (
                      <div style={{ marginTop: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: '#3a2c3a' }}>
                        800M supply · 1% fee · 10 ETH target · anti-sniper 60 sec
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (base === 'ERC20') setMechanic('custom'); }}
                    disabled={base !== 'ERC20'}
                    title="Customizable curve keeps the same curve launch but unlocks module picks, anti-sniper params, buyback-burn params, whitelist setup, and other knobs."
                    aria-label="customizable curve, modules, and hook settings"
                    className="uru-polaroid text-left"
                    style={{
                      background: mechanic === 'custom' ? 'var(--mint)' : 'var(--paper-white, #fff)',
                      boxShadow: mechanic === 'custom' ? '4px 4px 0 var(--anchor)' : undefined,
                      color: '#3a2c3a',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="uru-h2" style={{ fontSize: 14, color: mechanic === 'custom' ? '#3a2c3a' : undefined }}>
                      advanced curve
                      <span style={{ fontFamily: 'var(--font-jp), monospace', color: mechanic === 'custom' ? '#3a2c3a' : 'var(--anchor-soft)', fontSize: 12, marginLeft: 6 }}>曲線</span>
                    </div>
                    <div style={{ fontSize: 11, color: mechanic === 'custom' ? '#3a2c3a' : 'var(--anchor-soft)', marginTop: 4, lineHeight: 1.4 }}>
                      same curve, more settings. modules + hook parameters.
                    </div>
                    {mechanic === 'custom' && (
                      <div style={{ marginTop: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: '#3a2c3a' }}>
                        whitelist · sniper gate · buyback-burn
                      </div>
                    )}
                  </button>
                </div>
              </div>
            </section>

            {/* STEP 2 — shelf (hidden entirely in quick mode; quick mode ships
                with no modules by design). The whitelist toggle below stays
                visible in quick mode under a repositioned label, so the WL
                affordance isn't lost when the shelf goes away. */}
            <section className={`${styles.hooksPanel} uru-shell`}>
              <span className="uru-tape uru-tape-mint" style={{ width: 82, height: 16, top: -8, right: 30, transform: 'rotate(11deg)' }} />
              <div className="flex items-baseline justify-between mb-2">
                <div className="uru-eyebrow">
                  {isQuick ? 'whitelist (optional)' : 'advanced modules'}
                </div>
                {!isQuick && (
                  <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                    drag <span className="uru-arrow">→</span> or click add
                  </span>
                )}
              </div>

              <div className="uru-shell-inner">
                {!isQuick && (
                  <div className={styles.moduleShelf}>
                    {available.length === 0 && (
                      <div style={{ padding: 20, textAlign: 'center' }}>
                        <Mascot size={40} mood="sleepy" />
                        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--anchor-soft)' }}>
                          no modules available for this launch yet~~
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
                          blockingModuleIds={conflictBlockers[mod.id] ?? []}
                          bundleWith={bundleHints[mod.id] ?? []}
                          onQuickAdd={() => addModule(mod.id)}
                          draggable={!coarsePointer}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {!isQuick && base === 'ERC20' && mechanic === 'custom' && (
                  <div
                    title="Paste a source project contract. Holders get 60% of curve reserves during a 1-hour exclusive window; unfilled supply opens to public after that, and whitelist tokens stay locked until graduation."
                    style={{
                      marginTop: 12,
                      padding: 10,
                      background: 'var(--mint)',
                      color: '#3a2c3a',
                      border: '1.5px dashed var(--anchor)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      fontFamily: 'var(--font-round), Klee One, cursive',
                    }}
                  >
                    <b>on graduation</b>, ur curve auto-installs the platform hook:{' '}
                    <b>LP locked forever</b> on Uniswap v4 + <b>1% creator fee</b> on every
                    swap (claim it anytime from ur profile). optional modules:{' '}
                    <b>sniper gate</b> + <b>buy → burn</b> — get wired into the same pool at
                    graduation using the params u picked ~
                  </div>
                )}

                {/* Community whitelist — optional, curve-only. Paste any project's
                    source project address, click apply, backend snapshots
                    holders + returns a Merkle root that gets attached to the launch. */}
                {useCurve && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 12,
                      background: 'var(--cream-deep)',
                      border: '1.5px solid var(--anchor)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      fontFamily: 'var(--font-round), Klee One, cursive',
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 11 }}>
                      ✿ community whitelist (optional)
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--anchor-soft)', marginBottom: 8 }}>
                      60% holder reserve · 1h exclusive window.
                    </div>
                    {!wlEnabled && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          className="uru-input"
                          value={wlSourceAddress}
                          onChange={(e) => setWlSourceAddress(e.target.value)}
                          placeholder="0x… source project address"
                          disabled={wlApplying}
                          style={{ flex: 1, fontFamily: 'var(--font-mono), monospace', fontSize: 11 }}
                        />
                        <button
                          type="button"
                          className="uru-btn"
                          onClick={applyWhitelist}
                          disabled={wlApplying || wlSourceAddress.length === 0}
                          style={{ fontSize: 11, padding: '5px 10px' }}
                        >
                          {wlApplying ? 'snapshotting..' : 'apply'}
                        </button>
                      </div>
                    )}
                    {wlEnabled && wlSnapshot && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: 'var(--mint-hot,#2b8a3e)', fontWeight: 700 }}>
                          ✓ WL ready — {wlSnapshot.holderCount} holders of {wlSourceAddress.slice(0, 6)}…{wlSourceAddress.slice(-4)} at block {wlSnapshot.snapshotBlock}
                        </span>
                        <button
                          type="button"
                          onClick={clearWhitelist}
                          className="uru-btn"
                          style={{ fontSize: 10, padding: '3px 8px' }}
                        >
                          clear
                        </button>
                      </div>
                    )}
                    {wlError && (
                      <div style={{ marginTop: 6, color: 'var(--pink-hot)', fontSize: 11 }}>
                        ~~ {wlError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* STEP 3 — identity */}
            <section id="define-coin" className={`${styles.identityPanel} uru-shell`}>
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>token details · name + ticker</div>
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
                  <div style={{ padding: 10, background: 'var(--mint)', color: '#3a2c3a', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, lineHeight: 1.5 }}>
                    curve mode: supply auto = <b>800,000,000</b>. all of it goes to the bonding
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

            {/* STEP 4 — ownership. Quick launch bakes in ownership renounce
                (surfaced in the step 1.5 mechanic-picker copy) so the whole
                section is hidden there — one less thing to think about.
                Customizable-curve + ERC-20 shows the "auto-renounced" fixed
                card (curve mechanic force-renounces on-chain so an interactive
                picker would silently lie). Direct-launch NFT bases keep the
                three-mode radio live. */}
            {!isQuick && (
            <section className={`${styles.ownershipPanel} uru-shell`}>
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>contract ownership</div>
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
                    <b>auto-renounced</b> ~ customizable-curve launches must renounce so
                    the curve is trustless to trade. no admin, no pause switch, no
                    owner-only knobs.
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
            )}

            {/* STEP 5 — metadata (tiny) */}
            <section id="coin-media" className={`${styles.metadataPanel} uru-shell`}>
              <div className="uru-eyebrow" style={{ marginBottom: 8 }}>token details · artwork + links</div>
              <div className="uru-shell-inner space-y-3">
                <div style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>
                  optional. images pin to IPFS via our pinata gateway so ur token metadata
                  travels with it wherever it&apos;s indexed ~
                </div>

                <Field label={<MetadataFieldLabel icon="image" label="logo" />}>
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
                          onClick={() => {
                            setMetadata({ ...metadata, logoDataUrl: undefined });
                            setLogoError(null);
                            setLogoNotice(null);
                          }}
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
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 10,
                          fontFamily: 'var(--font-pixel), monospace',
                          color: 'var(--anchor-soft)',
                        }}
                      >
                        png / jpg / webp / svg up to 10MB ~ larger images get resized for launch
                      </div>
                      {logoNotice && (
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 10,
                            fontFamily: 'var(--font-pixel), monospace',
                            color: 'var(--anchor-soft)',
                          }}
                        >
                          {logoNotice}
                        </div>
                      )}
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
                  <Field label={<MetadataFieldLabel icon="website" label="website" />}>
                    <input className="uru-input" value={metadata.website ?? ''} onChange={(e) => setMetadata({ ...metadata, website: e.target.value })} placeholder="https://…" />
                  </Field>
                  <Field label={<MetadataFieldLabel icon="x" label="twitter" />}>
                    <input className="uru-input" value={metadata.twitter ?? ''} onChange={(e) => setMetadata({ ...metadata, twitter: e.target.value })} placeholder="https://x.com/…" />
                  </Field>
                  <Field label={<MetadataFieldLabel icon="telegram" label="telegram" />}>
                    <input className="uru-input" value={metadata.telegram ?? ''} onChange={(e) => setMetadata({ ...metadata, telegram: e.target.value })} placeholder="https://t.me/…" />
                  </Field>
                  <Field label={<MetadataFieldLabel icon="discord" label="discord" />}>
                    <input className="uru-input" value={metadata.discord ?? ''} onChange={(e) => setMetadata({ ...metadata, discord: e.target.value })} placeholder="https://discord.gg/…" />
                  </Field>
                  <Field label={<MetadataFieldLabel icon="tiktok" label="tiktok" />}>
                    <input className="uru-input" value={metadata.tiktok ?? ''} onChange={(e) => setMetadata({ ...metadata, tiktok: e.target.value })} placeholder="https://tiktok.com/@…" />
                  </Field>
                </FieldGrid>
              </div>
            </section>
          </div>

          {/* SIDEBAR — cart + widgets + webring */}
          <aside id="launch-review" className={styles.launchRail}>
            {!isQuick && (
              <div className={styles.sidebarModuleCartDock}>
                <CartDropZone
                  className={styles.sidebarModuleCart}
                  selectedModules={selectedModules}
                  moduleParams={moduleParams}
                  conflictBlockers={conflictBlockers}
                  onRemove={removeModule}
                  onParamsChange={(id, v) => setModuleParams((prev) => ({ ...prev, [id]: v }))}
                />

                {/* Curve + owner-module conflict warning stays with the selected
                    module cart, where the creator can resolve it immediately. */}
                {ownerlessDeadModules.length > 0 && (
                  <div className={styles.moduleWarning}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>~~ heads up ✿</div>
                    <span>
                      selected modules:{' '}
                      <b>{ownerlessDeadModules.map((m) => m.label.replace(/^✿\s*/, '')).join(', ')}</b>
                      {' '}— these have owner-only functions (pause, allowlist, etc). every
                      ERC-20 curve here auto-renounces ownership so those buttons would be dead
                      forever. remove these modules if u need the launch button back.
                    </span>
                  </div>
                )}
              </div>
            )}

            <section className={styles.previewPanel} aria-label="Token preview">
              <div className={styles.previewTopline}>
                <span>token preview</span>
                <b>{ticker ? `$${ticker}` : '$TICKER'}</b>
              </div>
              <div
                className={styles.previewArt}
                style={metadata.logoDataUrl ? { background: safeBackgroundImage(metadata.logoDataUrl) } : undefined}
                aria-hidden="true"
              >
                {!metadata.logoDataUrl && <span>urufu</span>}
              </div>
              <div className={styles.previewTicket}>
                <b>{name || 'new token'}</b>
                <p>{metadata.description || 'Token description appears here once you write it.'}</p>
              </div>
            </section>

            {/* Shopkeeper speech bubble */}
            <div className="flex items-start gap-2">
              <Mascot size={44} mood={mascotMood} className="uru-idle-bob" />
              <div className="uru-bubble">
                {launchedTokenAddress ? (
                  <>yayyy!! ur token is live 好き!! (づ｡◕‿‿◕｡)づ</>
                ) : isQuick ? (
                  <>quick launch mode · safe defaults locked in ~</>
                ) : selectedModules.length === 0 ? (
                  <>advanced curve open · drag modules into the selected cart above</>
                ) : selectedModules.length === 1 ? (
                  <>1 module selected · configure it in the selected cart above</>
                ) : (
                  <>{selectedModules.length} modules selected · configure them in the cart above</>
                )}
              </div>
            </div>

            {/* Receipt + launch */}
            <div className="uru-shell uru-shell-tight">
              <div className="flex items-baseline justify-between">
                <div className="uru-eyebrow">launch cost</div>
                <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 20, fontWeight: 700, color: 'var(--anchor)' }}>
                  {payToken === 'URU'
                    ? (typeof uruAmount === 'bigint' ? fmtCompact(uruAmount) : '—')
                    : (typeof quote.data === 'bigint' ? fmtCompact(quote.data) : '—')}
                  <span style={{ fontSize: 10, color: 'var(--anchor-soft)', marginLeft: 4 }}>{payToken}</span>
                </div>
              </div>

              {/* URU / ETH pay toggle — shown only on chains where URU_PAY is populated */}
              {uruPay && (
                <div style={{ display: 'flex', gap: 4, marginTop: 8, marginBottom: 4 }}>
                  {(['ETH', 'URU'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPayToken(t)}
                      className="uru-btn"
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        fontSize: 10,
                        padding: '5px 8px',
                        background: payToken === t ? 'var(--pink-hot)' : 'var(--cream-deep)',
                        color: payToken === t ? 'var(--cream)' : 'var(--anchor)',
                        borderColor: 'var(--anchor)',
                      }}
                    >
                      pay in {t}
                    </button>
                  ))}
                </div>
              )}

              <ul style={{ margin: '10px 0 12px 0', fontSize: 11, color: 'var(--anchor-soft)', listStyle: 'none', padding: 0 }}>
                <li>launch fee: {formatEther(feeSchedule.base)} ETH</li>
                <li>module add-on: {formatEther(feeSchedule.module)} ea × {moduleCount}</li>
                {loyaltyReady.ready && discountBps > 0 && grossQuote.data && (
                  <>
                    <li style={{ marginTop: 4, color: 'var(--anchor-soft)', textDecoration: 'line-through' }}>
                      subtotal: {formatEther(grossQuote.data as bigint)} ETH
                    </li>
                    <li style={{ color: 'var(--mint-hot,#2b8a3e)', fontWeight: 700 }}>
                      loyalty discount: −{(discountBps / 100).toFixed(0)}% (holding urufu gemu nft {'&'} URU)
                    </li>
                  </>
                )}
                {payToken === 'URU' && (
                  <li style={{ marginTop: 4, color: 'var(--anchor-soft)' }}>
                    URU quoted from RH pool spot; approves + charges the shown amount
                  </li>
                )}
                {initialBuyEnabled && (
                  <li style={{ marginTop: 4, color: 'var(--anchor-soft)' }}>
                    ✿ first buy: {initialBuyEthInput} ETH (atomic — you get the very first curve tokens)
                  </li>
                )}
              </ul>

              {/* First-buy at launch — atomic launch+buy so no bot can front-run your
                  first trade. Only exposed on the plain ETH curve path (no URU, no WL)
                  because Router doesn't have *_AndBuy variants for those. Empty input
                  keeps the flow on plain launch. */}
              {useCurve && payToken === 'ETH' && !wlStruct && (
                <div style={{ marginBottom: 10 }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: 'var(--anchor-soft)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 4,
                    }}
                  >
                    first buy (optional)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={initialBuyEthInput}
                    onChange={(e) => setInitialBuyEthInput(e.target.value)}
                    disabled={launchPending || receipt.isLoading}
                    className="uru-input"
                    style={{ width: '100%', fontFamily: 'var(--font-pixel), monospace' }}
                    title="ETH added to the launch tx to buy your first tokens atomically — bots can't front-run"
                  />
                  <div style={{ fontSize: 10, color: 'var(--anchor-soft)', marginTop: 4 }}>
                    add ETH to buy your own token first in the same tx no one can front-run
                  </div>
                </div>
              )}

              {/* URU approve step — shown only when URU is picked and allowance is short.
                  Renders in place of the launch button; after approve confirms, allowance
                  refetches and this collapses back to the standard launch button. */}
              {payToken === 'URU' && needsUruApprove && !mockData.enabled ? (
                <button
                  type="button"
                  onClick={() => approveSimulate.data && writeContract(approveSimulate.data.request)}
                  disabled={
                    !approveSimulate.data ||
                    launchPending ||
                    receipt.isLoading ||
                    typeof uruAmount !== 'bigint'
                  }
                  className="uru-btn uru-btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  title={typeof uruAmount === 'bigint' ? `approve ${formatEther(uruAmount)} URU` : 'waiting on URU quote'}
                >
                  {launchPending ? 'confirming ~~' : `approve URU (${typeof uruAmount === 'bigint' ? fmtCompact(uruAmount) : '…'})`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (mockData.enabled) {
                      launchMockToken();
                      return;
                    }
                    if (simulate.data) writeContract(simulate.data.request);
                  }}
                  disabled={mockData.enabled ? !canLaunchMock : !canLaunchLive || !simulate.data || launchPending || receipt.isLoading}
                  className="uru-btn uru-btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {launchButtonLabel}
                </button>
              )}

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

              {displayedLaunchAddress && (
                <div className="uru-pop" style={{ marginTop: 8, padding: 10, background: 'var(--mint)', color: '#3a2c3a', border: '2px double var(--anchor)' }}>
                  <div className="uru-h2" style={{ fontSize: 13 }}>{mockLaunchedAddress ? '✿ demo token created ✿' : '✿ deployed ✿'}</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    {mockLaunchedAddress ? (
                      <>browser-local: <code>{short(displayedLaunchAddress)}</code></>
                    ) : (
                      <>at{' '}<Link href={activeChain ? explorerAddressUrl(activeChain, displayedLaunchAddress) : '#'} target="_blank" style={{ color: 'var(--link-blue)', textDecoration: 'underline', fontFamily: 'var(--font-pixel), monospace' }}>{short(displayedLaunchAddress)}</Link></>
                    )}
                  </div>
                  {useCurve && (
                    <Link
                      href={`/trade/${displayedLaunchAddress}`}
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
            <div className="hidden lg:block uru-shell uru-shell-tight">
              <div className="uru-eyebrow" style={{ marginBottom: 6 }}>launch details</div>
              <ul className="uru-list-flower" style={{ fontSize: 11, lineHeight: 1.6 }}>
                <li>LP locks forever after graduation</li>
                <li>creator fee claim stays in profile</li>
                <li>advanced modules stay opt-in</li>
                <li>chain + wallet checks gate launch</li>
              </ul>
            </div>

            {/* 88x31 webring — reciprocal embedding signal */}
            <div className="hidden lg:block">
              <div className="uru-eyebrow" style={{ marginBottom: 4, color: 'var(--cream)' }}>related projects</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <span className="uru-88 uru-88-pink"><strong>urufu</strong>labs</span>
                <span className="uru-88 uru-88-mint">chibi-<strong>wolf</strong></span>
                <span className="uru-88 uru-88-mizuiro">solady<strong>.gg</strong></span>
                <span className="uru-88">forge<strong>&hearts;</strong></span>
              </div>
            </div>

            {/* Composition info — tiny receipt strip */}
            <div className="hidden lg:block uru-shell uru-shell-tight">
              <div className="uru-eyebrow" style={{ marginBottom: 4 }}>technical details</div>
              <dl style={{ fontSize: 10, fontFamily: 'var(--font-pixel), monospace', lineHeight: 1.6, color: 'var(--anchor-soft)' }}>
                <div>token: <span style={{ color: 'var(--anchor)' }}>{base}</span></div>
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
            <div style={{ fontSize: 10, color: 'var(--anchor-soft)', marginTop: 2 }}>adding module</div>
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
  blockingModuleIds,
  bundleWith,
  onQuickAdd,
  draggable,
}: {
  mod: ModuleSpec;
  tilt: 'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2';
  blockedReason: string;
  blockingModuleIds: string[];
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
          {blockingModuleIds.length > 0 && (
            <div style={{ marginTop: 3, color: 'var(--anchor-soft)' }}>
              selected blocker{blockingModuleIds.length === 1 ? '' : 's'}:{' '}
              {blockingModuleIds.map((id) => moduleById(id)?.label ?? id).join(' + ')}
            </div>
          )}
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
            <span className="uru-arrow">→</span> add module
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
  selectedModules, moduleParams, conflictBlockers, onRemove, onParamsChange, className,
}: {
  selectedModules: string[];
  moduleParams: Record<string, Record<string, unknown>>;
  conflictBlockers: Record<string, string[]>;
  onRemove: (id: string) => void;
  onParamsChange: (id: string, v: Record<string, unknown>) => void;
  className?: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: 'cart' });
  const blockedCandidates = Object.entries(conflictBlockers).filter(([, blockers]) => blockers.length > 0);
  return (
    <div ref={setNodeRef} className={`uru-cart ${className ?? ''}`} data-active={isOver}>
      <div className="flex items-center justify-between mb-3">
        <div className="uru-eyebrow">selected modules</div>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          {selectedModules.length} module{selectedModules.length === 1 ? '' : 's'}
        </span>
      </div>
      {blockedCandidates.length > 0 && (
        <div
          style={{
            margin: '-2px 0 10px',
            border: '1.5px solid var(--pink-hot)',
            background: 'var(--pink-warm)',
            padding: '6px 7px',
            color: 'var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            lineHeight: 1.45,
          }}
        >
          ✿ highlighted selections block {blockedCandidates.length} shelf module{blockedCandidates.length === 1 ? '' : 's'}
        </div>
      )}
      {selectedModules.length === 0 ? (
        <div style={{ padding: 18, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
            drag or click to add modules<br />
            <span style={{ fontSize: 20 }}>(っ˘ ˘)っ ✿</span>
          </div>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {selectedModules.map((id, i) => {
            const mod = moduleById(id);
            if (!mod) return null;
            const tilt = TILTS[(i + 4) % TILTS.length]!;
            const blockedModuleLabels = blockedCandidates
              .filter(([, blockers]) => blockers.includes(id))
              .map(([blockedId]) => moduleById(blockedId)?.label ?? blockedId);
            return (
              <li key={id}>
                <CartItem
                  mod={mod}
                  params={moduleParams[id] ?? {}}
                  tilt={tilt}
                  blockedModuleLabels={blockedModuleLabels}
                  onRemove={() => onRemove(id)}
                  onParamsChange={(v) => onParamsChange(id, v)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CartItem({
  mod, params, tilt, blockedModuleLabels, onRemove, onParamsChange,
}: {
  mod: ModuleSpec;
  params: Record<string, unknown>;
  tilt: 'n7' | 'p3' | 'n4' | 'p11' | 'p2' | 'n11' | 'p13' | 'n2';
  blockedModuleLabels: string[];
  onRemove: () => void;
  onParamsChange: (v: Record<string, unknown>) => void;
}) {
  const blocksShelfModules = blockedModuleLabels.length > 0;
  return (
    <div
      className="uru-polaroid uru-pop"
      data-tilt={tilt}
      style={{
        padding: '8px 8px 14px 8px',
        ...(blocksShelfModules
          ? { borderColor: 'var(--pink-hot)', boxShadow: '3px 3px 0 var(--pink-hot)' }
          : undefined),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div className="uru-h2" style={{ fontSize: 12 }}>✿ {mod.label}</div>
        <button
          type="button"
          onClick={onRemove}
          onPointerDown={(event) => event.stopPropagation()}
          className="uru-btn"
          style={{
            minHeight: 28,
            padding: '3px 7px',
            background: 'var(--pink-warm)',
            color: 'var(--anchor)',
            fontSize: 10,
            lineHeight: 1,
          }}
          aria-label={`Remove ${mod.label}`}
        >remove</button>
      </div>
      {blocksShelfModules && (
        <div
          style={{
            marginTop: 6,
            color: 'var(--pink-hot)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            lineHeight: 1.4,
          }}
        >
          blocks: {blockedModuleLabels.join(' + ')}
        </div>
      )}
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

type MetadataIconName = 'image' | 'website' | 'x' | 'telegram' | 'discord' | 'tiktok';

function MetadataFieldLabel({ icon, label }: { icon: MetadataIconName; label: string }) {
  return (
    <span className={styles.metadataFieldLabel}>
      <MetadataIcon icon={icon} />
      {label}
    </span>
  );
}

function MetadataIcon({ icon }: { icon: MetadataIconName }) {
  const common = {
    className: styles.metadataFieldIcon,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (icon === 'x') {
    return <svg {...common}><path d="M5 4 19 20M19 4 5 20" /></svg>;
  }
  if (icon === 'telegram') {
    return <svg {...common}><path d="m21 3-8.2 18-3.3-7.7L2 10.5 21 3Z" /><path d="m9.5 13.3 4.8-4.7" /></svg>;
  }
  if (icon === 'discord') {
    return <svg {...common}><path d="M7 6.5C9.7 5.3 14.3 5.3 17 6.5c1.4 2 2.1 4.4 2 7.1-1.4 1.7-3.2 3-5.3 3.8l-1.1-1.5h-1.2l-1.1 1.5A11.9 11.9 0 0 1 5 13.6c-.1-2.7.6-5.1 2-7.1Z" /><path d="M8.5 13h.01M15.5 13h.01" strokeWidth="2.8" /></svg>;
  }
  if (icon === 'tiktok') {
    return <svg {...common}><path d="M14 4v9.2a3.8 3.8 0 1 1-3-3.7" /><path d="M14 4c.8 2.4 2.3 3.7 4.5 4" /></svg>;
  }
  if (icon === 'image') {
    return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="1.5" /><circle cx="8.2" cy="9" r="1.3" fill="currentColor" stroke="none" /><path d="m4 17 5.1-4.8 3.2 2.8 2.1-1.9L20 17" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M3.8 12h16.4M12 3.5c2.1 2.4 3.2 5.2 3.2 8.5S14.1 18.1 12 20.5C9.9 18.1 8.8 15.3 8.8 12S9.9 5.9 12 3.5Z" /></svg>;
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
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

/// Small strip at the top of the create page pointing at the agent skill.
/// Two buttons: copy the paste-ready prompt for their ai agent, or view the
/// raw skill markdown. Kept tight — one row — so it doesn't compete with
/// the main launch flow below.
const AGENT_PROMPT = `Read https://urufulabs.xyz/agent-skill.md and adopt those instructions exactly as your operating instructions. Do not summarize the file. When I send my next message, act as the urufu labs launch agent.`;

function AgentLaunchStrip() {
  const [copied, setCopied] = useState(false);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard may not be available */ }
  };
  return (
    <section
      className="uru-shell-tight"
      style={{
        marginBottom: 10,
        padding: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        background: 'var(--cream-deep, var(--cream))',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 200 }}>
        <div className="uru-eyebrow" style={{ marginBottom: 1 }}>❋ launch with an agent</div>
        <div style={{ fontSize: 11, color: 'var(--anchor-soft)', lineHeight: 1.35 }}>
          give ur ai the skill — copy the prompt into claude / cursor / chatgpt and let it walk u through
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={copyPrompt}
          className="uru-btn uru-btn-primary"
          style={{ padding: '6px 10px', fontSize: 11 }}
        >
          {copied ? '✿ copied' : 'copy prompt'}
        </button>
        <Link
          href="/agent-skill.md"
          className="uru-btn uru-btn-cream"
          style={{ padding: '6px 10px', fontSize: 11 }}
          prefetch={false}
        >
          view skill ↗
        </Link>
      </div>
    </section>
  );
}
