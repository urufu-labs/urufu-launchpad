// One-off cancel of a pending NftRevenueVault epoch. Owner-only, no timelock.
// Frees the reserved ETH so a fresh proposeEpoch (from compile-service /
// keeper) can build the tree, persist leaves to Postgres, and re-broadcast.
//
// Run:
//   node --experimental-strip-types --env-file=.env compile-service/src/cancelPendingEpoch.ts

import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    parseAbi,
    type Address,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
// NftRevenueVault (unchanged across V9/V10; not rotated with launchpad stack).
const VAULT: Address = (process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS
    ?? '0x93CFF459d5019eEc82fE9335013e265F1eD659c7') as Address;

const key = process.env.DEV_PRIVATE_KEY;
if (!key) throw new Error('DEV_PRIVATE_KEY not set');
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);

const chain = {
    id: CHAIN_ID,
    name: 'robinhood',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ transport: http(RPC), chain });
const wallet = createWalletClient({ account, transport: http(RPC), chain });

const abi = parseAbi([
    'function owner() view returns (address)',
    'function pendingEpoch() view returns (uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint64 readyAt)',
    'function cancelPendingEpoch()',
]);

async function main(): Promise<void> {
    process.stdout.write(`Signer: ${account.address}\n`);
    const owner = (await pub.readContract({ address: VAULT, abi, functionName: 'owner' })) as Address;
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`vault owner=${owner} but signer=${account.address}`);
    }
    const pending = (await pub.readContract({
        address: VAULT, abi, functionName: 'pendingEpoch',
    })) as readonly [bigint, Hex, bigint, bigint];
    if (pending[3] === 0n) {
        process.stdout.write('No pending epoch to cancel. Nothing to do.\n');
        return;
    }
    process.stdout.write(`Pending epoch to cancel:\n`);
    process.stdout.write(`  expectedEpochId: ${pending[0]}\n`);
    process.stdout.write(`  root:            ${pending[1]}\n`);
    process.stdout.write(`  amount:          ${formatEther(pending[2])} ETH\n`);
    process.stdout.write(`  readyAt:         ${new Date(Number(pending[3]) * 1000).toISOString()}\n`);
    process.stdout.write(`\nBroadcasting cancelPendingEpoch in 3s (Ctrl-C to abort)…\n`);
    await new Promise((r) => setTimeout(r, 3000));

    const txHash = await wallet.writeContract({
        address: VAULT, abi, functionName: 'cancelPendingEpoch',
    });
    process.stdout.write(`tx: ${txHash}\n`);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    process.stdout.write(`status: ${receipt.status}, block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}\n`);
    if (receipt.status !== 'success') throw new Error(`cancel reverted: ${txHash}`);
    process.stdout.write(`\n✓ Pending epoch cancelled. ETH released back to availableBalance.\n`);
}

main().catch((e) => {
    process.stderr.write(`FAILED: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
    process.exit(1);
});
