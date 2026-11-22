// scripts/compact-sync-intervals.mjs against a real Postgres (PGlite, the
// same WASM Postgres Ponder uses for local dev; resolved through @ponder/core
// so no new dependency). Every expectation is computed with Ponder 0.7.17's
// own intervalUnion, lifted verbatim from the shipped dist bundle, so
// "compaction gives Ponder the same ranges it would build itself" is checked
// against Ponder's code, not a copy of it.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// @ts-expect-error plain .mjs script, no types
import { compactSyncIntervals } from '../scripts/compact-sync-intervals.mjs';

type Interval = [number, number];

const corePkg = realpathSync(fileURLToPath(new URL('../node_modules/@ponder/core/package.json', import.meta.url)));
const coreRequire = createRequire(corePkg);

const intervalUnion: (i: Interval[]) => Interval[] = (() => {
  const src = readFileSync(new URL('dist/bin/ponder.js', pathToFileURL(corePkg)), 'utf8');
  const start = src.indexOf('function intervalUnion(intervals_) {');
  assert.ok(start >= 0, 'intervalUnion not found in @ponder/core dist; Ponder version changed?');
  const end = src.indexOf('\n}\n', start);
  return new Function(`${src.slice(start, end + 2)}; return intervalUnion;`)();
})();

async function newDb() {
  const { PGlite } = await import(pathToFileURL(coreRequire.resolve('@electric-sql/pglite')).href);
  const db = new PGlite();
  // DDL as in @ponder/core 0.7.17 src/sync-store/migrations.ts (FKs dropped there too).
  await db.exec(`
    CREATE SCHEMA ponder_sync;
    CREATE TABLE ponder_sync."logFilterIntervals" (
      id serial PRIMARY KEY, "logFilterId" text NOT NULL,
      "startBlock" numeric(78,0) NOT NULL, "endBlock" numeric(78,0) NOT NULL);
    CREATE INDEX "logFilterIntervalsLogFilterId" ON ponder_sync."logFilterIntervals" ("logFilterId");
    CREATE TABLE ponder_sync."factoryLogFilterIntervals" (
      id serial PRIMARY KEY, "factoryId" text NOT NULL,
      "startBlock" numeric(78,0) NOT NULL, "endBlock" numeric(78,0) NOT NULL);
    CREATE TABLE ponder_sync."blockFilterIntervals" (
      id serial PRIMARY KEY, "blockFilterId" text NOT NULL,
      "startBlock" numeric(78,0) NOT NULL, "endBlock" numeric(78,0) NOT NULL);
  `);
  const query = async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows as any[];
  return { db, query };
}

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** Rows shaped like realtime sync: mostly back-to-back ranges, plus overlaps, duplicates, gaps, contained ranges. */
function genRows(keys: string[], perKey: number, seed: number) {
  const r = rng(seed);
  const rows: { k: string; s: number; e: number }[] = [];
  for (const k of keys) {
    let cur = 10_682_704 + Math.floor(r() * 1000);
    for (let i = 0; i < perKey; i++) {
      const p = r();
      const len = 1 + Math.floor(r() * 900);
      let s = cur;
      if (p < 0.05) s = cur + 2 + Math.floor(r() * 50); // gap
      else if (p < 0.15) s = Math.max(0, cur - Math.floor(r() * 300)); // overlap
      else if (p < 0.18) s = cur - 1; // touching end exactly
      const e = s + len - 1;
      rows.push({ k, s, e });
      if (p > 0.98) rows.push({ k, s, e }); // duplicate
      if (p > 0.96 && p <= 0.98) rows.push({ k, s: s + 1, e: Math.max(s + 1, e - 1) }); // contained
      cur = Math.max(cur, e + 1);
    }
  }
  // Insert in shuffled order: ids carry no ordering meaning.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  return rows;
}

async function insert(query: any, table: string, key: string, rows: { k: string; s: number; e: number }[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await query(
      `INSERT INTO ponder_sync."${table}" ("${key}", "startBlock", "endBlock")
       SELECT * FROM unnest($1::text[], $2::numeric[], $3::numeric[])`,
      [chunk.map((r) => r.k), chunk.map((r) => r.s), chunk.map((r) => r.e)],
    );
  }
}

async function readByKey(query: any, table: string, key: string) {
  const rows = await query(`SELECT "${key}" AS k, "startBlock" AS s, "endBlock" AS e FROM ponder_sync."${table}" ORDER BY id`);
  const m = new Map<string, Interval[]>();
  for (const r of rows) {
    if (!m.has(r.k)) m.set(r.k, []);
    m.get(r.k)!.push([Number(r.s), Number(r.e)]);
  }
  return m;
}

const sorted = (i: Interval[]) => [...i].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const ponderView = (m: Map<string, Interval[]>) =>
  new Map([...m].map(([k, v]) => [k, intervalUnion(v)] as const));

