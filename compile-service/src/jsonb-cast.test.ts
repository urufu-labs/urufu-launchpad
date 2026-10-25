// jsonb writes must be cast ::text::jsonb, never a bare ${json}::jsonb.
//
// With a bare cast, postgres.js describes the statement, sees a jsonb param
// and runs its json serializer (JSON.stringify) over a value we already
// stringified, so the column stores a jsonb *string*. That broke rewards
// proofs (worked around by normalizeProof), market traits, and the
// collection page design (2026-10-24). This scans every source file so a new
// write site can't reintroduce it, and checks each repaired column has its
// idempotent boot repair.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = dirname(fileURLToPath(import.meta.url));

// routes/collection-metadata.ts gets the same fix in PR #40; drop this entry
// once that lands.
const PENDING = new Set(["routes/collection-metadata.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

test("no interpolated param is cast with a bare ::jsonb", () => {
  const bad: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    if (PENDING.has(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\}::jsonb/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], "use ${json}::text::jsonb");
});

test("every jsonb write site uses ::text::jsonb", () => {
  const sites: Array<[string, string]> = [
    ["db.ts", "${proofText}::text::jsonb"],
    ["rewards.ts", "${JSON.stringify(l.proof)}::text::jsonb"],
    ["market-meta.ts", "${JSON.stringify(m.attributes)}::text::jsonb"],
    ["market-store.ts", "${JSON.stringify(l.order)}::text::jsonb"],
    ["routes/nft-wl.ts", "${JSON.stringify(tree.wallets)}::text::jsonb"],
  ];
  for (const [file, needle] of sites) {
    assert.ok(readFileSync(join(SRC, file), "utf8").includes(needle), `${file} missing ${needle}`);
  }
});

test("string-typed rows written before the fix are repaired on boot", () => {
  const repairs: Array<[string, string, string]> = [
    ["db.ts", "app.rewards_leaves", "proof_json"],
    ["market-store.ts", "app.market_listings", "order_json"],
    ["market-store.ts", "app.market_token_meta", "attributes"],
    ["routes/nft-wl.ts", "app.nft_wallet_lists", "wallets"],
  ];
  for (const [file, table, col] of repairs) {
    const text = readFileSync(join(SRC, file), "utf8").replace(/\s+/g, " ");
    const want = `UPDATE ${table} SET ${col} = (${col} #>> '{}')::jsonb WHERE jsonb_typeof(${col}) = 'string'`;
    assert.ok(text.includes(want), `${file} missing repair for ${table}.${col}`);
  }
});
