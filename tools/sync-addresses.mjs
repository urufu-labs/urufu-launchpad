#!/usr/bin/env node
/**
 * Sync every `contracts/deployment*.<chainid>.json` book → web + indexer.
 *
 * DeployPhase1 writes    → contracts/deployment.<chainid>.json           (required)
 * DeployHooks writes     → contracts/deployment-hooks.<chainid>.json     (optional)
 * DeployGraduator writes → contracts/deployment-graduator.<chainid>.json (optional)
 * DeployFlywheel writes  → contracts/deployment-flywheel.<chainid>.json  (optional)
 *
 * This script consumes whichever are present and:
 *   - Patches CONTRACTS[chain] in web/src/lib/config.ts (Phase 1 core)
 *   - Patches HOOKS[chain]     in web/src/lib/config.ts if hooks book exists
 *   - Patches GRADUATORS[chain] in web/src/lib/config.ts if graduator book exists
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
const graduator = readBook('graduator');
const flywheel = readBook('flywheel');

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

if (patchMap('CONTRACTS', CONTRACT_FIELDS, core)) {
  console.log(`✓ wrote CONTRACTS.${chain}`);
}
if (hooks) {
  if (patchMap('HOOKS', HOOK_FIELDS, hooks)) console.log(`✓ wrote HOOKS.${chain}`);
} else {
  console.log(`  [note] no hooks book at ${bookPath('hooks')} — HOOKS.${chain} left as-is`);
}
if (graduator) {
  if (patchScalar('GRADUATORS', graduator.Graduator ?? ZERO)) {
    console.log(`✓ wrote GRADUATORS.${chain}`);
  }
} else {
  console.log(`  [note] no graduator book at ${bookPath('graduator')} — GRADUATORS.${chain} left as-is`);
}
if (flywheel) {
  if (patchMap('FLYWHEEL', FLYWHEEL_FIELDS, flywheel)) console.log(`✓ wrote FLYWHEEL.${chain}`);
} else {
  console.log(`  [note] no flywheel book at ${bookPath('flywheel')} — FLYWHEEL.${chain} left as-is`);
}

writeFileSync(configPath, config);
console.log(`✓ ${configPath}`);

// ---- Emit env block for indexer + broadcast tooling ------------------------
console.log('\n---- paste into your .env ----------------------------------');
console.log(`# ${chain} @ block ${core.deployedAtBlock}`);
console.log(`NEXT_PUBLIC_NAME_REGISTRY_ADDRESS=${core.NameRegistry}`);
console.log(`NEXT_PUBLIC_ROUTER_ADDRESS=${core.Router}`);
console.log(`NEXT_PUBLIC_ERC20_FACTORY_ADDRESS=${core.ERC20Factory}`);
console.log(`NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS=${core.ERC721AFactory}`);
console.log(`NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS=${core.ERC1155Factory}`);
console.log(`NEXT_PUBLIC_CURVE_FACTORY_ADDRESS=${core.CurveFactory}`);
console.log(`PONDER_START_BLOCK_${chain.toUpperCase().replace('-', '_')}=${core.deployedAtBlock}`);
console.log('------------------------------------------------------------\n');

console.log('Next: restart the indexer + web dev server so they pick up the new addresses.');
