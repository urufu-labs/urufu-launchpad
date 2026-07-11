#!/usr/bin/env node
/**
 * Sync contracts/deployment.<chainid>.json → web + indexer.
 *
 * After DeployPhase1 broadcasts, it writes an address book to
 *   contracts/deployment.<chainid>.json
 * This script consumes it and:
 *   - Patches web/src/lib/config.ts CONTRACTS[chainKey] with the real addresses
 *   - Prints a .env-shaped block for the indexer + web (paste into your .env)
 *
 * Usage:
 *   node tools/sync-addresses.mjs sepolia
 *   node tools/sync-addresses.mjs mainnet
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
const deploymentPath = join(repoRoot, 'contracts', `deployment.${chainId}.json`);

if (!existsSync(deploymentPath)) {
  console.error(`No address book at ${deploymentPath}. Broadcast DeployPhase1 first.`);
  process.exit(1);
}
const addrs = JSON.parse(readFileSync(deploymentPath, 'utf8'));

// ---- 1. Patch web/src/lib/config.ts ----------------------------------------
const configPath = join(repoRoot, 'web', 'src', 'lib', 'config.ts');
let config = readFileSync(configPath, 'utf8');

// Build the ContractSet literal.
const REQUIRED_FIELDS = [
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
  'ERC20WithGovernorImpl',
  'ERC20VotesTemplateImpl',
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
const set = {};
for (const f of REQUIRED_FIELDS) set[f] = addrs[f] ?? '0x0000000000000000000000000000000000000000';

// Rewrite CONTRACTS[chain] block. Regex is line-anchored to the object literal.
const chainKey = chain;
const literal = `{
${REQUIRED_FIELDS.map((f) => `    ${f}: '${set[f]}',`).join('\n')}
  }`;
const re = new RegExp(`(  '?${chainKey}'?:)\\s*(?:null|\\{[\\s\\S]*?\\})`, 'g');
if (!re.test(config)) {
  console.error(`No CONTRACTS.${chainKey} entry to patch in ${configPath}`);
  process.exit(1);
}
config = config.replace(re, (_, prefix) => `${prefix} ${literal}`);
writeFileSync(configPath, config);
console.log(`✓ wrote CONTRACTS.${chainKey} → ${configPath}`);

// ---- 2. Emit env block for indexer + broadcast tooling ---------------------
console.log('\n---- paste into your .env ----------------------------------');
console.log(`# ${chain} @ block ${addrs.deployedAtBlock}`);
console.log(`NEXT_PUBLIC_NAME_REGISTRY_ADDRESS=${addrs.NameRegistry}`);
console.log(`NEXT_PUBLIC_ROUTER_ADDRESS=${addrs.Router}`);
console.log(`NEXT_PUBLIC_ERC20_FACTORY_ADDRESS=${addrs.ERC20Factory}`);
console.log(`NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS=${addrs.ERC721AFactory}`);
console.log(`NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS=${addrs.ERC1155Factory}`);
console.log(`NEXT_PUBLIC_CURVE_FACTORY_ADDRESS=${addrs.CurveFactory}`);
console.log(`PONDER_START_BLOCK_${chain.toUpperCase().replace('-', '_')}=${addrs.deployedAtBlock}`);
console.log('------------------------------------------------------------\n');

console.log('Next: restart the indexer + web dev server so they pick up the new addresses.');
