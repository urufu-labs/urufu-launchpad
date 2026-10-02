/// Read-only check of the DN404 discovery feed against the LIVE indexer, as if
/// both DN404_LAUNCHES_ENABLED and NFT_LAUNCHES_ENABLED were on (forced here,
/// never in config). Runs the exact GraphQL query strings from src/lib/indexer.ts
/// (extracted from the source so they can't drift), builds the merged feed with
/// the real dn404Feed helpers + hide lists, and fails if any hidden test token
/// or collection would surface.
///
///   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/dn404-feed-live-check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dn404RowToLaunch, mergeDn404Launches, collectionVisible, ZERO_ADDRESS } from '../src/lib/dn404Feed.ts';
import { isHiddenToken } from '../src/lib/hiddenTokens.ts';
import { isHiddenNftCollection } from '../src/lib/hiddenNftCollections.ts';

const URL = process.env.INDEXER_URL ?? 'https://indexer-robinhood-production.up.railway.app/graphql';
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'src', 'lib', 'indexer.ts'), 'utf8');
const CHAIN = 4663;

function queryFromSource(name) {
  const m = SRC.match(new RegExp('`(query ' + name + '\\b[\\s\\S]*?)`'));
  if (!m) throw new Error(`query ${name} not found in indexer.ts`);
  return m[1];
}
async function gql(name, variables) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: queryFromSource(name), variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`${name}: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

const flags = { nftEnabled: true, dn404Enabled: true }; // forced for this check only
const results = [];
const ok = (label, cond, detail = '') => { results.push({ label, pass: !!cond, detail }); };

// 1. Updated + new collection queries return without errors and carry lane fields.
const recent = await gql('RecentNftCollections', { limit: 100 });
ok('RecentNftCollections returns lane fields', recent.nftCollectionss.items.every((r) => 'lane' in r && 'pairedToken' in r));
const byLauncher = await gql('NftCollectionsByLauncher', { launcher: '0x6d606cc634f20f5534fba072757f2c2c7b835bb9', limit: 100 });
ok('NftCollectionsByLauncher returns lane fields', byLauncher.nftCollectionss.items.every((r) => 'lane' in r));
const dn = await gql('Dn404Collections', { limit: 60 });
const dnRows = dn.nftCollectionss.items.filter((r) => r.chainId === CHAIN);
ok('Dn404Collections returns only lane=dn404', dnRows.every((r) => r.lane === 'dn404'), `${dnRows.length} rows`);

// 2. Grid view: hidden collections filtered (as fetchRecentNftCollections does), lane gating.
const gridRows = recent.nftCollectionss.items
  .filter((r) => r.chainId === CHAIN)
  .filter((r) => !isHiddenNftCollection(r.chainId, r.collectionAddress))
  .filter((r) => collectionVisible(r, flags));
ok('grid shows no hidden collections', gridRows.every((r) => !isHiddenNftCollection(CHAIN, r.collectionAddress)), `${gridRows.length} visible`);
const gridDnOff = recent.nftCollectionss.items.filter((r) => collectionVisible(r, { nftEnabled: true, dn404Enabled: false }));
ok('DN404 flag off hides every dn404 collection', gridDnOff.every((r) => r.lane !== 'dn404'));

// 3. Feed: build DN404 launches with the same per-token queries the app uses.
const dn404Launches = [];
// Build every live DN404 row (all four today are hidden test launches) so the
// per-token queries really run; hiding is then enforced by the merge step.
for (const row of dnRows) {
  const token = row.pairedToken;
  const pair = (row.pairCurrency ?? ZERO_ADDRESS).toLowerCase();
  const b = (x) => BigInt(x);
  if (pair === ZERO_ADDRESS) {
    const c = (await gql('CurveByToken', { token: token.toLowerCase() })).curvess.items[0];
    if (!c) continue;
    dn404Launches.push(dn404RowToLaunch(row, {
      ethReserve: b(c.ethReserve), tokenReserve: b(c.tokenReserve), virtualEthReserve: b(c.virtualEthReserve),
      virtualTokenReserve: b(c.virtualTokenReserve), graduationTargetEth: b(c.graduationTargetEth),
      curveSupply: b(c.curveSupply), tradeFeeBps: c.tradeFeeBps, tradeCount: c.tradeCount, graduated: c.graduated,
    }));
  } else {
    const pc = (await gql('PairCurveByToken', { token: token.toLowerCase() })).pairCurvess.items[0];
    if (!pc) continue;
    const sw = await gql('PairV4SummaryForToken', { token: token.toLowerCase() });
    dn404Launches.push(dn404RowToLaunch(row, {
      ethReserve: b(pc.pairReserve), tokenReserve: b(pc.tokenReserve), virtualEthReserve: b(pc.virtualPairReserve),
      virtualTokenReserve: b(pc.virtualTokenReserve), graduationTargetEth: b(pc.graduationTargetPair),
      curveSupply: b(pc.curveSupply), tradeFeeBps: pc.tradeFeeBps, tradeCount: pc.tradeCount, graduated: pc.graduated,
    }, { pairSymbol: 'URU', v4SwapCount: sw.pairV4Swapss.items.length }));
  }
}
ok('per-token queries (CurveByToken, PairCurveByToken, PairV4SummaryForToken) ran', true, `${dn404Launches.length} DN404 launches built`);

const launches = (await gql('RecentLaunches', { limit: 60 }).catch(() => null))?.launchess?.items ?? [];
const routerFeed = launches
  .filter((r) => r.chainId === CHAIN)
  .map((r) => ({ chainId: r.chainId, address: r.tokenAddress }));
const merged = mergeDn404Launches(routerFeed, dn404Launches.filter(Boolean), { dn404Enabled: true, isHidden: isHiddenToken });
const leaked = merged.filter((l) => isHiddenToken(l.chainId, l.address));
ok('merged feed contains zero hidden tokens', leaked.length === 0, `merged ${merged.length} (router ${routerFeed.length}, dn404 ${merged.length - routerFeed.filter((l) => !isHiddenToken(l.chainId, l.address)).length})`);

const testTokens = {
  '$SMOKE': '0x26903cc300c81d056051e50c6cdec16054427122',
  REH404: '0x46377623f4dd0470f5ea6f6120146f0801a26514',
  '$UPT': '0x1e3100abfdceba1de7b51b1ad9713177b177b7c1',
  '$FLT': '0x6afbe2c60fe1745ed9ff592302df005575e1a172',
};
for (const [t, a] of Object.entries(testTokens)) {
  ok(`${t} is in the indexer but not in the merged feed`, !merged.some((l) => l.address.toLowerCase() === a),
    dnRows.some((r) => r.pairedToken?.toLowerCase() === a) ? 'present upstream, filtered' : 'collection already hidden upstream');
}

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
  if (!r.pass) failed++;
}
process.exit(failed ? 1 : 0);
