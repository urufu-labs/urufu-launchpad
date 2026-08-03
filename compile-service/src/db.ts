import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

/// Shared Postgres client. Uses the same DATABASE_URL Railway injects for the indexer's
/// Postgres addon — we live alongside Ponder's `public` schema in an `app` schema so
/// Ponder's migrations never touch our tables (and vice versa).
///
/// Falls back to a no-op DB when DATABASE_URL is unset — makes local dev without a
/// Postgres running possible; the route handlers just refuse writes with a 503.

const RAW_URL = process.env.DATABASE_PRIVATE_URL ?? process.env.DATABASE_URL;

// Singleton — only one pool per process. Fastify hot-reloads with tsx will re-run this
// module and create a new pool per reload, which is fine locally; production is one long
// process.
export const sql = RAW_URL ? postgres(RAW_URL, { max: 5, prepare: false }) : null;

export function hasDb(): boolean {
  return sql !== null;
}

/// One-time schema bootstrap. Idempotent — safe to run on every process start. Uses
/// `IF NOT EXISTS` everywhere so redeploys don't blow up. Lives in an `app` schema
/// so Ponder's `public` schema stays theirs alone.
export async function migrate(): Promise<void> {
  if (!sql) return;
  await sql`CREATE SCHEMA IF NOT EXISTS app`;

  await sql`
    CREATE TABLE IF NOT EXISTS app.token_metadata (
      chain_id     integer     NOT NULL,
      token_address text        NOT NULL,
      image_url    text,
      description  text,
      website      text,
      twitter      text,
      telegram     text,
      discord      text,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      owner        text        NOT NULL,
      PRIMARY KEY (chain_id, token_address)
    )
  `;
  // Additive column migrations — safe to re-run.
  await sql`ALTER TABLE app.token_metadata ADD COLUMN IF NOT EXISTS tiktok text`;
  await sql`ALTER TABLE app.token_metadata ADD COLUMN IF NOT EXISTS wl_list_cid text`;

  await sql`
    CREATE TABLE IF NOT EXISTS app.user_profile (
      address        text        PRIMARY KEY,
      username       text,
      avatar_url     text,
      bio            text,
      twitter        text,
      telegram       text,
      discord        text,
      website        text,
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS tiktok text`;

  await sql`
    CREATE TABLE IF NOT EXISTS app.token_chat (
      id              bigserial   PRIMARY KEY,
      chain_id        integer     NOT NULL,
      token_address   text        NOT NULL,
      sender_address  text        NOT NULL,
      text            text        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS token_chat_token_idx ON app.token_chat (chain_id, token_address, id DESC)`;

  // Flywheel Merkle-drop epochs. `rewards_epochs` is one row per publish (root goes
  // on-chain via NftRevenueVault.addEpoch), `rewards_leaves` is one row per (epoch,
  // holder) — the amount + proof the claim UI reads. Amount stored as text since
  // Postgres numeric would lose precision on wei-scale bigints.
  await sql`
    CREATE TABLE IF NOT EXISTS app.rewards_epochs (
      chain_id     integer     NOT NULL,
      epoch_id     integer     NOT NULL,
      vault_addr   text        NOT NULL,
      merkle_root  text        NOT NULL,
      total_amount text        NOT NULL,
      tx_hash      text        NOT NULL,
      block_number bigint      NOT NULL,
      published_at timestamptz NOT NULL DEFAULT now(),
      holder_count integer     NOT NULL,
      PRIMARY KEY (chain_id, epoch_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS app.rewards_leaves (
      chain_id      integer     NOT NULL,
      epoch_id      integer     NOT NULL,
      holder        text        NOT NULL,
      amount        text        NOT NULL,
      proof_json    jsonb       NOT NULL,
      PRIMARY KEY (chain_id, epoch_id, holder)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS rewards_leaves_holder_idx ON app.rewards_leaves (chain_id, holder, epoch_id DESC)`;

  // URU-A06: durable publication journal. Tree + leaves are committed here
  // BEFORE the on-chain transaction is broadcast so startup reconciliation can
  // recover a tx that confirmed after the process crashed (or a race that
  // pushed us onto a different epoch id than the tree was built for).
  //
  // status enum:
  //   pending    — leaves persisted, tx not yet sent
  //   broadcast  — tx sent, receipt not yet observed
  //   confirmed  — receipt observed, rewards_epochs row inserted
  //   conflict   — on-chain state at this epoch id disagrees with our tree
  //                (a stale publisher landed a different root); requires
  //                manual intervention
  await sql`
    CREATE TABLE IF NOT EXISTS app.rewards_publications (
      chain_id      integer     NOT NULL,
      epoch_id      integer     NOT NULL,
      vault_addr    text        NOT NULL,
      merkle_root   text        NOT NULL,
      total_amount  text        NOT NULL,
      holder_count  integer     NOT NULL,
      status        text        NOT NULL CHECK (status IN ('pending', 'broadcast', 'confirmed', 'conflict')),
      tx_hash       text,
      block_number  bigint,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, epoch_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS rewards_publications_status_idx
    ON app.rewards_publications (chain_id, status, epoch_id)
  `;

  // Auto-backfill: any epoch-N JSON that shipped in contracts/tmp/epoch/ gets
  // seeded on startup if the corresponding (chain_id, epoch_id) row doesn't
  // exist yet. Idempotent — the ON CONFLICT clauses in the insert make re-runs
  // no-ops. Handles the "on-chain broadcast happened out-of-band from the
  // compile-service publishEpoch flow" case so the frontend claim button can
  // serve proofs without a manual psql step.
  //
  // Also handles the reverse: if the compile-service publishes an epoch later
  // (via the keeper or POST /rewards/rh/publish), the pre-seeded row conflicts
  // and stays untouched. Never destructive.
  await _seedShippedEpochs();

  /// Social graph — one row per (follower, followee) edge. Both cols lowercased
  /// so lookups by either direction stay case-insensitive without indexing on
  /// a lower() functional expression. `followed_at` powers "recent followers"
  /// sort on the modal.
  await sql`
    CREATE TABLE IF NOT EXISTS app.follows (
      follower    text        NOT NULL,
      followee    text        NOT NULL,
      followed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (follower, followee)
    )
  `;
  // Reverse-direction lookup index: given a wallet, list everyone following it.
  // The primary key already covers `follower -> list of followees`.
  await sql`CREATE INDEX IF NOT EXISTS follows_followee_idx ON app.follows (followee, followed_at DESC)`;
}

