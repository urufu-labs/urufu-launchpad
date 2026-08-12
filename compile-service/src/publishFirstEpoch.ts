// Standalone first-epoch publisher — bypasses the compile-service/Ponder path.
// Reads gemu NFT holders by walking Transfer events on-chain, splits the
// vault balance, builds the tree, and broadcasts vault.addEpoch. Signs with
// DEV_PRIVATE_KEY from .env (must be the vault owner). Prints the Merkle
// root + per-holder allocations before sending so you can eyeball before it
// lands.
//
// Run:
//   node --experimental-strip-types --env-file=.env compile-service/src/publishFirstEpoch.ts
//
// Aborts if:
//   - not the vault owner
//   - no holders
//   - vault balance is zero
//   - user Ctrl-C's within a small confirmation delay

import {
    createPublicClient,
    createWalletClient,
    encodePacked,
    encodeFunctionData,
    formatEther,
    http,
    parseAbi,
    parseAbiItem,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MerkleTree } from 'merkletreejs';
import { keccak_256 } from '@noble/hashes/sha3';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
// NftRevenueVault (unchanged across V9/V10; not rotated with launchpad stack).
// Broadcasts addEpoch against this address; a stale pin would revert (owner
// check) or credit a dead vault.
const VAULT: Address = (process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS
    ?? '0x93CFF459d5019eEc82fE9335013e265F1eD659c7') as Address;
// gemu NFT is canonical (unchanged across launchpad rotations).
const NFT: Address = '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17';
// From memory (project_robinhood_addresses): urufu gemu nft deployed block 18349728
// on Robinhood. We start scanning from a bit before it as a safety buffer.
const NFT_DEPLOY_BLOCK = 18_349_000n;

const key = process.env.DEV_PRIVATE_KEY;
if (!key) throw new Error('DEV_PRIVATE_KEY not set');
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);

const chain = {
    id: CHAIN_ID,
    name: 'robinhood',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
} as const;

const pub: PublicClient = createPublicClient({ transport: http(RPC), chain });
const wallet = createWalletClient({ account, transport: http(RPC), chain });

const vaultAbi = parseAbi([
    'function owner() view returns (address)',
    'function nextEpochId() view returns (uint256)',
    'function minConfigDelay() view returns (uint256)',
    'function pendingEpoch() view returns (uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint64 readyAt)',
    // URU-A11 timelocked flow (V9 vault). Direct addEpoch reverts when
    // minConfigDelay > 0 which is the production config on RH.
    'function proposeEpoch(uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount)',
]);

const TRANSFER_EVT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

async function walkTransfers(): Promise<Map<Address, bigint>> {
    // Walk Transfer logs from NFT_DEPLOY_BLOCK to head, in 10k-block chunks
    // (RH RPC caps getLogs at ~10k blocks). Reconstruct ownership as
    // owner[tokenId] = to of the LAST transfer for that tokenId.
    const head = await pub.getBlockNumber();
    process.stdout.write(`Scanning Transfer events from block ${NFT_DEPLOY_BLOCK} to ${head}\n`);
    const owner = new Map<string, Address>(); // tokenId (dec string) → owner
    const CHUNK = 9_500n;
    let from = NFT_DEPLOY_BLOCK;
    while (from <= head) {
        const to = from + CHUNK > head ? head : from + CHUNK;
        const logs = await pub.getLogs({
            address: NFT,
            event: TRANSFER_EVT,
            fromBlock: from,
            toBlock: to,
        });
        for (const l of logs) {
            const args = l.args as { from?: Address; to?: Address; tokenId?: bigint };
            if (args.tokenId === undefined || args.to === undefined) continue;
            owner.set(args.tokenId.toString(), args.to.toLowerCase() as Address);
        }
        process.stdout.write(`  chunk ${from}-${to}: +${logs.length} events (${owner.size} tokens seen)\n`);
        from = to + 1n;
    }

    // Collapse tokenId → owner into owner → count. Drop burns (owner == 0x0).
    const holders = new Map<Address, bigint>();
    const ZERO: Address = '0x0000000000000000000000000000000000000000';
    for (const [, o] of owner) {
        if (o === ZERO) continue;
        holders.set(o, (holders.get(o) ?? 0n) + 1n);
    }
    return holders;
}

