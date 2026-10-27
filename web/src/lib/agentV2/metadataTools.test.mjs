// prepare_metadata / attach_metadata: token page details for agent launches on the
// token lane and the Fair lane, signed with personal_sign by the launcher. The
// signed payload is run through the compile-service's own verifyEnvelope, so a
// passing test means the live service accepts what these tools produce.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { fairLaunchFactoryAbi, routerAbi } from '../abis.ts';
import { verifyEnvelope } from '../../../../compile-service/src/auth.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, CURVE, TOKEN, defaultChain, fakeDeps } from './testFixtures.mjs';

const launcher = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const TOKEN_TX = '0x' + 'a1'.repeat(32);
const FAIR_TX = '0x' + 'f1'.repeat(32);
const NFT_TX = '0x' + 'b2'.repeat(32);
const BAD_TX = '0x' + 'c3'.repeat(32);

function chainWithLaunches() {
  const c = defaultChain();
  const ok = (logs) => ({ status: 'success', blockNumber: 1n, from: launcher.address, to: BOOK.Router, gasUsed: 1n, logs });
  c.receipts[TOKEN_TX] = ok([{
    address: BOOK.Router,
    topics: encodeEventTopics({ abi: routerAbi, eventName: 'Launched', args: { token: TOKEN, launchedBy: launcher.address, base: 0 } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }], ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 1n, false, false]),
  }]);
  c.receipts[FAIR_TX] = ok([{
    address: BOOK.FairLaunchFactory,
    topics: encodeEventTopics({ abi: fairLaunchFactoryAbi, eventName: 'FairLaunched', args: { token: TOKEN, curve: CURVE, launcher: launcher.address } }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
      ['0x4444444444444444444444444444444444444444', 'Calm Pond', 'POND', 1n, 1n, 1n, 1n, 1n, false],
    ),
  }]);
  // A Launched event from a contract that is not the Router: must be ignored.
  c.receipts[NFT_TX] = ok([{ ...c.receipts[TOKEN_TX].logs[0], address: '0x9999999999999999999999999999999999999999' }]);
  c.receipts[BAD_TX] = { ...ok([]), status: 'reverted' };
  return c;
}

