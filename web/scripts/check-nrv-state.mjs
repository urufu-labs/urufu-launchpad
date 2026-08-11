import {createPublicClient, http, parseAbi, defineChain, formatEther} from 'viem';
const chain = defineChain({id:4663,name:'RH',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[process.env.RPC]}}});
const c = createPublicClient({chain, transport: http(process.env.RPC)});
const abi = parseAbi([
  'function nextEpochId() view returns (uint256)',
  'function totalCommitted() view returns (uint256)',
  'function availableBalance() view returns (uint256)',
  'function owner() view returns (address)',
  'function minConfigDelay() view returns (uint256)',
  'function pendingEpoch() view returns (uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint64 readyAt)',
]);
const addr = '0x375337c4c3B85a44948e7D98d7C05256DEFf0eA8';
const bal = await c.getBalance({address: addr});
const [nx, tc, av, ow, dl, pe] = await Promise.all([
  c.readContract({address:addr, abi, functionName:'nextEpochId'}),
  c.readContract({address:addr, abi, functionName:'totalCommitted'}),
  c.readContract({address:addr, abi, functionName:'availableBalance'}),
  c.readContract({address:addr, abi, functionName:'owner'}),
  c.readContract({address:addr, abi, functionName:'minConfigDelay'}),
  c.readContract({address:addr, abi, functionName:'pendingEpoch'}),
]);
console.log('NftRevenueVault @', addr);
console.log('  ETH balance:      ', formatEther(bal), 'ETH');
console.log('  owner:            ', ow);
console.log('  nextEpochId:      ', nx.toString(), (nx === 0n ? '← NO EPOCHS PUBLISHED YET' : ''));
console.log('  totalCommitted:   ', formatEther(tc), 'ETH');
console.log('  availableBalance: ', formatEther(av), 'ETH (uncommitted, still claimable to future epoch)');
console.log('  minConfigDelay:   ', dl.toString(), 'sec ('+(Number(dl)/3600).toFixed(1)+' h)');
console.log('  pendingEpoch:');
console.log('    expectedEpochId:', pe[0].toString());
console.log('    root:           ', pe[1]);
console.log('    amount:         ', formatEther(pe[2]), 'ETH');
console.log('    readyAt:        ', pe[3].toString(), pe[3] > 0n ? '('+new Date(Number(pe[3])*1000).toISOString()+')' : '(none pending)');