function leafFor(holder: Address, epochId: bigint, amount: bigint): Buffer {
    const packed = encodePacked(['address', 'uint256', 'uint256'], [holder, epochId, amount]);
    return Buffer.from(keccak_256(hexToBytes(packed)));
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

function bytesToHex(bytes: Buffer): Hex {
    return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

interface Alloc {
    holder: Address;
    balance: bigint;
    amount: bigint;
}

function splitAllocs(holders: Map<Address, bigint>, total: bigint): Alloc[] {
    const totalNfts = [...holders.values()].reduce((s, v) => s + v, 0n);
    if (totalNfts === 0n) return [];
    const rows: Alloc[] = [];
    for (const [holder, balance] of holders) {
        rows.push({ holder, balance, amount: (total * balance) / totalNfts });
    }
    // Add dust to largest holder so sum == total exactly.
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
    process.stdout.write(`Signer: ${account.address}\n`);
    const owner = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'owner' })) as Address;
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`vault owner=${owner} but signer=${account.address}`);
    }
    const balance = await pub.getBalance({ address: VAULT });
    const nextEpochIdRaw = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'nextEpochId' });
    const nextEpochId = nextEpochIdRaw as bigint;

    process.stdout.write(`Vault balance: ${formatEther(balance)} ETH\n`);
    process.stdout.write(`Next epoch id: ${nextEpochId}\n`);
    if (balance === 0n) throw new Error('vault balance zero');

    // Refuse to broadcast if a proposal is already sitting in the timelock
    // window — a second proposeEpoch would revert with PendingEpochExists.
    // Better to fail fast with a clear message here.
    const pending = (await pub.readContract({
        address: VAULT, abi: vaultAbi, functionName: 'pendingEpoch',
    })) as readonly [bigint, Hex, bigint, bigint];
    // Struct order is (expectedEpochId, merkleRoot, totalAmount, readyAt) — readyAt is [3].
    if (pending[3] !== 0n) {
        const readyAt = Number(pending[3]);
        throw new Error(
            `pending epoch already exists (readyAt=${new Date(readyAt * 1000).toISOString()}). ` +
            `wait for activateEpoch or call cancelPendingEpoch first.`,
        );
    }
    const delay = (await pub.readContract({
        address: VAULT, abi: vaultAbi, functionName: 'minConfigDelay',
    })) as bigint;
    process.stdout.write(`Timelock: ${delay}s (${(Number(delay) / 3600).toFixed(1)}h)\n`);

    const holders = await walkTransfers();
    process.stdout.write(`\nHolders: ${holders.size}\n`);
    const totalNfts = [...holders.values()].reduce((s, v) => s + v, 0n);
    process.stdout.write(`Total NFTs held (non-burned): ${totalNfts}\n`);
    if (totalNfts === 0n) throw new Error('no holders — nothing to distribute');

    const allocs = splitAllocs(holders, balance);
    process.stdout.write(`Allocations: ${allocs.length}\n`);

    const leafBufs = allocs.map((a) => leafFor(a.holder, nextEpochId, a.amount));
    const tree = new MerkleTree(leafBufs, (d: Buffer) => Buffer.from(keccak_256(d)), { sortPairs: true });
    const root = bytesToHex(tree.getRoot());

    process.stdout.write(`\n--- Publish preview ---\n`);
    process.stdout.write(`  root:        ${root}\n`);
    process.stdout.write(`  totalAmount: ${balance.toString()} wei (${formatEther(balance)} ETH)\n`);
    process.stdout.write(`\nPer-holder splits (top 20 by amount):\n`);
    const sorted = [...allocs].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    for (const r of sorted.slice(0, 20)) {
        process.stdout.write(`  ${r.holder}  count=${r.balance.toString().padStart(4)}  ${formatEther(r.amount).padStart(24)} ETH\n`);
    }
    if (sorted.length > 20) process.stdout.write(`  … and ${sorted.length - 20} more\n`);

    const distributed = allocs.reduce((s, a) => s + a.amount, 0n);
    process.stdout.write(`\nSum of allocations: ${distributed.toString()} wei (delta from vault: ${balance - distributed})\n`);
    if (distributed !== balance) throw new Error('invariant broken: sum != vault balance');

    process.stdout.write(`\nBroadcasting vault.proposeEpoch in 3s (Ctrl-C to abort)…\n`);
    process.stdout.write(`After this lands, wait ${(Number(delay) / 3600).toFixed(1)}h then call activateEpoch() to make it claimable.\n`);
    await new Promise((r) => setTimeout(r, 3000));

    const data = encodeFunctionData({
        abi: vaultAbi,
        functionName: 'proposeEpoch',
        args: [nextEpochId, root, balance],
    });
    const txHash = await wallet.sendTransaction({ to: VAULT, data });
    process.stdout.write(`tx: ${txHash}\n`);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    process.stdout.write(`status: ${receipt.status}, block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}\n`);
    if (receipt.status !== 'success') throw new Error(`proposeEpoch reverted: ${txHash}`);
    const activationReadyAt = new Date(Date.now() + Number(delay) * 1000).toISOString();
    process.stdout.write(`\n✓ Epoch ${nextEpochId} proposed. Activation ready: ${activationReadyAt}\n`);

    // Print a JSON blob of every leaf + proof so the compile-service or
    // frontend can persist it later. Small tree = fine to print all.
    process.stdout.write(`\n--- Leaves + proofs (persist to app.rewards_leaves) ---\n`);
    const dump = allocs.map((a, i) => ({
        holder: a.holder,
        amount: a.amount.toString(),
        proof: tree
            .getProof(leafBufs[i]!)
            .map((p) => bytesToHex(Buffer.from(p.data))),
    }));
    process.stdout.write(JSON.stringify({ chainId: CHAIN_ID, epochId: Number(nextEpochId), merkleRoot: root, totalAmount: balance.toString(), holders: dump }, null, 2));
    process.stdout.write(`\n\nDone.\n`);
}

main().catch((e) => {
    process.stderr.write(`FAILED: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
    process.exit(1);
});
