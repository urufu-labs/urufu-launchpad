// One-off: bumps CurveFactory.defaultGraduationTargetEth on Robinhood.
// Preserves every other default (supply, virtual reserves, fee) since
// setDefaults takes all five as one atomic call. Reads current on-chain
// values first + prints a side-by-side diff so any drift is loud.
//
// Only affects launches created AFTER this tx lands. Existing curves keep
// whatever target they were minted with (bonding curve params are frozen at
// createCurve time).
//
// Run:
//   node --experimental-strip-types --env-file=.env compile-service/src/setCurveDefaults.ts

import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    parseAbi,
    parseEther,
    type Address,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_RPC_URL ?? process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
// V10 CF (rotated 2026-08-12). Fallback is only for local test runs; production
// always sets ROBINHOOD_CURVE_FACTORY_ADDRESS via .env / Railway.
const FACTORY = (process.env.ROBINHOOD_CURVE_FACTORY_ADDRESS ?? '0xEC96D023426167e68598FF9ea946882b7f0AE91f') as Address;

// Target: only change the graduation target. Everything else preserved.
const NEW_GRADUATION_TARGET = parseEther('4.2');

const key = process.env.DEV_PRIVATE_KEY;
if (!key) throw new Error('DEV_PRIVATE_KEY not set');
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);

const chain = {
    id: CHAIN_ID, name: 'robinhood',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ transport: http(RPC), chain });
const wallet = createWalletClient({ account, transport: http(RPC), chain });

const abi = parseAbi([
    'function owner() view returns (address)',
    'function defaultCurveSupply() view returns (uint256)',
    'function defaultVirtualTokenReserve() view returns (uint256)',
    'function defaultVirtualEthReserve() view returns (uint256)',
    'function defaultGraduationTargetEth() view returns (uint256)',
    'function defaultTradeFeeBps() view returns (uint16)',
    'function setDefaults(uint256 curveSupply_, uint256 virtualTokenReserve_, uint256 virtualEthReserve_, uint256 graduationTargetEth_, uint16 tradeFeeBps_)',
]);

async function main(): Promise<void> {
    process.stdout.write(`Signer: ${account.address}\n`);
    const owner = (await pub.readContract({ address: FACTORY, abi, functionName: 'owner' })) as Address;
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`factory owner=${owner} but signer=${account.address}`);
    }
    const [supply, vTok, vEth, gradOld, feeBps] = await Promise.all([
        pub.readContract({ address: FACTORY, abi, functionName: 'defaultCurveSupply' }) as Promise<bigint>,
        pub.readContract({ address: FACTORY, abi, functionName: 'defaultVirtualTokenReserve' }) as Promise<bigint>,
        pub.readContract({ address: FACTORY, abi, functionName: 'defaultVirtualEthReserve' }) as Promise<bigint>,
        pub.readContract({ address: FACTORY, abi, functionName: 'defaultGraduationTargetEth' }) as Promise<bigint>,
        pub.readContract({ address: FACTORY, abi, functionName: 'defaultTradeFeeBps' }) as Promise<number>,
    ]);
    process.stdout.write(`Current on-chain defaults:\n`);
    process.stdout.write(`  supply:          ${supply}\n`);
    process.stdout.write(`  vTokenReserve:   ${vTok}\n`);
    process.stdout.write(`  vEthReserve:     ${vEth} (${formatEther(vEth)} ETH)\n`);
    process.stdout.write(`  gradTarget:      ${gradOld} (${formatEther(gradOld)} ETH) <-- changing\n`);
    process.stdout.write(`  tradeFeeBps:     ${feeBps}\n`);
    process.stdout.write(`Proposed change:\n`);
    process.stdout.write(`  gradTarget:      ${NEW_GRADUATION_TARGET} (${formatEther(NEW_GRADUATION_TARGET)} ETH)\n`);
    if (gradOld === NEW_GRADUATION_TARGET) {
        process.stdout.write('Already at target — no tx needed.\n');
        return;
    }
    process.stdout.write(`\nBroadcasting setDefaults in 3s (Ctrl-C to abort)…\n`);
    await new Promise((r) => setTimeout(r, 3000));
    const txHash = await wallet.writeContract({
        address: FACTORY, abi, functionName: 'setDefaults',
        args: [supply, vTok, vEth, NEW_GRADUATION_TARGET, feeBps],
    });
    process.stdout.write(`tx: ${txHash}\n`);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    process.stdout.write(`status: ${receipt.status}, block: ${receipt.blockNumber}, gas: ${receipt.gasUsed}\n`);
    if (receipt.status !== 'success') throw new Error(`setDefaults reverted: ${txHash}`);
    process.stdout.write(`\n✓ Graduation target now ${formatEther(NEW_GRADUATION_TARGET)} ETH on ${FACTORY}\n`);
    process.stdout.write(`Existing curves keep their original target; only NEW createCurve calls pick up the new value.\n`);
}

main().catch((e) => {
    process.stderr.write(`FAILED: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
    process.exit(1);
});
