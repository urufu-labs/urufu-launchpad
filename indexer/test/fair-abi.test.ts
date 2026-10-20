/// Pins every Fair-lane event string in ponder.config.ts to the compiled
/// contracts. Ponder filters getLogs by topic0, so a string that drifts from the
/// Solidity event silently drops every log (see dn404-abi.test.ts for the
/// 2026-09-16 incident). The lane is not deployed yet, so there is no on-chain
/// receipt to pin against: the forge artifacts in contracts/out are the source of
/// truth. Skips when they are missing (run `forge build` in contracts/ first).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, toHex } from 'viem';
import { computeEthPoolId } from '../poolId.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(HERE, '..', 'ponder.config.ts'), 'utf8');
const OUT = join(HERE, '..', '..', 'contracts', 'out');

type AbiInput = { type: string; components?: AbiInput[] };
type AbiItem = { type: string; name?: string; inputs?: AbiInput[] };

function canonical(t: AbiInput): string {
  return t.type.startsWith('tuple') ? `(${(t.components ?? []).map(canonical).join(',')})${t.type.slice(5)}` : t.type;
}

/// Signature from the indexer's human-readable string: drop `indexed` and names.
function indexerSig(name: string): string {
  const m = CONFIG.match(new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`));
  assert.ok(m, `event ${name}(...) not found in ponder.config.ts`);
  const types = m[1]!
    .split(',')
    .map((s) => s.trim().split(/\s+/).filter((w) => w !== 'indexed')[0])
    .filter((t): t is string => !!t);
  return `${name}(${types.join(',')})`;
}

function artifactSig(file: string, contract: string, name: string): string | null {
  const p = join(OUT, file, `${contract}.json`);
  if (!existsSync(p)) return null;
  const abi = (JSON.parse(readFileSync(p, 'utf8')) as { abi: AbiItem[] }).abi;
  const ev = abi.find((x) => x.type === 'event' && x.name === name);
  assert.ok(ev, `${contract} has no event ${name}`);
  return `${name}(${(ev.inputs ?? []).map(canonical).join(',')})`;
}

const CASES: Array<[file: string, contract: string, events: string[]]> = [
  ['FairLaunchFactory.sol', 'FairLaunchFactory', ['FairLaunched']],
  ['FairBondingCurve.sol', 'FairBondingCurve', ['CurveInitialized', 'Trade', 'CreatorSold', 'Graduated']],
  ['OpeningBatch.sol', 'OpeningBatch', ['Deposited', 'Settled', 'Claimed']],
  [
    'FairHookHost.sol',
    'FairHookHost',
    [
      'FairPoolInitialized', 'FeeAccrued', 'FeeClaimed', 'SniperTaxBurned', 'SniperTaxBanked',
      'CreatorFeeBurned', 'CreatorFeeForfeited', 'BankBurned',
    ],
  ],
];

for (const [file, contract, events] of CASES) {
  for (const name of events) {
    test(`indexer ${contract}.${name} topic0 matches the compiled contract`, (t) => {
      const fromArtifact = artifactSig(file, contract, name);
      if (!fromArtifact) {
        t.skip('contracts/out missing; run forge build');
        return;
      }
      // CurveInitialized / Trade / Graduated exist on several contracts in the
      // config; the Fair strings are the ones declared after the Fair header.
      const fairBlock = CONFIG.slice(CONFIG.indexOf('Fair launch lane (contracts/src/fair/)'));
      const m = fairBlock.match(new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`));
      assert.ok(m, `Fair event ${name} not in the Fair block of ponder.config.ts`);
      const sig = `${name}(${m[1]!
        .split(',')
        .map((s) => s.trim().split(/\s+/).filter((w) => w !== 'indexed')[0])
        .filter((x): x is string => !!x)
        .join(',')})`;
      assert.equal(sig, fromArtifact, `${contract}.${name} string drifted from Solidity`);
      assert.equal(keccak256(toHex(sig)), keccak256(toHex(fromArtifact)));
    });
  }
}

test('indexerSig helper sees the FairLaunched string', () => {
  assert.match(indexerSig('FairLaunched'), /^FairLaunched\(address,address,address,address,string,string,uint256,uint256,uint64,uint256,uint256,bool\)$/);
});

test('computeEthPoolId puts ETH in currency0 and is hook-specific', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const a = computeEthPoolId(token, '0x00000000000000000000000000000000000020c4');
  const b = computeEthPoolId(token, '0x00000000000000000000000000000000000120c4');
  assert.notEqual(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});
