// One-shot DB fix: reassign `rewards_epochs.vault_addr` from the NEW vault
// (0x93CFF459…) to the OLD vault (0x375337c4…) for chain_id=4663.
//
// Context: pre-launch consolidation on 2026-08-12 rerouted the SWAP-fee NFT
// slice from 0x93CFF459 → 0x375337c4 so every fee stream lands in ONE vault
// (the OLD one, which has the pending epoch activating 2026-08-13). But the
// compile-service DB has `rewards_epochs.vault_addr=0x93CFF459` from an earlier
// publish cycle when env pointed there. `rewards.proofFor` filters by
// `vault_addr` and returns null (NOT_ELIGIBLE) unless it matches the env
// vault. This script bumps the vault_addr on the existing tree data so the
// same tree serves proofs against the OLD vault (which is where the pending
// epoch's Merkle root — 0xb7115cb4… — actually lives on-chain).
//
// Run via Railway:
//   railway run --service compile-service node --experimental-strip-types \
//     compile-service/src/fixVaultAddr.ts
//
// Idempotent: re-runs update 0 rows (no matches).

import postgres from 'postgres';

const CHAIN_ID = 4663;
const OLD_VAULT = '0x375337c4c3B85a44948e7D98d7C05256DEFf0eA8'.toLowerCase(); // NEW LIVE TARGET
const STALE_VAULT = '0x93CFF459d5019eEc82fE9335013e265F1eD659c7'.toLowerCase(); // DB rows still say this

const dbUrl = process.env.DATABASE_PRIVATE_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set — run via `railway run`');
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1 });

async function main() {
  // Report current state before touching anything.
  const before = await sql<Array<{ vault_addr: string; n: string }>>`
    SELECT vault_addr, count(*)::text AS n
    FROM app.rewards_epochs
    WHERE chain_id = ${CHAIN_ID}
    GROUP BY vault_addr
  `;
  console.log('rewards_epochs (chain=4663) BEFORE:');
  before.forEach((r) => console.log('  ' + r.vault_addr + ' → ' + r.n + ' rows'));

  const staleRows = before.find((r) => r.vault_addr.toLowerCase() === STALE_VAULT)?.n ?? '0';
  const targetRows = before.find((r) => r.vault_addr.toLowerCase() === OLD_VAULT)?.n ?? '0';
  if (staleRows === '0') {
    console.log('nothing to do — no rows with stale vault_addr');
    process.exit(0);
  }
  if (targetRows !== '0') {
    console.log('WARNING: target vault_addr already has ' + targetRows + ' rows — merging.');
    console.log('  If a (chain, epoch) collision exists, delete stale rows manually first.');
  }

  const updated = await sql`
    UPDATE app.rewards_epochs
    SET vault_addr = ${OLD_VAULT}
    WHERE chain_id = ${CHAIN_ID}
      AND vault_addr = ${STALE_VAULT}
  `;
  console.log('UPDATE rows affected:', updated.count);

  const after = await sql<Array<{ vault_addr: string; n: string }>>`
    SELECT vault_addr, count(*)::text AS n
    FROM app.rewards_epochs
    WHERE chain_id = ${CHAIN_ID}
    GROUP BY vault_addr
  `;
  console.log('rewards_epochs (chain=4663) AFTER:');
  after.forEach((r) => console.log('  ' + r.vault_addr + ' → ' + r.n + ' rows'));

  await sql.end();
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
