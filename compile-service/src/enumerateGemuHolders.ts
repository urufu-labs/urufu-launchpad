// Read-only: walks Transfer events on the gemu NFT and prints current
// holders as JSON so the forge broadcast script can hardcode them. No
// signing, no broadcast, no writes.
//
// Run:
//   node --experimental-strip-types compile-service/src/enumerateGemuHolders.ts
// Prints:
//   { totalHolders, totalNfts, holders: [{ address, count }] }

import { createPublicClient, http, parseAbiItem, type Address } from 'viem';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const NFT: Address = '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17';
const NFT_DEPLOY_BLOCK = 18_349_000n;

const pub = createPublicClient({ transport: http(RPC) });
const TRANSFER_EVT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

async function main(): Promise<void> {
    const head = await pub.getBlockNumber();
    process.stderr.write(`scanning ${NFT_DEPLOY_BLOCK}..${head}\n`);
    const owner = new Map<string, Address>();
    const CHUNK = 9_500n;
    let from = NFT_DEPLOY_BLOCK;
    while (from <= head) {
        const to = from + CHUNK > head ? head : from + CHUNK;
        const logs = await pub.getLogs({ address: NFT, event: TRANSFER_EVT, fromBlock: from, toBlock: to });
        for (const l of logs) {
            const a = l.args as { to?: Address; tokenId?: bigint };
            if (a.tokenId === undefined || a.to === undefined) continue;
            owner.set(a.tokenId.toString(), a.to.toLowerCase() as Address);
        }
        if (logs.length > 0) process.stderr.write(`  ${from}..${to}: +${logs.length} (${owner.size} tokens)\n`);
        from = to + 1n;
    }
    const ZERO: Address = '0x0000000000000000000000000000000000000000';
    const counts = new Map<Address, number>();
    for (const [, o] of owner) {
        if (o === ZERO) continue;
        counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    const holders = [...counts.entries()]
        .map(([address, count]) => ({ address, count }))
        .sort((a, b) => b.count - a.count);
    const totalNfts = holders.reduce((s, h) => s + h.count, 0);
    process.stdout.write(JSON.stringify({ totalHolders: holders.length, totalNfts, holders }, null, 2));
    process.stdout.write('\n');
}

main().catch((e) => {
    process.stderr.write(`FAILED: ${(e as Error).message}\n`);
    process.exit(1);
});
