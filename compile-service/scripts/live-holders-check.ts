/// Read-only live check for the Alchemy-free NFT features (not part of CI; it
/// hits real endpoints). Run from compile-service/:
///   OPENSEA_API_KEY=... node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/live-holders-check.ts
///
/// (a) urufu gemu nft holders: holder engine over Robinhood's public RPC vs
///     our indexer's GemuNft-derived `holders` rows. They must match exactly.
/// (b) deployer wallet NFTs on Robinhood via OpenSea, mapped by the same
///     function the /wallet/:address/nfts route uses.
import { holdersFromState, scanHolders } from '../src/holders-engine.ts';
import { toNftAvatar } from '../src/routes/nft-avatar.ts';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const INDEXER = 'https://indexer-robinhood-production.up.railway.app/graphql';
const GEMU = '0x60cb7082c8c14b4237c6a24c65e7c2e7abe2bd17';
const DEPLOYER = '0x6d606cc634f20f5534fba072757f2c2c7b835bb9';

async function indexerGemuHolders(): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(INDEXER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($t: String!, $after: String) { holderss(where: { tokenAddress: $t, chainId: 4663 }, limit: 1000, after: $after) { items { holderAddress balance } pageInfo { hasNextPage endCursor } } }`,
        variables: { t: GEMU, after },
      }),
    });
    const j = (await res.json()) as any;
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    for (const it of j.data.holderss.items) {
      const bal = BigInt(it.balance);
      if (bal > 0n) out.set(String(it.holderAddress).toLowerCase(), bal);
    }
    if (!j.data.holderss.pageInfo.hasNextPage) break;
    after = j.data.holderss.pageInfo.endCursor;
  }
  return out;
}

const t0 = Date.now();
const state = await scanHolders({ rpcUrl: RPC, address: GEMU });
const scanMs = Date.now() - t0;
const engine = new Map(holdersFromState(state).map((r) => [r.address, r.balance]));
const tokens = holdersFromState(state).reduce((n, r) => n + r.tokenIds.length, 0);
console.log(`(a) engine: standard=${state.standard} holders=${engine.size} tokens=${tokens} scannedTo=${state.lastBlock} in ${scanMs}ms`);

const t1 = Date.now();
await scanHolders({ rpcUrl: RPC, address: GEMU });
console.log(`    cached incremental re-scan: ${Date.now() - t1}ms`);

const idx = await indexerGemuHolders();
let mismatch = 0;
for (const [a, b] of engine) if (idx.get(a) !== b) mismatch++;
for (const [a, b] of idx) if (engine.get(a) !== b) mismatch++;
console.log(`    indexer: holders=${idx.size}; mismatched rows=${mismatch}`);
if (mismatch > 0) {
  const diffs = [...new Set([...engine.keys(), ...idx.keys()])].filter((a) => engine.get(a) !== idx.get(a)).slice(0, 5);
  for (const a of diffs) console.log(`      ${a}: engine=${engine.get(a) ?? 0n} indexer=${idx.get(a) ?? 0n}`);
}

const key = process.env.OPENSEA_API_KEY;
if (!key) {
  console.log('(b) skipped: OPENSEA_API_KEY not set');
} else {
  const res = await fetch(`https://api.opensea.io/api/v2/chain/robinhood/account/${DEPLOYER}/nfts?limit=50`, {
    headers: { accept: 'application/json', 'x-api-key': key },
  });
  const j = (await res.json()) as { nfts?: any[]; next?: string | null };
  const items = (j.nfts ?? []).flatMap((n) => toNftAvatar({ chainId: 4663, label: 'Robinhood' }, n));
  const byCollection = new Map<string, number>();
  for (const it of items) byCollection.set(it.collectionName ?? '?', (byCollection.get(it.collectionName ?? '?') ?? 0) + 1);
  console.log(`(b) opensea http ${res.status}: raw=${(j.nfts ?? []).length} mapped=${items.length} hasMore=${Boolean(j.next)} collections=${JSON.stringify(Object.fromEntries(byCollection))}`);
  if (items[0]) console.log(`    sample: ${JSON.stringify(items[0])}`);
  // Cross-check: every urufu gemu nft OpenSea lists for the deployer is owned by it on-chain.
  const gemuIds = items.filter((i) => i.contractAddress === GEMU).map((i) => i.tokenId);
  const onchainOwned = new Set(holdersFromState(state).find((r) => r.address === DEPLOYER)?.tokenIds ?? []);
  console.log(`    urufu gemu nft ids from OpenSea (first page): ${gemuIds.length}; all owned on-chain per engine: ${gemuIds.every((id) => onchainOwned.has(id))}`);
}
