// Backfill: reads contracts/tmp/epoch/epoch0.json (built by
// buildEpochTree.ts) and emits SQL that inserts one row into
// app.rewards_epochs + 395 rows into app.rewards_leaves.
//
// Usage:
//   node --experimental-strip-types compile-service/src/seedEpoch.ts \
//     contracts/tmp/epoch/epoch0.json \
//     > contracts/tmp/epoch/seed.sql
//
// Then apply against Railway Postgres:
//   railway run --service=compile-service -- psql < contracts/tmp/epoch/seed.sql
//   (or copy-paste into the Railway Postgres SQL console)
//
// ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
    process.stderr.write('usage: seedEpoch.ts <epochN.json>\n');
    process.exit(1);
}

interface EpochJson {
    chainId: number;
    vaultAddress: string;
    epochId: number;
    merkleRoot: string;
    totalAmount: string;
    holderCount: number;
    leaves: Array<{ holder: string; amount: string; proof: string[] }>;
}

const j = JSON.parse(readFileSync(path, 'utf8')) as EpochJson;

// Escape a bare hex string for insertion as text (no risk of SQL injection here
// because inputs come from our own on-chain reads, but be careful anyway).
function q(s: string): string {
    if (!/^[a-zA-Z0-9x\-_.]+$/.test(s)) throw new Error(`unsafe token: ${s}`);
    return `'${s}'`;
}

process.stdout.write(`-- Backfill epoch ${j.epochId} for chain ${j.chainId}\n`);
process.stdout.write(`-- Vault: ${j.vaultAddress}\n`);
process.stdout.write(`-- Merkle root: ${j.merkleRoot}\n`);
process.stdout.write(`-- Total: ${j.totalAmount} wei\n`);
process.stdout.write(`-- Holders: ${j.holderCount}\n\n`);

process.stdout.write(`BEGIN;\n\n`);

// Epoch row. tx_hash + block_number omitted — schema allows NULL if declared,
// or use placeholders; safest to include them if columns are NOT NULL.
process.stdout.write(`INSERT INTO app.rewards_epochs (\n`);
process.stdout.write(`  chain_id, epoch_id, vault_addr, merkle_root, total_amount, tx_hash, block_number, holder_count\n`);
process.stdout.write(`) VALUES (\n`);
process.stdout.write(`  ${j.chainId},\n`);
process.stdout.write(`  ${j.epochId},\n`);
process.stdout.write(`  ${q(j.vaultAddress.toLowerCase())},\n`);
process.stdout.write(`  ${q(j.merkleRoot)},\n`);
process.stdout.write(`  ${q(j.totalAmount)},\n`);
process.stdout.write(`  ${q('0x_backfilled_offline_broadcast_2026_07_30')},\n`);
process.stdout.write(`  ${q('0')},\n`);
process.stdout.write(`  ${j.holderCount}\n`);
process.stdout.write(`)\n`);
process.stdout.write(`ON CONFLICT (chain_id, epoch_id) DO NOTHING;\n\n`);

// Leaves. Use multi-row INSERT for speed.
process.stdout.write(`INSERT INTO app.rewards_leaves (chain_id, epoch_id, holder, amount, proof_json) VALUES\n`);
for (let i = 0; i < j.leaves.length; i++) {
    const l = j.leaves[i]!;
    const proofJson = JSON.stringify(l.proof); // ["0x...","0x..."]
    // Postgres jsonb literal — single quotes need doubling. But since the
    // JSON contains only hex strings + brackets/commas/quotes, we just wrap
    // in single quotes and escape any inner single quotes (there are none).
    const proofLit = `'${proofJson}'::jsonb`;
    process.stdout.write(
        `  (${j.chainId}, ${j.epochId}, ${q(l.holder.toLowerCase())}, ${q(l.amount)}, ${proofLit})${i === j.leaves.length - 1 ? '\n' : ',\n'}`,
    );
}
process.stdout.write(`ON CONFLICT (chain_id, epoch_id, holder) DO NOTHING;\n\n`);

process.stdout.write(`COMMIT;\n`);
process.stdout.write(`-- Done. ${j.holderCount} leaves + 1 epoch inserted.\n`);
