// Read-only tree builder: fetches gemu holders from chain, reads vault
// balance + nextEpochId, computes per-holder splits, builds Merkle tree.
// Prints:
//   1. STDERR: human-readable summary + top 20 splits
//   2. STDOUT: JSON with { merkleRoot, totalAmount, epochId, leaves: [{holder, amount, proof}] }
//
// No signing, no broadcast, no DB writes. The stdout JSON is consumed by:
//   - the forge broadcast script (BroadcastFirstEpoch.s.sol) for root+total
//   - post-broadcast DB seed / frontend proof serving

import {
    createPublicClient,
    encodePacked,
    formatEther,
    http,
    parseAbi,
    parseAbiItem,
    type Address,
    type Hex,
} from 'viem';
import { MerkleTree } from 'merkletreejs';
import { keccak_256 } from '@noble/hashes/sha3';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
// V9 NftRevenueVault (2026-08-06 fresh stack). Rotate here whenever the vault
// moves; buildEpochTree writes the tree JSON that BroadcastFirstEpoch consumes
// so a stale VAULT pin would build a proof set against a dead contract.
const VAULT: Address = '0x375337c4c3B85a44948e7D98d7C05256DEFf0eA8';
// gemu NFT is canonical (unchanged across V7 / V8 launchpad rotations).
const NFT: Address = '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17';
const NFT_DEPLOY_BLOCK = 18_349_000n;
const CHAIN_ID = 4663;

const pub = createPublicClient({ transport: http(RPC) });
const TRANSFER_EVT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
const vaultAbi = parseAbi(['function nextEpochId() view returns (uint256)']);

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(b: Buffer): Hex {
    return ('0x' + Array.from(b).map((v) => v.toString(16).padStart(2, '0')).join('')) as Hex;
}

function leafFor(holder: Address, epochId: bigint, amount: bigint): Buffer {
    const packed = encodePacked(['address', 'uint256', 'uint256'], [holder, epochId, amount]);
    return Buffer.from(keccak_256(hexToBytes(packed)));
}

async function walkHolders(): Promise<Map<Address, bigint>> {
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
        from = to + 1n;
    }
    const ZERO: Address = '0x0000000000000000000000000000000000000000';
    const counts = new Map<Address, bigint>();
    for (const [, o] of owner) {
        if (o === ZERO) continue;
        counts.set(o, (counts.get(o) ?? 0n) + 1n);
    }
    return counts;
}

interface Alloc {
    holder: Address;
    balance: bigint;
    amount: bigint;
}

function splitAllocs(holders: Map<Address, bigint>, total: bigint): Alloc[] {
    const totalNfts = [...holders.values()].reduce((s, v) => s + v, 0n);
    if (totalNfts === 0n) return [];
    const rows: Alloc[] = [...holders.entries()].map(([holder, balance]) => ({
        holder,
        balance,
        amount: (total * balance) / totalNfts,
    }));
    const distributed = rows.reduce((s, r) => s + r.amount, 0n);
    const dust = total - distributed;
    if (dust > 0n) {
        let largest = 0;
        for (let i = 1; i < rows.length; i++) {
            if ((rows[i]?.balance ?? 0n) > (rows[largest]?.balance ?? 0n)) largest = i;
        }
        const t = rows[largest];
        if (t) t.amount += dust;
    }
    return rows.filter((r) => r.amount > 0n);
}

async function main(): Promise<void> {
    const [balance, nextEpochIdRaw, holders] = await Promise.all([
        pub.getBalance({ address: VAULT }),
        pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'nextEpochId' }),
        walkHolders(),
    ]);
    const nextEpochId = nextEpochIdRaw as bigint;

    process.stderr.write(`vault balance:  ${formatEther(balance)} ETH\n`);
    process.stderr.write(`next epoch id:  ${nextEpochId}\n`);
    process.stderr.write(`holders:        ${holders.size}\n`);
    const totalNfts = [...holders.values()].reduce((s, v) => s + v, 0n);
    process.stderr.write(`total NFTs:     ${totalNfts}\n`);

    if (balance === 0n) throw new Error('vault balance zero');
    if (totalNfts === 0n) throw new Error('no holders');

    const allocs = splitAllocs(holders, balance);
    const leafBufs = allocs.map((a) => leafFor(a.holder, nextEpochId, a.amount));
    const tree = new MerkleTree(leafBufs, (d: Buffer) => Buffer.from(keccak_256(d)), { sortPairs: true });
    const root = bytesToHex(tree.getRoot());

    process.stderr.write(`\nroot:           ${root}\n`);
    process.stderr.write(`totalAmount:    ${balance.toString()} wei (${formatEther(balance)} ETH)\n`);

    process.stderr.write(`\ntop 10 splits:\n`);
    const sorted = [...allocs].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    for (const r of sorted.slice(0, 10)) {
        process.stderr.write(`  ${r.holder}  count=${r.balance.toString().padStart(4)}  ${formatEther(r.amount).padStart(24)} ETH\n`);
    }

    const distributed = allocs.reduce((s, a) => s + a.amount, 0n);
    if (distributed !== balance) throw new Error(`invariant broken: sum=${distributed} != total=${balance}`);
    process.stderr.write(`\nsum invariant:  OK (${distributed} == ${balance})\n`);

    const leaves = allocs.map((a, i) => ({
        holder: a.holder,
        amount: a.amount.toString(),
        proof: tree.getProof(leafBufs[i]!).map((p) => bytesToHex(Buffer.from(p.data))),
    }));

    process.stdout.write(
        JSON.stringify(
            {
                chainId: CHAIN_ID,
                vaultAddress: VAULT,
                epochId: Number(nextEpochId),
                merkleRoot: root,
                totalAmount: balance.toString(),
                holderCount: leaves.length,
                leaves,
            },
            null,
            2,
        ),
    );
    process.stdout.write('\n');
}

main().catch((e) => {
    process.stderr.write(`FAILED: ${(e as Error).message}\n`);
    process.exit(1);
});
