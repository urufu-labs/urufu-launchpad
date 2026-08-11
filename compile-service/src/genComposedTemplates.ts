// Regenerate the pre-baked composed .sol templates under
// contracts/src/templates/composed/ via the same splicer the compile-service
// uses at runtime. Foundry tests exercise these on-disk files so they stay
// byte-equivalent to whatever /compile hands users at runtime.
//
// Run from repo root:
//   node --experimental-strip-types compile-service/src/genComposedTemplates.ts
//
// Regenerates the 10 valid 2-module pair combos from
// {AntiBot, AntiWhale, Permit, Votes, Staking, Vesting}.
//
// Skipped pairs (intentional):
//   Staking + Vesting  matrix.json declares Staking.incompatibleWith
//                        includes "Vesting"; validateConfig would reject.

import { basename, dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadMatrix } from './matrix.ts';
import { compose } from './compile.ts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'shared/matrix.json');
const OUT_DIR = resolve(REPO_ROOT, 'contracts/src/templates/composed');

function fileNameFor(sortedModules: string[]): string {
  return `ERC20With${sortedModules.join('')}Gen.sol`;
}
function contractNameFor(sortedModules: string[]): string {
  return `ERC20With${sortedModules.join('')}Gen`;
}

interface Pair {
  a: string;
  b: string;
}
const PAIRS: Pair[] = [
  { a: 'AntiBot', b: 'Staking' },
  { a: 'AntiBot', b: 'Vesting' },
  { a: 'AntiBot', b: 'Votes' },
  { a: 'AntiWhale', b: 'Permit' },
  { a: 'AntiWhale', b: 'Staking' },
  { a: 'AntiWhale', b: 'Vesting' },
  { a: 'AntiWhale', b: 'Votes' },
  { a: 'Permit', b: 'Votes' },
  { a: 'Staking', b: 'Votes' },
  { a: 'Vesting', b: 'Votes' },
];

const matrix = loadMatrix(MATRIX_PATH);
mkdirSync(OUT_DIR, { recursive: true });

for (const { a, b } of PAIRS) {
  const modules = [a, b].sort();
  const votesInSet = modules.includes('Votes');
  const votesOverride = matrix.modules.Votes?.templateOverride;
  const templatePath =
    votesInSet && votesOverride
      ? resolve(REPO_ROOT, votesOverride)
      : resolve(REPO_ROOT, 'contracts/src/templates/ERC20Template.sol');
  const baseContractName = basename(templatePath, '.sol');

  // Schema-valid dummy params so validateConfig doesn't reject at compose
  // time; these never appear in generated Solidity.
  const params: Record<string, Record<string, unknown>> = {};
  for (const mid of modules) {
    if (mid === 'AntiBot') params[mid] = { blockGate: 3 };
    else if (mid === 'AntiWhale')
      params[mid] = {
        maxWallet: '800000000000000000000000000',
        maxTx: '800000000000000000000000000',
        expireAfterBlocks: 0,
      };
    else if (mid === 'Staking')
      params[mid] = {
        rewardsTotal: '50000000000000000000000000',
        durationSeconds: 90 * 24 * 60 * 60,
      };
    else if (mid === 'Vesting')
      params[mid] = {
        beneficiary: '0x0000000000000000000000000000000000000001',
        totalAmount: '100000000000000000000000000',
        cliffTimestamp: 100,
        endTimestamp: 200,
      };
    else if (mid === 'Permit') params[mid] = {};
    else if (mid === 'Votes') params[mid] = {};
    else throw new Error(`no dummy params for ${mid}`);
  }

  const composed = compose({
    matrix,
    config: { base: 'ERC20', modules, params },
    templatePath,
    contractName: contractNameFor(modules),
    baseContractName,
    repoRoot: REPO_ROOT,
  });

  const outPath = resolve(OUT_DIR, fileNameFor(modules));
  writeFileSync(outPath, composed.source, 'utf8');
  process.stdout.write(`wrote ${fileNameFor(modules)}  (${composed.source.length} bytes)\n`);
}

process.stdout.write('done\n');