test('ponder intervalUnion was lifted from dist', () => {
  assert.deepEqual(intervalUnion([[5, 9], [1, 3], [4, 4], [11, 12]]), [[1, 9], [11, 12]]);
});

test('offline: rows become exactly Ponder\'s own union per filter id', async () => {
  const { db, query } = await newDb();
  const keys = Array.from({ length: 6 }, (_, i) => `4663_0xabc${i}_0xtopic_null_null_null_0`);
  await insert(query, 'logFilterIntervals', 'logFilterId', genRows(keys, 3000, 1));
  await insert(query, 'factoryLogFilterIntervals', 'factoryId', genRows(keys.slice(0, 3), 2000, 2));
  // A stale filter that is already compact.
  await insert(query, 'logFilterIntervals', 'logFilterId', [{ k: 'stale', s: 100, e: 200 }]);

  const beforeLog = await readByKey(query, 'logFilterIntervals', 'logFilterId');
  const beforeFac = await readByKey(query, 'factoryLogFilterIntervals', 'factoryId');

  const dry = await compactSyncIntervals({ query, mode: 'dry-run', log: () => {} });
  // dry run wrote nothing
  assert.deepEqual(await readByKey(query, 'logFilterIntervals', 'logFilterId'), beforeLog);

  const res = await compactSyncIntervals({ query, mode: 'offline', log: () => {} });

  const afterLog = await readByKey(query, 'logFilterIntervals', 'logFilterId');
  const afterFac = await readByKey(query, 'factoryLogFilterIntervals', 'factoryId');
  for (const [before, after] of [[beforeLog, afterLog], [beforeFac, afterFac]] as const) {
    const expected = ponderView(before);
    assert.deepEqual([...after.keys()].sort(), [...expected.keys()].sort());
    for (const [k, exp] of expected) {
      // Stored rows ARE the union (not just union-equivalent) ...
      assert.deepEqual(sorted(after.get(k)!), exp, k);
      // ... so Ponder's startup merge has nothing left to do.
      assert.deepEqual(intervalUnion(after.get(k)!), exp, k);
    }
  }
  const lfi = res.find((r: any) => r.table === 'logFilterIntervals');
  assert.equal(lfi.before, [...beforeLog.values()].reduce((a, v) => a + v.length, 0));
  assert.equal(lfi.after, [...ponderView(beforeLog).values()].reduce((a, v) => a + v.length, 0));
  assert.ok(lfi.after < lfi.before / 10, `expected big reduction, got ${lfi.before} -> ${lfi.after}`);
  // dry-run predicted the same counts the apply produced
  assert.deepEqual(
    dry.map((r: any) => [r.table, r.before, r.after]),
    res.map((r: any) => [r.table, r.before, r.after]),
  );
  // block table: empty, untouched, no crash
  assert.equal(res.find((r: any) => r.table === 'blockFilterIntervals').after, 0);

  // Idempotent.
  const again = await compactSyncIntervals({ query, mode: 'offline', log: () => {} });
  for (const r of again) assert.equal(r.before, r.after);
  await db.close();
});

test('online: rows the indexer inserts mid-run survive, union still matches', async () => {
  const { db, query } = await newDb();
  const keys = ['a', 'b', 'c'];
  await insert(query, 'logFilterIntervals', 'logFilterId', genRows(keys, 2000, 3));
  const late = [
    { k: 'a', s: 99_000_000, e: 99_000_100 }, // new realtime range, disjoint
    { k: 'b', s: 1, e: 5 }, // arbitrary
  ];
  const before = await readByKey(query, 'logFilterIntervals', 'logFilterId');
  for (const l of late) before.get(l.k)!.push([l.s, l.e]);

  await compactSyncIntervals({
    query,
    mode: 'online',
    tables: ['logFilterIntervals'],
    log: () => {},
    _hooks: { beforeDelete: () => insert(query, 'logFilterIntervals', 'logFilterId', late) },
  });
  const after = await readByKey(query, 'logFilterIntervals', 'logFilterId');
  for (const l of late) assert.ok(after.get(l.k)!.some(([s, e]) => s === l.s && e === l.e), 'late row kept');
  for (const [k, exp] of ponderView(before)) assert.deepEqual(intervalUnion(after.get(k)!), exp, k);
  await db.close();
});

test('rollback: applies, reports, leaves table unchanged', async () => {
  const { db, query } = await newDb();
  await insert(query, 'logFilterIntervals', 'logFilterId', genRows(['x', 'y'], 1500, 4));
  const before = await readByKey(query, 'logFilterIntervals', 'logFilterId');
  const res = await compactSyncIntervals({ query, mode: 'offline', rollback: true, log: () => {} });
  assert.ok(res[0].after < res[0].before);
  assert.deepEqual(await readByKey(query, 'logFilterIntervals', 'logFilterId'), before);
  await db.close();
});