/// Read every `contracts/tmp/epoch/epoch*.json` shipped in the repo and INSERT
/// its rows into app.rewards_epochs + app.rewards_leaves if the epoch isn't
/// already there. Emitted by scripts/tools when an epoch was broadcast
/// out-of-band from publishEpoch(). Ships in the repo so Railway autodeploy
/// backfills automatically — no psql / CLI dance required.
///
/// File shape (produced by compile-service/src/buildEpochTree.ts):
///   {
///     chainId, vaultAddress, epochId, merkleRoot, totalAmount, holderCount,
///     leaves: [{ holder, amount, proof: string[] }, ...]
///   }
///
/// Optional companion metadata file `epoch<N>.meta.json`:
///   { txHash, blockNumber }
/// When present, populated into the epoch row's tx_hash + block_number.
/// When absent, the row is inserted with placeholder values so the NOT NULL
/// constraints hold — downstream reads use merkleRoot/totalAmount from
/// on-chain and don't depend on tx_hash for correctness.
interface EpochJson {
    chainId: number;
    vaultAddress: string;
    epochId: number;
    merkleRoot: string;
    totalAmount: string;
    holderCount: number;
    leaves: Array<{ holder: string; amount: string; proof: string[] }>;
}
interface EpochMeta {
    txHash?: string;
    blockNumber?: number;
}

async function _seedShippedEpochs(): Promise<void> {
    if (!sql) return;
    // db.ts sits at compile-service/src/db.ts — walk up 2 dirs to repo root.
    const here = dirname(fileURLToPath(import.meta.url));
    const epochDir = resolve(here, '..', '..', 'contracts', 'tmp', 'epoch');
    if (!existsSync(epochDir)) return;
    // Scan for any epoch*.json (skip .meta.json variants).
    // Ship-time convention: `epoch0.json`, `epoch1.json`, …
    // Handle up to 64 shipped epochs — larger will just need a bigger cap here.
    for (let i = 0; i < 64; i++) {
        const file = resolve(epochDir, `epoch${i}.json`);
        if (!existsSync(file)) continue;
        let raw: string;
        try {
            raw = readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        let j: EpochJson;
        try {
            j = JSON.parse(raw) as EpochJson;
        } catch (err) {
            console.log(JSON.stringify({ seed: 'skip-parse-fail', file, err: (err as Error).message }));
            continue;
        }
        const existing = await sql<Array<{ n: string }>>`
            SELECT count(*)::text AS n FROM app.rewards_epochs
            WHERE chain_id = ${j.chainId} AND epoch_id = ${j.epochId}
        `;
        if (Number(existing[0]?.n ?? 0) > 0) continue; // already seeded — skip.

        // Companion .meta.json (optional).
        let meta: EpochMeta = {};
        const metaFile = resolve(epochDir, `epoch${i}.meta.json`);
        if (existsSync(metaFile)) {
            try {
                meta = JSON.parse(readFileSync(metaFile, 'utf8')) as EpochMeta;
            } catch {
                /* ignore */
            }
        }

        console.log(JSON.stringify({ seed: 'apply', chainId: j.chainId, epochId: j.epochId, holders: j.leaves.length }));
        try {
            await sql.begin(async (tx) => {
                await tx`
                    INSERT INTO app.rewards_epochs (
                      chain_id, epoch_id, vault_addr, merkle_root, total_amount,
                      tx_hash, block_number, holder_count
                    ) VALUES (
                      ${j.chainId}, ${j.epochId}, ${j.vaultAddress.toLowerCase()},
                      ${j.merkleRoot}, ${j.totalAmount},
                      ${meta.txHash ?? '0x_backfilled_shipped_json'},
                      ${meta.blockNumber ?? 0}, ${j.leaves.length}
                    )
                    ON CONFLICT (chain_id, epoch_id) DO NOTHING
                `;
                for (const l of j.leaves) {
                    // JSON.stringify + ::jsonb cast: postgres receives a text
                    // param whose value happens to be valid JSON, then the cast
                    // parses it into a real jsonb array (not a jsonb string).
                    // Round-trip on read → real JS array via postgres.js default
                    // jsonb parsing. The client also normalizes defensively —
                    // see web/src/lib/rewardsApi.ts::normalizeProof.
                    const proofText = JSON.stringify(l.proof);
                    await tx`
                        INSERT INTO app.rewards_leaves (chain_id, epoch_id, holder, amount, proof_json)
                        VALUES (
                          ${j.chainId}, ${j.epochId}, ${l.holder.toLowerCase()},
                          ${l.amount}, ${proofText}::jsonb
                        )
                        ON CONFLICT (chain_id, epoch_id, holder) DO NOTHING
                    `;
                }
            });
            console.log(JSON.stringify({ seed: 'done', chainId: j.chainId, epochId: j.epochId }));
        } catch (err) {
            console.log(JSON.stringify({ seed: 'fail', chainId: j.chainId, epochId: j.epochId, err: (err as Error).message }));
        }
    }
}
