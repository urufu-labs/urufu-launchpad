#!/usr/bin/env node
// Compact Ponder 0.7's sync-store interval tables (ponder_sync."*Intervals").
//
// Why: Ponder 0.7.17 inserts one row per filter fragment every time realtime
// sync finalizes a range (sync/index.ts -> syncStore.insertInterval), and only
// merges them inside getIntervals(), which runs once per fragment at startup.
// A long-running indexer therefore grows these tables without bound (19.2M +
// 9.6M rows / 7 GB on 2026-11-22) and every restart spends hours in the
// merge loop (it re-sorts the whole fragment 5,000 rows at a time; ~61k
// rows/min measured) before the HTTP server opens.
// See docs/indexer-sync-interval-compaction.md.
//
// What this does: per table, per filter id, replaces all rows with the union
// of their [startBlock, endBlock] ranges, using the same rule as Ponder's
// intervalUnion (utils/interval.ts): ranges merge when they overlap or are
// adjacent (next.start <= current.end + 1). That is exactly what Ponder's own
// startup merge writes back, so Ponder reads the same covered ranges after
// compaction as before; it just has ~250 rows to merge instead of ~29M.
// Filter tables (logFilters, factories, ...), logs, blocks etc. are untouched.
//
// Modes:
//   (default)          Dry run. READ ONLY transaction. Prints before/after row
//                      counts per table. Safe while the indexer runs.
//   --apply --offline  Indexer MUST be stopped. One transaction per table:
//                      LOCK, build merged rows in a temp table, verify every
//                      existing row is covered, TRUNCATE, re-insert, verify.
//                      TRUNCATE frees the disk at commit and writes almost no
//                      WAL (a 29M-row DELETE would write GBs of WAL on a disk
//                      that already filled up once).
//   --apply --online   Safe while the indexer runs. Snapshot M = max(id), merge
//                      only rows with id <= M, DELETE them, insert the merged
//                      rows. Rows the indexer inserts meanwhile get ids > M and
//                      are left alone. No table lock, so the indexer keeps
//                      writing. Dead rows are reclaimed by (auto)vacuum and
//                      reused, not returned to the OS. Meant for a scheduled
//                      job once the tables are small.
//   --rollback         With --apply: do everything, print, then ROLLBACK.
//                      Note --offline --rollback still takes the table lock
//                      for the duration, which blocks a running indexer.
//
// Options: --schema=ponder_sync  --tables=logFilterIntervals,...
//
// Connection: DATABASE_URL (the indexer's own database, e.g. indexer_robinhood).
// The URL is never printed. `pg` is resolved through @ponder/core so this
// script adds no dependency (and no lockfile change).
//
// Examples (from repo root):
//   DATABASE_URL=... node indexer/scripts/compact-sync-intervals.mjs
//   DATABASE_URL=... node indexer/scripts/compact-sync-intervals.mjs --apply --offline
//   DATABASE_URL=... node indexer/scripts/compact-sync-intervals.mjs --apply --online

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Interval tables and the column holding the filter (fragment) id. Same list as Ponder 0.7.17's migrations. */
export const INTERVAL_TABLES = [
  { table: 'logFilterIntervals', key: 'logFilterId' },
  { table: 'factoryLogFilterIntervals', key: 'factoryId' },
  { table: 'blockFilterIntervals', key: 'blockFilterId' },
  { table: 'traceFilterIntervals', key: 'traceFilterId' },
  { table: 'factoryTraceFilterIntervals', key: 'factoryId' },
];

const ident = (s) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`bad identifier: ${s}`);
  return `"${s}"`;
};

/**
 * SELECT producing one row per merged range: (k, s, e).
 * Gaps-and-islands: sort each key's rows by start; a row opens a new island
 * when its start is more than 1 past the max end of all earlier rows of that
 * key. Matches Ponder's intervalUnion (`current[1] >= next[0] - 1` merges).
 */
