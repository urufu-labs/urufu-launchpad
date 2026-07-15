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
}
