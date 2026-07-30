// Apply a SQL file against DATABASE_URL. Wraps the file's contents in
// postgres.js unsafe() so the pre-baked BEGIN/COMMIT + multi-statement
// INSERTs execute as a single transaction.
//
// Run:
//   railway link           # link to compile-service (once)
//   railway run -- node --experimental-strip-types compile-service/src/applySeedSql.ts contracts/tmp/epoch/seed.sql

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const path = process.argv[2];
if (!path) {
    process.stderr.write('usage: applySeedSql.ts <file.sql>\n');
    process.exit(1);
}

const url = process.env.DATABASE_PRIVATE_URL ?? process.env.DATABASE_URL;
if (!url) {
    process.stderr.write('DATABASE_URL not set (run via `railway run --`)\n');
    process.exit(1);
}

const body = readFileSync(path, 'utf8');
process.stderr.write(`applying ${path} (${body.length} bytes)…\n`);

const sql = postgres(url, {
    connect_timeout: 30,
    idle_timeout: 5,
    max: 1,
});

try {
    const started = Date.now();
    await sql.unsafe(body);
    process.stderr.write(`ok — took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    // Sanity: count what landed for chain 4663 epoch 0.
    const epoch = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM app.rewards_epochs WHERE chain_id = 4663 AND epoch_id = 0`;
    const leaves = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM app.rewards_leaves WHERE chain_id = 4663 AND epoch_id = 0`;
    process.stderr.write(`epoch rows: ${epoch[0]?.n ?? '?'} (expect 1)\n`);
    process.stderr.write(`leaf rows:  ${leaves[0]?.n ?? '?'} (expect 395)\n`);
} finally {
    await sql.end({ timeout: 5 });
}