export function mergedSql(t, key, where = '') {
  const k = ident(key);
  return `
    WITH o AS (
      SELECT ${k} AS k, "startBlock" AS s, "endBlock" AS e,
             max("endBlock") OVER (PARTITION BY ${k} ORDER BY "startBlock", "endBlock"
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS pm
      FROM ${t} ${where}
    ), g AS (
      SELECT k, s, e,
             sum(CASE WHEN pm IS NULL OR s > pm + 1 THEN 1 ELSE 0 END)
               OVER (PARTITION BY k ORDER BY s, e ROWS UNBOUNDED PRECEDING) AS grp
      FROM o
    )
    SELECT k, min(s) AS s, max(e) AS e FROM g GROUP BY k, grp`;
}

/**
 * @param {object} args
 * @param {(sql: string, params?: unknown[]) => Promise<any[]>} args.query  single-connection query fn
 * @param {'dry-run'|'offline'|'online'} args.mode
 * @param {boolean} [args.rollback]
 * @param {string} [args.schema]
 * @param {string[]} [args.tables]
 * @param {(msg: string) => void} [args.log]
 * @param {{ beforeDelete?: (table: string) => Promise<void> }} [args._hooks]  test-only
 */
export async function compactSyncIntervals({
  query,
  mode,
  rollback = false,
  schema = 'ponder_sync',
  tables,
  log = console.log,
  _hooks = {},
}) {
  if (!['dry-run', 'offline', 'online'].includes(mode)) throw new Error(`bad mode ${mode}`);
  const existing = new Set(
    (
      await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema])
    ).map((r) => r.table_name),
  );
  const todo = INTERVAL_TABLES.filter(
    ({ table }) => existing.has(table) && (!tables || tables.includes(table)),
  );
  const results = [];

  for (const { table, key } of todo) {
    const t = `${ident(schema)}.${ident(table)}`;
    const k = ident(key);
    const started = Date.now();

    if (mode === 'dry-run') {
      await query('BEGIN READ ONLY');
      try {
        const [{ n }] = await query(`SELECT count(*)::bigint AS n FROM ${t}`);
        const [{ m }] = await query(`SELECT count(*)::bigint AS m FROM (${mergedSql(t, key)}) x`);
        const r = { table, before: Number(n), after: Number(m), ms: Date.now() - started };
        log(`[dry-run] ${table}: ${r.before} rows -> ${r.after} rows (${r.ms} ms)`);
        results.push(r);
      } finally {
        await query('ROLLBACK');
      }
      continue;
    }

    if (mode === 'online') {
      // Ponder's own startup merge (getIntervals) deletes + re-inserts these
      // rows in 5,000-row transactions. Racing it can't lose coverage (both
      // sides re-insert the union of what they deleted) but can deadlock, and
      // a failed query there may crash the indexer into another long restart.
      // So stay out of its way: skip this table while it is running.
      const busy = await query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
           AND query ILIKE $1`,
        [`%delete from "${schema}"."${table}"%`],
      );
      if (busy[0].n > 0) {
        log(`[online] ${table}: skipped, another session is deleting from it (Ponder startup merge?)`);
        results.push({ table, skipped: true, before: 0, after: 0, ms: Date.now() - started });
        continue;
      }
    }

    await query('BEGIN');
    try {
      // One compactor at a time, ever.
      await query(`SELECT pg_advisory_xact_lock(hashtext('compact-sync-intervals'))`);
      // Never queue behind (or deadlock with) the indexer: give up instead.
      await query(`SET LOCAL lock_timeout = '10s'`);

      // Online: only rows that exist now (id <= snapshot) are merged/deleted.
      let bound = null;
      if (mode === 'offline') {
        // Fails after lock_timeout if the indexer is still running.
        await query(`LOCK TABLE ${t} IN ACCESS EXCLUSIVE MODE`);
      } else {
        const [{ m }] = await query(`SELECT coalesce(max(id), 0)::bigint AS m FROM ${t}`);
        bound = BigInt(m);
      }
      const where = bound === null ? '' : `WHERE id <= ${bound}`;
      const rWhere = bound === null ? 'WHERE' : `WHERE r.id <= ${bound} AND`;

      const [{ n: before }] = await query(`SELECT count(*)::bigint AS n FROM ${t} ${where}`);
      await query(`DROP TABLE IF EXISTS _compact_merged`);
      await query(`CREATE TEMP TABLE _compact_merged ON COMMIT DROP AS ${mergedSql(t, key, where)}`);
      const [{ n: merged }] = await query(`SELECT count(*)::bigint AS n FROM _compact_merged`);

      // Safety 1: every existing row lies inside one merged range of its own key.
      const [{ n: uncovered }] = await query(`
        SELECT count(*)::bigint AS n FROM ${t} r
        ${rWhere} NOT EXISTS (
          SELECT 1 FROM _compact_merged c
          WHERE c.k = r.${k} AND c.s <= r."startBlock" AND r."endBlock" <= c.e)`);
      if (Number(uncovered) !== 0) throw new Error(`${table}: ${uncovered} rows not covered by merged ranges; aborting`);

      // Safety 2: merged ranges are disjoint and non-adjacent (a second merge would change nothing).
      const [{ n: mergeable }] = await query(`
        SELECT count(*)::bigint AS n FROM (
          SELECT s, lag(e) OVER (PARTITION BY k ORDER BY s) AS pe FROM _compact_merged) x
        WHERE pe IS NOT NULL AND s <= pe + 1`);
      if (Number(mergeable) !== 0) throw new Error(`${table}: merged ranges still overlap; aborting`);

      await _hooks.beforeDelete?.(table);
      if (mode === 'offline') await query(`TRUNCATE ${t}`);
      else await query(`DELETE FROM ${t} ${where}`);

      await query(
        `INSERT INTO ${t} (${k}, "startBlock", "endBlock") SELECT k, s, e FROM _compact_merged ORDER BY k, s`,
      );

      const [{ n: after }] = await query(`SELECT count(*)::bigint AS n FROM ${t}`);
      // Safety 3: the table now holds exactly the merged rows (offline), or
      // merged rows + whatever the indexer added after the snapshot (online).
      if (mode === 'offline' && Number(after) !== Number(merged)) {
        throw new Error(`${table}: expected ${merged} rows after insert, found ${after}; aborting`);
      }

      const r = {
        table,
        before: Number(before),
        after: Number(merged),
        totalAfter: Number(after),
        ms: Date.now() - started,
      };
      if (rollback) {
        await query('ROLLBACK');
        log(`[${mode}, rolled back] ${table}: ${r.before} rows -> ${r.after} rows (${r.ms} ms)`);
      } else {
        await query('COMMIT');
        log(`[${mode}] ${table}: ${r.before} rows -> ${r.after} rows (${r.ms} ms)`);
      }
      results.push(r);
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
  return results;
}

function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const val = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const apply = has('--apply');
  const offline = has('--offline');
  const online = has('--online');
  if (apply && offline === online) throw new Error('--apply needs exactly one of --offline or --online');
  if (!apply && (offline || online || has('--rollback'))) throw new Error('--offline/--online/--rollback need --apply');
  return {
    mode: apply ? (offline ? 'offline' : 'online') : 'dry-run',
    rollback: has('--rollback'),
    schema: val('schema') ?? 'ponder_sync',
    tables: val('tables')?.split(','),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const core = realpathSync(fileURLToPath(new URL('../node_modules/@ponder/core/package.json', import.meta.url)));
  const pg = createRequire(core)('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET application_name = 'compact-sync-intervals'`);
    await client.query(`SET statement_timeout = 0`);
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    console.log(`db=${db} mode=${opts.mode}${opts.rollback ? ' (rollback)' : ''} schema=${opts.schema}`);
    const query = async (sql, params) => (await client.query(sql, params)).rows;
    const results = await compactSyncIntervals({ query, ...opts });
    const sum = (f) => results.reduce((a, r) => a + r[f], 0);
    console.log(`total: ${sum('before')} rows -> ${sum('after')} rows`);
    if (opts.mode === 'offline' && !opts.rollback) {
      console.log('done. Disk is freed at commit (TRUNCATE). Start the indexer again.');
    }
    if (opts.mode === 'online' && !opts.rollback) {
      console.log('done. Dead rows are reclaimed by autovacuum; run VACUUM on these tables to speed it up.');
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`compact-sync-intervals: ${err.message}`);
    process.exit(1);
  });
}