function setup(over = {}) {
  const { deps } = fakeDeps({ chain: chainWithLaunches(), now: () => Date.now(), ...over });
  const c = { ip: '192.0.2.9', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
  return { deps, run: (tool, input) => runTool(tool, input, c) };
}

const FIELDS = {
  description: 'A calm pond coin. ‮hidden​ chars removed.',
  imageUrl: 'https://gateway.pinata.cloud/ipfs/bafyexample',
  website: 'https://calmpond.example',
  twitter: '@calmpond',
};

async function prepareAndSign(s, txHash, fields = FIELDS, signer = launcher) {
  const p = await s.run('prepare_metadata', { txHash, ...fields });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const signature = await signer.signMessage({ message: p.body.data.message });
  return { p: p.body.data, signature };
}

describe('prepare_metadata / attach_metadata', () => {
  for (const [lane, tx] of [['token', TOKEN_TX], ['fair', FAIR_TX]]) {
    it(`${lane} lane: prepare, sign, attach saves exactly what compile-service verifies`, async () => {
      const s = setup();
      const { p, signature } = await prepareAndSign(s, tx);
      assert.equal(p.lane, lane);
      assert.equal(p.signWith, launcher.address);
      const r = await s.run('attach_metadata', { txHash: tx, ...FIELDS, timestamp: p.timestamp, signature });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.saved, true);
      const [{ token, body }] = s.deps.saved;
      assert.equal(token.toLowerCase(), TOKEN);
      assert.equal(body.payload.description, 'A calm pond coin. hidden chars removed.');
      assert.equal(body.payload.wlListCid, null);
      assert.equal(body.payload.tokenAddress, TOKEN);
      // The compile-service's own check, on the exact body we would POST.
      const auth = await verifyEnvelope('metadata:save', body.payload, { address: body.address, signature: body.signature, timestamp: body.timestamp });
      assert.deepEqual(auth, { ok: true, address: launcher.address.toLowerCase() });
      // Creator text comes back only under untrusted.
      assert.equal(JSON.stringify(r.body.data).includes('calm pond coin'), false);
      assert.ok(r.body.untrusted.fields.description);
    });
  }

  it('signature from another wallet, or over changed fields, is refused before saving', async () => {
    const s = setup();
    const wrong = await prepareAndSign(s, TOKEN_TX, FIELDS, other);
    let r = await s.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, timestamp: wrong.p.timestamp, signature: wrong.signature });
    assert.equal(r.body.error.code, 'BAD_SIGNATURE');
    const good = await prepareAndSign(s, TOKEN_TX);
    r = await s.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, website: 'https://evil.example', timestamp: good.p.timestamp, signature: good.signature });
    assert.equal(r.body.error.code, 'BAD_SIGNATURE');
    assert.equal(s.deps.saved.length, 0);
  });

  it('expired signatures are refused', async () => {
    const s = setup();
    const { p, signature } = await prepareAndSign(s, TOKEN_TX);
    const late = setup({ now: () => p.timestamp + 6 * 60 * 1000 });
    const r = await late.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, timestamp: p.timestamp, signature });
    assert.equal(r.body.error.code, 'EXPIRED');
  });

  it('retries while the indexer catches up, then reports pending', async () => {
    const s = setup();
    let calls = 0;
    s.deps.saveMetadata = async () => (++calls < 3 ? { status: 409, code: 'INDEXER_PENDING' } : { status: 200 });
    const a = await prepareAndSign(s, TOKEN_TX);
    let r = await s.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, timestamp: a.p.timestamp, signature: a.signature });
    assert.equal(r.status, 200);
    assert.equal(calls, 3);
    s.deps.saveMetadata = async () => ({ status: 409, code: 'INDEXER_PENDING' });
    const b = await prepareAndSign(s, TOKEN_TX);
    r = await s.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, timestamp: b.p.timestamp, signature: b.signature });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INDEXER_PENDING');
  });

  it('store refusals come back as errors', async () => {
    const s = setup();
    s.deps.saveMetadata = async () => ({ status: 403, code: 'NOT_LAUNCHER' });
    const a = await prepareAndSign(s, TOKEN_TX);
    const r = await s.run('attach_metadata', { txHash: TOKEN_TX, ...FIELDS, timestamp: a.p.timestamp, signature: a.signature });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NOT_LAUNCHER');
  });

  it('only urufu launches count: spoofed event, reverted tx, unknown tx', async () => {
    const s = setup();
    assert.equal((await s.run('prepare_metadata', { txHash: NFT_TX })).body.error.code, 'NOT_A_LAUNCH');
    assert.equal((await s.run('prepare_metadata', { txHash: BAD_TX })).body.error.code, 'LAUNCH_FAILED');
    assert.equal((await s.run('prepare_metadata', { txHash: '0x' + 'dd'.repeat(32) })).status, 404);
  });

  it('input rules: only http(s) links, length caps, no key fields', async () => {
    const s = setup();
    for (const bad of [{ imageUrl: 'javascript:alert(1)' }, { website: 'data:text/html,x' }, { description: 'x'.repeat(501) }, { twitter: 'x'.repeat(81) }]) {
      assert.equal((await s.run('prepare_metadata', { txHash: TOKEN_TX, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.run('attach_metadata', { txHash: TOKEN_TX, timestamp: 1, signature: '0x' + '1'.repeat(130), privateKey: '0x1' })).body.error.code, 'SECRET_FIELD');
  });

  it('omitted fields go in as null, so a save never fails on missing keys', async () => {
    const s = setup();
    const { p, signature } = await prepareAndSign(s, TOKEN_TX, {});
    const r = await s.run('attach_metadata', { txHash: TOKEN_TX, timestamp: p.timestamp, signature });
    assert.equal(r.status, 200);
    const { payload } = s.deps.saved[0].body;
    assert.deepEqual(Object.keys(payload).sort(), ['chainId', 'description', 'discord', 'imageUrl', 'telegram', 'tiktok', 'tokenAddress', 'twitter', 'website', 'wlListCid']);
    assert.equal(payload.description, null);
  });
});
