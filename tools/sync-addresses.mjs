#!/usr/bin/env node
/**
 * Sync every `contracts/deployment*.<chainid>.json` book → web + indexer.
 *
 * DeployPhase1 writes          → contracts/deployment.<chainid>.json           (required)
 * DeployHooks writes           → contracts/deployment-hooks.<chainid>.json     (optional)
 * DeployGraduator writes       → contracts/deployment-graduator.<chainid>.json (optional)
 * DeployV4SwapRouter writes    → contracts/deployment-v4router.<chainid>.json  (optional)
 * DeployFlywheel writes        → contracts/deployment-flywheel.<chainid>.json  (optional)
 * DeployRouterV2 writes        → contracts/deployment-routerv2.<chainid>.json  (optional)
 *                               (overrides CONTRACTS.<chain>.Router with the RouterV2 address)
 * DeployCurveFactoryV2 writes  → contracts/deployment-curvefactoryv2.<chainid>.json (optional)
 *                               (overrides CONTRACTS.<chain>.CurveFactory + BondingCurveImpl
 *                                with the whitelist-aware fresh deployment)
 *
 * This script consumes whichever are present and:
 *   - Patches CONTRACTS[chain] in web/src/lib/config.ts (Phase 1 core)
 *   - Patches HOOKS[chain]     in web/src/lib/config.ts if hooks book exists
 *   - Patches GRADUATORS[chain] in web/src/lib/config.ts if graduator book exists
 *   - Patches V4_ROUTERS[chain] in web/src/lib/config.ts if v4router book exists
 *   - Patches FLYWHEEL[chain]  in web/src/lib/config.ts if flywheel book exists
 *   - Prints a .env-shaped block for indexer + web
 *
 * Usage:
 *   node tools/sync-addresses.mjs sepolia
 *   node tools/sync-addresses.mjs mainnet
 *   node tools/sync-addresses.mjs robinhood
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const CHAIN_TO_ID = {
  mainnet: 1,
  sepolia: 11155111,
  base: 8453,
  'base-sepolia': 84532,
  robinhood: 4663,
  'robinhood-testnet': 46630,
};

const chain = process.argv[2];
if (!chain || !(chain in CHAIN_TO_ID)) {
  console.error(`Usage: node tools/sync-addresses.mjs <${Object.keys(CHAIN_TO_ID).join('|')}>`);
  process.exit(1);
}
const chainId = CHAIN_TO_ID[chain];
const bookPath = (kind) =>
  join(repoRoot, 'contracts', `deployment${kind ? `-${kind}` : ''}.${chainId}.json`);
const readBook = (kind) => {
  const p = bookPath(kind);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const core = readBook(null);
if (!core) {
  console.error(`No address book at ${bookPath(null)}. Broadcast DeployPhase1 first.`);
  process.exit(1);
}
const hooks = readBook('hooks');
const v2hook = readBook('v2hook'); // MigrateToV2Hook's book — overrides hooks.MultiHookHost + graduator
const graduator = readBook('graduator');
const v4router = readBook('v4router');
const flywheel = readBook('flywheel');
const routerv2 = readBook('routerv2');
const curvefactoryv2 = readBook('curvefactoryv2');
/// DeployV3Stack's book — trumps every earlier stack. Ships new BondingCurve
/// impl + CurveFactoryV3 + MultiHookHostV3 + GraduatorV3 in one shot. Same
/// override precedence as v2hook (whatever's newer wins).
const v3stack = readBook('v3stack');
/// DeployV4Stack.s.sol's book - trumps every earlier stack. Ships fresh
/// BondingCurve/CurveFactory/MultiHookHost/Graduator/V4SwapRouter + fresh
/// flywheel contracts (FeeSplitter/UruDepositSink/UruBuybackVault/
/// NftRevenueVault) + fresh RoyaltyRouterFactory. Field names in the book
/// carry `V4` suffixes to make the stack version explicit; we re-map to
/// unsuffixed names when layering into CONTRACTS/HOOKS/GRADUATORS/FLYWHEEL/
/// V4_ROUTERS below.
const v4stack = readBook('v4stack');

// ---- Field lists mirror the interfaces in web/src/lib/config.ts. ------------

const CONTRACT_FIELDS = [
  'NameRegistry',
  'Router',
  'FeeReceiver',
  'ERC20Factory',
  'ERC20TemplateImpl',
  'ERC20WithAntiBotImpl',
  'ERC20WithAntiWhaleImpl',
  'ERC20WithFoTImpl',
  'ERC20WithPausableImpl',
  'ERC20WithPermitImpl',
  'ERC20WithAirdropImpl',
  'ERC20WithVestingImpl',
  'ERC20WithStakingImpl',
  'ERC20WithVotesImpl',
  'ERC721AFactory',
  'ERC721ATemplateImpl',
  'ERC721AWithDelayedRevealImpl',
  'ERC721AWithSvgImpl',
  'ERC721AWithRoyaltyImpl',
  'ERC721AWithSvgAndRoyaltyImpl',
  'ERC721AWithSoulboundImpl',
  'ERC721AWithRefundableImpl',
  'ERC1155Factory',
  'ERC1155TemplateImpl',
  'CurveFactory',
  'BondingCurveImpl',
];
const HOOK_FIELDS = [
  'PoolManager',
  'LPLockedHook',
  'FeeRedirectHook',
  'AntiSniperHook',
  'MultiHookHost',
  'BuybackBurnHook',
];
const FLYWHEEL_FIELDS = [
  'FeeSplitter',
  'LoyaltyOracle',
  'NftRevenueVault',
  'UruBuybackVault',
  'RoyaltyRouterImpl',
  'RoyaltyRouterFactory',
];

const ZERO = '0x0000000000000000000000000000000000000000';
const pick = (src, fields) => {
  const out = {};
  for (const f of fields) out[f] = src?.[f] ?? ZERO;
  return out;
};

// ---- Patch web/src/lib/config.ts -------------------------------------------
const configPath = join(repoRoot, 'web', 'src', 'lib', 'config.ts');
let config = readFileSync(configPath, 'utf8');

const patchMap = (mapName, fields, src) => {
  const set = pick(src, fields);
  const literal = `{
${fields.map((f) => `    ${f}: '${set[f]}',`).join('\n')}
  }`;
  // Match one entry inside `export const <mapName>: Record<ChainKey, X | null> = { ... }`.
  // The regex is line-anchored to `  'key':` / `  key:` and replaces either `null` or an
  // existing object literal.
  const re = new RegExp(
    `(^|\\n)(  '?${chain}'?:)\\s*(?:null|\\{[\\s\\S]*?\\n  \\})`,
    'g',
  );
  // We need to scope to the specific map — use a scoped block.
  const mapRe = new RegExp(
    `(export const ${mapName}: Record<ChainKey,[^\\n]*?> = \\{)([\\s\\S]*?)(\\n\\};)`,
  );
  const match = mapRe.exec(config);
  if (!match) {
    console.warn(`  [skip] no ${mapName} map to patch`);
    return false;
  }
  const [, header, body, footer] = match;
  const newBody = body.replace(re, (_, lead, prefix) => `${lead}${prefix} ${literal}`);
  if (newBody === body) {
    console.warn(`  [skip] no ${mapName}.${chain} entry to patch`);
    return false;
  }
  config = config.replace(mapRe, `${header}${newBody}${footer}`);
  return true;
};

const patchScalar = (mapName, value) => {
  const mapRe = new RegExp(
    `(export const ${mapName}: Record<ChainKey,[^\\n]*?> = \\{)([\\s\\S]*?)(\\n\\};)`,
  );
  const match = mapRe.exec(config);
  if (!match) {
    console.warn(`  [skip] no ${mapName} map to patch`);
    return false;
  }
  const [, header, body, footer] = match;
  const re = new RegExp(`(^|\\n)(  '?${chain}'?:)\\s*(?:null|'0x[0-9a-fA-F]+')`, 'g');
  const newBody = body.replace(re, (_, lead, prefix) => `${lead}${prefix} '${value}'`);
  if (newBody === body) {
    console.warn(`  [skip] no ${mapName}.${chain} entry to patch`);
    return false;
  }
  config = config.replace(mapRe, `${header}${newBody}${footer}`);
  return true;
};

// Layer overrides onto the core book:
//   - RouterV2 (from deployment-routerv2.<chainid>.json) → CONTRACTS.<chain>.Router
//   - WL-aware CurveFactory (from deployment-curvefactoryv2.<chainid>.json) →
//     CONTRACTS.<chain>.CurveFactory + BondingCurveImpl
const coreWithOverrides = {
  ...core,
  ...(routerv2?.RouterV2 ? { Router: routerv2.RouterV2 } : {}),
  ...(curvefactoryv2?.CurveFactory
    ? { CurveFactory: curvefactoryv2.CurveFactory, BondingCurveImpl: curvefactoryv2.BondingCurveImpl }
    : {}),
  // V3 stack wins over V2 for both CurveFactory + BondingCurveImpl.
  ...(v3stack?.CurveFactoryV3
    ? { CurveFactory: v3stack.CurveFactoryV3, BondingCurveImpl: v3stack.BondingCurveImpl }
    : {}),
  // V4 stack wins over V3 for Router + CurveFactory + BondingCurveImpl.
  ...(v4stack?.RouterV2 ? { Router: v4stack.RouterV2 } : {}),
  ...(v4stack?.CurveFactoryV4
    ? { CurveFactory: v4stack.CurveFactoryV4, BondingCurveImpl: v4stack.BondingCurveImpl }
    : {}),
};
if (patchMap('CONTRACTS', CONTRACT_FIELDS, coreWithOverrides)) {
  const suffix = [
    v4stack?.RouterV2 ? 'Router → V4'
      : routerv2?.RouterV2 ? 'Router → RouterV2' : '',
    v4stack?.CurveFactoryV4 ? 'CurveFactory → V4'
      : v3stack?.CurveFactoryV3 ? 'CurveFactory → V3'
        : curvefactoryv2?.CurveFactory ? 'CurveFactory → V2' : '',
  ].filter(Boolean).join(', ');
  console.log(`✓ wrote CONTRACTS.${chain}${suffix ? ` (${suffix})` : ''}`);
}
if (routerv2) {
  console.log(`  [note] RouterV2 book found — UruDepositSink at ${routerv2.UruDepositSink}`);
  console.log(`         Keeper will need this address to drain URU deposits.`);
}
if (hooks) {
  // Layer v2hook overrides on top when MigrateToV2Hook has been run — it deploys a
  // fresh MultiHookHost + Graduator, and its addresses become canonical.
  const hooksWithOverride = v4stack?.MultiHookHostV4
    ? { ...hooks, MultiHookHost: v4stack.MultiHookHostV4 }
    : v3stack?.MultiHookHostV3
      ? { ...hooks, MultiHookHost: v3stack.MultiHookHostV3 }
      : v2hook?.MultiHookHostV2
        ? { ...hooks, MultiHookHost: v2hook.MultiHookHostV2 }
        : hooks;
  if (patchMap('HOOKS', HOOK_FIELDS, hooksWithOverride)) {
    const suffix = v4stack?.MultiHookHostV4
      ? ' (MultiHookHost → V4)'
      : v3stack?.MultiHookHostV3
        ? ' (MultiHookHost → V3)'
        : v2hook?.MultiHookHostV2 ? ' (MultiHookHost → V2)' : '';
    console.log(`✓ wrote HOOKS.${chain}${suffix}`);
  }
} else {
  console.log(`  [note] no hooks book at ${bookPath('hooks')} — HOOKS.${chain} left as-is`);
}
// GRADUATORS.<chain> — precedence: v4stack > v3stack > v2hook > standalone graduator book.
const graduatorAddr =
  v4stack?.GraduatorV4 ?? v3stack?.GraduatorV3 ?? v2hook?.GraduatorV2 ?? graduator?.Graduator;
if (graduatorAddr) {
  if (patchScalar('GRADUATORS', graduatorAddr)) {
    const suffix = v4stack?.GraduatorV4
      ? ' (Graduator → V4)'
      : v3stack?.GraduatorV3
      ? ' (Graduator → V3)'
      : v2hook?.GraduatorV2 ? ' (Graduator → V2)' : '';
    console.log(`✓ wrote GRADUATORS.${chain}${suffix}`);
  }
} else {
  console.log(`  [note] no graduator or v2hook book — GRADUATORS.${chain} left as-is`);
}
// V4_ROUTERS.<chain> — v4stack.V4SwapRouterV4 wins over standalone v4router book.
const v4SwapRouterAddr = v4stack?.V4SwapRouterV4 ?? v4router?.V4SwapRouter;
if (v4SwapRouterAddr) {
  if (patchScalar('V4_ROUTERS', v4SwapRouterAddr)) {
    console.log(`✓ wrote V4_ROUTERS.${chain}${v4stack?.V4SwapRouterV4 ? ' (V4SwapRouter → V4)' : ''}`);
  }
} else {
  console.log(`  [note] no v4router book at ${bookPath('v4router')} — V4_ROUTERS.${chain} left as-is`);
}
// FLYWHEEL - v4stack wins over standalone flywheel book. V4 renames fields
// (FeeSplitterV4/UruBuybackVaultV4/NftRevenueVaultV4) so re-map here to the
// unsuffixed keys FLYWHEEL_FIELDS expects.
const flywheelWithV4 = v4stack
  ? {
    ...flywheel,
    FeeSplitter: v4stack.FeeSplitterV4 ?? flywheel?.FeeSplitter,
    NftRevenueVault: v4stack.NftRevenueVaultV4 ?? flywheel?.NftRevenueVault,
    UruBuybackVault: v4stack.UruBuybackVaultV4 ?? flywheel?.UruBuybackVault,
    RoyaltyRouterImpl: v4stack.RoyaltyRouterImplV4 ?? flywheel?.RoyaltyRouterImpl,
    RoyaltyRouterFactory: v4stack.RoyaltyRouterFactoryV4 ?? flywheel?.RoyaltyRouterFactory,
    LoyaltyOracle: flywheel?.LoyaltyOracle, // unchanged in V4
  }
  : flywheel;
if (flywheelWithV4) {
  if (patchMap('FLYWHEEL', FLYWHEEL_FIELDS, flywheelWithV4)) {
    console.log(`✓ wrote FLYWHEEL.${chain}${v4stack ? ' (V4)' : ''}`);
  }
} else {
  console.log(`  [note] no flywheel book at ${bookPath('flywheel')} — FLYWHEEL.${chain} left as-is`);
}

writeFileSync(configPath, config);
console.log(`✓ ${configPath}`);

// ---- Emit env block for indexer + broadcast tooling ------------------------
// Uses coreWithOverrides so the printed addresses reflect any layered updates
// (RouterV2 → Router, CurveFactoryV2 → CurveFactory). Emit BOTH the legacy
// NEXT_PUBLIC_* form AND the chain-prefixed form the indexer actually reads.
const emit = coreWithOverrides;
const prefix = chain.toUpperCase().replace(/-/g, '_');
const startBlockKey = `PONDER_START_BLOCK_${prefix}`;
console.log('\n---- paste into your .env ----------------------------------');
console.log(`# ${chain} @ block ${core.deployedAtBlock}`);
console.log(`# --- Chain-prefixed (indexer + newer deploys read these) ---`);
console.log(`${prefix}_NAME_REGISTRY_ADDRESS=${emit.NameRegistry}`);
console.log(`${prefix}_ROUTER_ADDRESS=${emit.Router}`);
console.log(`${prefix}_ERC20_FACTORY_ADDRESS=${emit.ERC20Factory}`);
console.log(`${prefix}_ERC721A_FACTORY_ADDRESS=${emit.ERC721AFactory}`);
console.log(`${prefix}_ERC1155_FACTORY_ADDRESS=${emit.ERC1155Factory}`);
console.log(`${prefix}_CURVE_FACTORY_ADDRESS=${emit.CurveFactory}`);
if (hooks?.PoolManager) console.log(`${prefix}_POOL_MANAGER_ADDRESS=${hooks.PoolManager}`);
// MultiHookHost env — V4 > V3 > V2 > original hooks book.
const emitHookAddr = v4stack?.MultiHookHostV4
  ?? v3stack?.MultiHookHostV3
  ?? v2hook?.MultiHookHostV2
  ?? hooks?.MultiHookHost;
if (emitHookAddr) {
  console.log(`${prefix}_MULTI_HOOK_HOST_ADDRESS=${emitHookAddr}`);
}
// V4SwapRouter env — v4stack wins over standalone v4router book.
const emitV4SwapRouter = v4stack?.V4SwapRouterV4 ?? v4router?.V4SwapRouter;
if (emitV4SwapRouter) console.log(`${prefix}_V4_SWAP_ROUTER_ADDRESS=${emitV4SwapRouter}`);
// Flywheel + URU sink — v4stack fields win, fall back to the older books.
const emitFeeSplitter = v4stack?.FeeSplitterV4 ?? flywheel?.FeeSplitter;
const emitBuybackVault = v4stack?.UruBuybackVaultV4 ?? flywheel?.UruBuybackVault;
const emitUruSink = v4stack?.UruDepositSinkV4 ?? routerv2?.UruDepositSink;
const emitNftVault = v4stack?.NftRevenueVaultV4 ?? flywheel?.NftRevenueVault;
if (emitFeeSplitter) console.log(`${prefix}_FEE_SPLITTER_ADDRESS=${emitFeeSplitter}`);
if (emitBuybackVault) console.log(`${prefix}_URU_BUYBACK_VAULT_ADDRESS=${emitBuybackVault}`);
if (emitUruSink) console.log(`${prefix}_URU_DEPOSIT_SINK_ADDRESS=${emitUruSink}`);
if (emitNftVault) console.log(`${prefix}_NFT_REVENUE_VAULT_ADDRESS=${emitNftVault}`);
console.log(`${startBlockKey}=${core.deployedAtBlock}`);
console.log(`# --- Legacy unprefixed fallback (only used when INDEXER_CHAIN=${chain}) ---`);
console.log(`NEXT_PUBLIC_NAME_REGISTRY_ADDRESS=${emit.NameRegistry}`);
console.log(`NEXT_PUBLIC_ROUTER_ADDRESS=${emit.Router}`);
console.log(`NEXT_PUBLIC_ERC20_FACTORY_ADDRESS=${core.ERC20Factory}`);
console.log(`NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS=${core.ERC721AFactory}`);
console.log(`NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS=${core.ERC1155Factory}`);
console.log(`NEXT_PUBLIC_CURVE_FACTORY_ADDRESS=${core.CurveFactory}`);
if (hooks?.PoolManager) {
  console.log(`NEXT_PUBLIC_POOL_MANAGER_ADDRESS=${hooks.PoolManager}`);
}
console.log(`PONDER_START_BLOCK_${chain.toUpperCase().replace('-', '_')}=${core.deployedAtBlock}`);
console.log('------------------------------------------------------------\n');

console.log('Next: restart the indexer + web dev server so they pick up the new addresses.');
