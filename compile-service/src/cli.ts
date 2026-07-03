// Small CLI wrapper around the compose() function. Reads a config JSON on stdin (or from an
// argument) and writes the spliced Solidity to the output path.
//
// Run with:
//   node --experimental-strip-types compile-service/src/cli.ts <configPath> <outputPath>
//
// configPath format:
// {
//   "base": "ERC20",
//   "modules": ["AntiBot"],
//   "params": { "AntiBot": { "blockGate": 5 } },
//   "contractName": "ERC20WithAntiBot",
//   "templatePath": "contracts/src/templates/ERC20Template.sol"
// }

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMatrix } from './matrix.ts';
import { compose } from './compile.ts';

const [, , configPath, outputPath] = process.argv;
if (!configPath || !outputPath) {
  process.stderr.write('Usage: cli.ts <configPath> <outputPath>\n');
  process.exit(1);
}

// Repo root is two dirs above this file (compile-service/src → repo root).
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..', '..');

const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
const matrix = loadMatrix(resolve(repoRoot, 'shared/matrix.json'));

const result = compose({
  matrix,
  config: { base: config.base, modules: config.modules, params: config.params ?? {} },
  templatePath: resolve(repoRoot, config.templatePath),
  contractName: config.contractName,
  baseContractName: config.baseContractName,
  repoRoot,
});

mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(resolve(outputPath), result.source);

process.stdout.write(`spliced → ${outputPath}\n`);
process.stdout.write(`  contract: ${result.contractName}\n`);
process.stdout.write(`  modules:  ${result.moduleIds.join(', ')}\n`);
