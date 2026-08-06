// GH-13 schema smoke tests. Verifies the poolPolicy table + the requested*
// field addition to launches are correctly registered with Ponder's
// drizzle-orm layer. This catches the class of bug where a column is declared
// in ponder.schema.ts but a subtle syntax error means Ponder never actually
// generates the DB column (Ponder's build swallows schema-file exceptions
// into a delayed "unknown table" runtime error).
//
// Runs standalone via `node --experimental-strip-types --test src/schema.test.ts`
// — no Ponder build, no db. We introspect the drizzle-orm table objects
// directly via their well-known Symbol.for("drizzle:*") accessors so we don't
// need drizzle-orm as an indexer/ devDep — drizzle is a transitive dep of
// @ponder/core and pnpm's flat layout doesn't expose transitive deps to the
// workspace root's node_modules resolver.

import assert from 'node:assert/strict';
import test from 'node:test';

import { launches, poolPolicy, graduations } from '../ponder.schema.ts';
// (moved from src/*.test.ts to test/*.test.ts so Ponder's indexing-function
// glob at `src/**/*.{js,mjs,ts,mts}` doesn't pick these up at build time.)

// Drizzle stores private state on well-known symbols so the public API doesn't
// clash with user-defined columns. Same values as
// `Symbol.for("drizzle:Name")` / `Symbol.for("drizzle:Columns")` inside the
// drizzle-orm source (see node_modules/.../drizzle-orm/table.utils.js).
const NAME = Symbol.for('drizzle:Name');
const COLUMNS = Symbol.for('drizzle:Columns');

type Col = {
  primary?: boolean;
  notNull: boolean;
  hasDefault: boolean;
  default?: unknown;
  dataType: string;
  columnType: string;
};

function tableName(t: unknown): string {
  const raw = (t as Record<symbol, string | undefined>)[NAME];
  assert.ok(raw, 'drizzle:Name symbol missing on table object');
  return raw;
}

function tableColumns(t: unknown): Record<string, Col> {
  const raw = (t as Record<symbol, unknown>)[COLUMNS] as Record<string, Col> | undefined;
  assert.ok(raw, 'drizzle:Columns symbol missing on table object');
  return raw;
}

function col(cols: Record<string, Col>, name: string): Col {
  const c = cols[name];
  assert.ok(c, `expected column ${name} to exist`);
  return c;
}

// ============================================================================
// poolPolicy table — every field named in GH-13's spec must exist with the
// correct type category.
// ============================================================================

test('poolPolicy table registered with the correct name', () => {
  assert.equal(tableName(poolPolicy), 'pool_policy');
});

test('poolPolicy table exposes every GH-13 field', () => {
  const cols = tableColumns(poolPolicy);
  const expected = [
    'id',
    'chainId',
    'poolId',
    'hookAddress',
    'antiSniperBlocks',
    'buybackBurnBps',
    'platformFeeBps',
    'creatorFeeBps',
    'creatorRecipient',
    'launchBlock',
    'immutableAfterLaunch',
    'emittedAtBlock',
    'emittedAtTxHash',
  ];
  for (const name of expected) {
    assert.ok(name in cols, `missing column: ${name}`);
  }
});

test('poolPolicy column types match on-chain widths', () => {
  const cols = tableColumns(poolPolicy);
  // Drizzle-pg column dataTypes we care about — mapped from onchainTable
  // builders. integer → number, bigint → bigint, text → string, boolean →
  // boolean. Ponder's `t.hex()` is a custom column (dataType='custom').
  assert.equal(col(cols, 'id').dataType, 'string');
  assert.equal(col(cols, 'chainId').dataType, 'number');
  assert.equal(col(cols, 'antiSniperBlocks').dataType, 'number');
  assert.equal(col(cols, 'buybackBurnBps').dataType, 'number');
  assert.equal(col(cols, 'platformFeeBps').dataType, 'number');
  assert.equal(col(cols, 'creatorFeeBps').dataType, 'number');
  // launchBlock is uint64 on-chain, indexed as bigint here.
  assert.equal(col(cols, 'launchBlock').dataType, 'bigint');
  assert.equal(col(cols, 'emittedAtBlock').dataType, 'bigint');
  assert.equal(col(cols, 'immutableAfterLaunch').dataType, 'boolean');
  const hexOk = ['custom', 'string', 'buffer'];
  assert.ok(
    hexOk.includes(col(cols, 'poolId').dataType),
    `poolId dataType=${col(cols, 'poolId').dataType} — expected hex/custom`,
  );
  assert.ok(hexOk.includes(col(cols, 'hookAddress').dataType));
  assert.ok(hexOk.includes(col(cols, 'creatorRecipient').dataType));
  assert.ok(hexOk.includes(col(cols, 'emittedAtTxHash').dataType));
});

test('poolPolicy.id is the primary key', () => {
  const cols = tableColumns(poolPolicy);
  assert.equal(col(cols, 'id').primary, true, 'id must be primary key');
});

test('poolPolicy every non-nullable column is notNull (matches on-chain struct — always populated)', () => {
  const cols = tableColumns(poolPolicy);
  for (const [name, col] of Object.entries(cols)) {
    assert.equal(col.notNull, true, `${name} must be notNull`);
  }
});

// ============================================================================
// launches table — new requestedHook / requestedGovernance columns must exist
// alongside the legacy installedHook / installedGovernance.
// ============================================================================

test('launches table has both requested* and legacy installed* pair', () => {
  const cols = tableColumns(launches);
  assert.ok('installedHook' in cols, 'legacy installedHook kept for backward compat');
  assert.ok('installedGovernance' in cols, 'legacy installedGovernance kept');
  assert.ok('requestedHook' in cols, 'GH-13 requestedHook added');
  assert.ok('requestedGovernance' in cols, 'GH-13 requestedGovernance added');
});

test('launches.requestedHook / requestedGovernance default to false for legacy rows', () => {
  const cols = tableColumns(launches);
  const rh = col(cols, 'requestedHook');
  const rg = col(cols, 'requestedGovernance');
  assert.equal(rh.hasDefault, true, 'must default so old rows do not violate notNull');
  assert.equal(rh.default, false);
  assert.equal(rg.hasDefault, true);
  assert.equal(rg.default, false);
});

// ============================================================================
// Sanity: graduations still exposes poolId (the join target for poolPolicy).
// ============================================================================

test('graduations.poolId column still exists (poolPolicy join target)', () => {
  const cols = tableColumns(graduations);
  assert.ok('poolId' in cols, 'graduations.poolId is the join key for poolPolicy');
});
