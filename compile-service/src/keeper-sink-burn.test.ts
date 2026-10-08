// The URU sink burn job may only ever send `transfer(0xdEaD, amount)` through
// the sink. This pins the calldata to the shape proven on a fork in
// contracts/test/flywheel/UruSinkBurnFork.t.sol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi } from 'viem';
import { DEAD_ADDRESS, encodeSinkBurn, sinkBurnConfig } from './keeper.ts';

test('burn calldata is transfer to the dead address, nothing else', () => {
  const amount = 54_603_498_715_556_046_650_669n;
  const data = encodeSinkBurn(amount);
  assert.equal(data.slice(0, 10), '0xa9059cbb'); // transfer(address,uint256)
  const { functionName, args } = decodeFunctionData({
    abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
    data,
  });
  assert.equal(functionName, 'transfer');
  assert.equal(args[0], DEAD_ADDRESS);
  assert.equal(args[1], amount);
});

test('config targets the live sink and URU, and needs rpc + key', () => {
  const saved = { rpc: process.env.ROBINHOOD_RPC_URL, key: process.env.KEEPER_PRIVATE_KEY };
  delete process.env.ROBINHOOD_RPC_URL;
  assert.equal(sinkBurnConfig(), null);
  process.env.ROBINHOOD_RPC_URL = 'http://localhost:1';
  process.env.KEEPER_PRIVATE_KEY = '11'.repeat(32);
  const cfg = sinkBurnConfig();
  assert.equal(cfg?.sink.toLowerCase(), '0xecd30ea7d0945a99b2032af4a6ad9d5bf345b8c8');
  assert.equal(cfg?.uru.toLowerCase(), '0x9fbe210007ddd8389f98d0253018e65cc48b9d24');
  if (saved.rpc === undefined) delete process.env.ROBINHOOD_RPC_URL; else process.env.ROBINHOOD_RPC_URL = saved.rpc;
  if (saved.key === undefined) delete process.env.KEEPER_PRIVATE_KEY; else process.env.KEEPER_PRIVATE_KEY = saved.key;
});
