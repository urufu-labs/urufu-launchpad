# Indexer sync-store interval tables: compaction + plan

Measured 2026-11-22 (read-only) on `indexer_robinhood` (Ponder 0.7.17):

| table | rows | size | rows after merging per filter id |
|---|---|---|---|
| `ponder_sync."logFilterIntervals"` | 19,241,977 | 4.26 GB | 162 |
| `ponder_sync."factoryLogFilterIntervals"` | 9,558,395 | 2.72 GB | 88 |
| `ponder_sync."blockFilterIntervals"` | 8 | 208 kB | 1 |

The real indexed data is ~0.5 GB. 38 of 150 log filters and 18 of 81 factory filters are active, and each one holds 529,909 rows.

## Why it grows

- `sync/index.ts`: every time realtime sync finalizes a range, it calls `syncStore.insertInterval` once per source. That inserts one row per filter fragment. The median row covers 31 blocks (about 3 s on Robinhood).
- Measured rate: about 30.7k rows/day per active filter. With 56 active filters that's ~1.7M rows/day, or ~400 MB/day.
- Rows only get merged in `getIntervals` (`sync-store/index.ts:404-469`), which runs once per fragment **at startup**.
- That merge loop deletes the first 5,000 rows by `startBlock` (`syncStoreMaxIntervals`), unions them, and re-inserts the result. Each pass re-sorts the whole fragment, because the only index is on the filter id.
- Observed on 2026-11-22 01:27-01:51 UTC: ~61k rows/min. At that rate 29M rows take **about 8 hours** before the HTTP server opens.

## Is offline compaction safe? Yes

- Ponder reads intervals as `intervalUnion(rows of the fragment)` (`utils/interval.ts`). Ranges merge when `next.start <= cur.end + 1`.
- Its own startup merge replaces a fragment's rows with exactly that union.
- `scripts/compact-sync-intervals.mjs` does the same thing per filter id in one transaction per table, using gaps-and-islands SQL. It only touches the `*Intervals` tables. Filter tables, logs, blocks and app tables are untouched.
- Before it writes, it checks:
  1. every existing row lies inside a merged range of its own id;
  2. the merged ranges are disjoint and non-adjacent;
  3. the row count after insert equals the merged count.
- If any check fails, the transaction rolls back.

### Evidence

- `indexer/test/compact-sync-intervals.test.ts` runs on PGlite against randomized data with overlaps, adjacency, duplicates, contained ranges and gaps. Expected values come from Ponder's **own** `intervalUnion`, lifted from the installed `@ponder/core` dist. Covered:
  - offline mode
  - online mode with rows inserted mid-run
  - rollback
  - dry run writes nothing
  - idempotency
- Mutating the merge rule (dropping the `+ 1` adjacency) fails 3 of 4 tests.
- **Copy of real prod data:** all 1,589,727 rows of 3 of the busiest filters (2 log, 1 factory) were copied read-only into PGlite and compacted offline. Result: 1,059,818 → 3 and 529,909 → 1. Byte-identical to Ponder's `intervalUnion` on the same rows. Time was 3.6 s + 2.1 s.
- Real script, dry run against prod (read only): `blockFilterIntervals: 8 rows -> 1 rows`. For the big tables, the same SQL gave the numbers in the table above, read-only.

## Runbook (needs the owner's go-ahead: it writes to prod)

1. Stop `indexer-robinhood` on Railway. With the indexer stopped, nothing else writes these tables. Downtime starts here, but the indexer is already down while it sits in the startup merge.
2. Dry run first, then apply, from the repo root of a checkout with `pnpm install` done. Set `DATABASE_URL` to the Postgres public URL with the db name `indexer_robinhood`, and never paste it anywhere.
   ```
   node indexer/scripts/compact-sync-intervals.mjs
   node indexer/scripts/compact-sync-intervals.mjs --apply --offline
   ```
   Expect a few minutes for the 7 GB scan. `TRUNCATE` hands the ~7 GB back to the OS at commit and writes almost no WAL.
3. Start the indexer. The startup merge now has ~250 rows to merge, so expect a normal ~2 min start.

Offline mode takes `ACCESS EXCLUSIVE` on each table with a 10 s `lock_timeout`, so it refuses to run alongside an active indexer.

## Keeping it small: options

| option | effect | cost / risk |
|---|---|---|
| **Scheduled `--online` compaction, hourly (recommended now)** | Tables stay at ~1 h of rows (~70k). Restarts stay fast. No restart needed to run it. | Small code in `compile-service/src/keeper.ts`, next to its hourly loops, plus one new Railway var on compile-service pointing at `indexer_robinhood` (`application_name = 'compact-sync-intervals'` in logs). Depends on Ponder 0.7 internal table names, which are pinned by the lockfile. Online mode merges only rows with `id <=` a snapshot, so realtime inserts are never touched. It skips a table while Ponder's startup merge is deleting from it, and uses `lock_timeout` so it never queues behind the indexer. Dead rows are reused after autovacuum. |
| **Upgrade to Ponder 0.8+** (package renamed `ponder`, latest 0.18.9) | Fixed by design. From 0.8 there is one `ponder_sync.intervals` row per fragment (`nummultirange`), unioned on insert (`ON CONFLICT ... blocks + excluded.blocks`). The 0.8 migration (`2024_11_09_0_adjacent_interval`) `range_agg`s the old tables, so the sync cache carries over (no re-fetch from RPC). | A real upgrade project: package rename, 0.8 API changes in `ponder.config.ts` / `src/*` / schema, a full app-table reindex from cache, and rework of `scripts/ponder-internals.mjs` and the replay scripts that patch the 0.7 dist. Run the offline compaction first, so the migration's `range_agg` runs on ~250 rows instead of 29M. |
| Ponder config change | None available. `syncStoreMaxIntervals` is an internal option, not config. A longer `pollingInterval` only slows growth. `disableCache` prunes the whole cache every start, which means a full re-sync. | n/a |

**Recommendation:** run the offline compaction once now, add the hourly online job, and schedule the 0.8+ upgrade as its own task. The upgrade is the real fix, and once it lands the hourly job is no longer needed.

## Reclaimable space (safe to drop)

Checked against `indexer/ponder.config.ts`: chains come from `INDEXER_CHAINS` + `<PREFIX>_RPC_URL`, and the DB comes from `DATABASE_URL`. Railway shows:

- `indexer-robinhood`: `INDEXER_CHAINS=robinhood`, `DATABASE_URL -> /indexer_robinhood`
- `compile-service`: `DATABASE_URL -> /railway`
- `keeper`: no DB URL

`pg_stat_database` shows zero tuples inserted or updated since the cluster's stats began, and no connections, for:

| db | size | contents |
|---|---|---|
| `indexer_base` | 347 MB | ponder_sync 323 MB + 115 app tables (legacy Base indexer) |
| `indexer_base_sepolia` | 41 MB | ponder_sync 17 MB + app tables |
| `indexer_mainnet` | 17 MB | small |

Together that's ~405 MB. All of it is re-derivable from chain. Only `DEPLOY.md` and `compile-service/scripts-create-dbs.mjs` (which creates them) mention these names.

To drop them (owner's call, irreversible):

```sql
DROP DATABASE indexer_base;
DROP DATABASE indexer_base_sepolia;
DROP DATABASE indexer_mainnet;
```

Also: after Ponder's own startup merge finishes, or after any big `DELETE`, the table files keep their size until `VACUUM FULL` or the offline `TRUNCATE` path runs. The offline mode avoids that.
