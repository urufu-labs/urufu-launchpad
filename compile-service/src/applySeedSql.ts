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

// Prefer the PUBLIC URL when running locally (Railway's DATABASE_URL usually
// points at `postgres.railway.internal` which only resolves inside their
// private network; hitting it from a laptop → ENOTFOUND). Inside a Railway
// container this env is absent so we fall through to DATABASE_URL (private
// hostname works there).
const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) {
    process.stderr.write('DATABASE_URL not set (run via `railway run --`)\n');
    process.exit(1);
}
if (url.includes('.railway.internal')) {
    process.stderr.write(
        `warning: DATABASE_URL points at .railway.internal — that hostname only resolves inside\n` +
        `Railway. If this fails with ENOTFOUND, set DATABASE_PUBLIC_URL by enabling "Public\n` +
        `Networking" on the Postgres plugin and rerun.\n`,
    );
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
