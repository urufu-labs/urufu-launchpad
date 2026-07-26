import postgres from 'postgres';

/// One-shot bootstrap script that creates the per-chain indexer_* databases in
/// the shared Railway Postgres. Reads the admin connection string from env so
/// credentials never live in the repo tree - a prior audit found the URL was
/// committed here, which meant anyone with source access owned the DB.
///
/// Usage:
///   DATABASE_ADMIN_URL='postgresql://postgres:...@host:port/railway' \
///     node compile-service/scripts-create-dbs.mjs
const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('missing env DATABASE_ADMIN_URL - refuse to run with hardcoded credentials');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

const dbs = ['indexer_base', 'indexer_mainnet', 'indexer_robinhood', 'indexer_base_sepolia'];

for (const db of dbs) {
  try {
    await sql.unsafe(`CREATE DATABASE ${db}`);
    console.log(`created ${db}`);
  } catch (err) {
    if (err.code === '42P04') {
      console.log(`~ ${db} already exists, skipping`);
    } else {
      console.error(`error ${db}:`, err.message);
    }
  }
}

const rows = await sql`SELECT datname FROM pg_database WHERE datname LIKE 'indexer_%' ORDER BY datname`;
console.log('\n---- indexer_* databases: ----');
rows.forEach((r) => console.log(`  * ${r.datname}`));

await sql.end();
