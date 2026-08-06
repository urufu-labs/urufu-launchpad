// Dry-run of publishEpoch: fetches gemu holders, reads vault balance +
// nextEpochId, computes per-holder splits, builds the Merkle tree, prints
// what WOULD be broadcast. Does NOT send addEpoch and does NOT write to the
// database. Use before flipping KEEPER_ENABLED or hitting POST /rewards.
//
// Run manually:
//   INDEXER_URL=<railway-indexer-url> \
//   ROBINHOOD_RPC_URL=<rpc> \
//   ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS=0xAcd981FBBD32c5FAa837F1170E30449123106fb7 \
//   ROBINHOOD_GEMU_NFT_ADDRESS=<gemu> \
//   node --experimental-strip-types compile-service/src/publishEpochDryRun.ts

import { createPublicClient, http, parseAbi, formatEther, type Address, type Hex } from 'viem';

import { splitAllocations, buildTree } from './rewards.ts';

const RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const VAULT = process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS as Address | undefined;
const NFT = process.env.ROBINHOOD_GEMU_NFT_ADDRESS as Address | undefined;
const INDEXER = (process.env.INDEXER_URL ?? process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069').replace(/\/$/, '');
const CHAIN_ID = 4663;

if (!VAULT) throw new Error('ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS not set');
if (!NFT) throw new Error('ROBINHOOD_GEMU_NFT_ADDRESS not set');

const vaultAbi = parseAbi(['function nextEpochId() view returns (uint256)']);

interface Holder {
    address: Address;
    balance: bigint;
}

async function fetchHolders(): Promise<Holder[]> {
    const query = `
    query GemuHolders($chainId: Int!, $token: String!) {
      holderss(where: { chainId: $chainId, tokenAddress: $token }, limit: 5000) {
        items { holderAddress balance }
      }
    }
  `;
    const res = await fetch(`${INDEXER}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            query,
            variables: { chainId: CHAIN_ID, token: NFT!.toLowerCase() },
        }),
    });
    if (!res.ok) throw new Error(`indexer ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
        data?: { holderss: { items: Array<{ holderAddress: string; balance: string }> } };
        errors?: unknown;
    };
    if (json.errors) throw new Error(`indexer errors: ${JSON.stringify(json.errors)}`);
    const items = json.data?.holderss.items ?? [];
    return items
        .map((r) => ({ address: r.holderAddress.toLowerCase() as Address, balance: BigInt(r.balance) }))
        .filter((h) => h.balance > 0n);
}

async function main(): Promise<void> {
    const pub = createPublicClient({ transport: http(RPC) });

    const [balance, nextEpochIdRaw] = await Promise.all([
        pub.getBalance({ address: VAULT! }),
        pub.readContract({ address: VAULT!, abi: vaultAbi, functionName: 'nextEpochId' }),
    ]);
    const nextEpochId = nextEpochIdRaw as bigint;

    process.stdout.write(`--- Vault state ---\n`);
    process.stdout.write(`  address:      ${VAULT}\n`);
    process.stdout.write(`  balance:      ${formatEther(balance)} ETH (${balance.toString()} wei)\n`);
    process.stdout.write(`  nextEpochId:  ${nextEpochId}\n`);
    if (balance === 0n) {
        process.stdout.write(`  (balance is zero — publish would revert)\n`);
        return;
    }

    process.stdout.write(`\n--- Holder snapshot (from indexer at ${INDEXER}) ---\n`);
    let holders: Holder[];
    try {
        holders = await fetchHolders();
    } catch (err) {
        process.stdout.write(`  FAILED: ${(err as Error).message}\n`);
        process.stdout.write(`  (publish would revert — indexer must be reachable + return gemu holders)\n`);
        return;
    }
    process.stdout.write(`  holders:      ${holders.length}\n`);
    const totalNfts = holders.reduce((s, h) => s + h.balance, 0n);
    process.stdout.write(`  totalNfts:    ${totalNfts}\n`);
    if (holders.length === 0) {
        process.stdout.write(`  (no holders — publish would revert)\n`);
        return;
    }

    process.stdout.write(`\n--- Merkle tree build ---\n`);
    const allocations = splitAllocations(holders, balance);
    const { root, leaves } = buildTree(allocations, nextEpochId);
    process.stdout.write(`  root:         ${root}\n`);
    process.stdout.write(`  leaves:       ${leaves.length}\n`);

    const distributedTotal = allocations.reduce((s, a) => s + a.amount, 0n);
    process.stdout.write(`  distributed:  ${formatEther(distributedTotal)} ETH (${distributedTotal.toString()} wei)\n`);
    process.stdout.write(`  matches:      ${distributedTotal === balance ? 'YES' : 'NO (invariant broken!)'}\n`);

    process.stdout.write(`\n--- Per-holder allocations (top 20 by amount) ---\n`);
    const sorted = [...allocations].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    const top = sorted.slice(0, 20);
    for (const a of top) {
        process.stdout.write(`  ${a.holder}  ${formatEther(a.amount).padStart(24)} ETH\n`);
    }
    if (sorted.length > 20) {
        process.stdout.write(`  … (${sorted.length - 20} more)\n`);
    }

    process.stdout.write(`\n--- What publishEpoch WOULD broadcast ---\n`);
    process.stdout.write(`  vault.addEpoch(\n`);
    process.stdout.write(`    merkleRoot:  ${root},\n`);
    process.stdout.write(`    totalAmount: ${balance.toString()}  // wei\n`);
    process.stdout.write(`  )\n`);
    process.stdout.write(`\nDry-run OK. To broadcast for real:\n`);
    process.stdout.write(`  curl -X POST <compile-service>/rewards/robinhood/publish \\\n`);
    process.stdout.write(`    -H "x-keeper-secret: <secret>" -H "content-type: application/json" -d '{}'\n`);
}

main().catch((err) => {
    process.stderr.write(`dry-run FAILED: ${(err as Error).message}\n`);
    process.exit(1);
});
