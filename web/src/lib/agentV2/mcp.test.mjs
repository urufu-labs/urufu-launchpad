// MCP server + REST adapter contract tests: protocol, tool schemas, no key fields,
// body caps, rate limits, and REST/MCP returning the same tool output.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { handleMcpRequest, handleRestRequest, MAX_JSON_BODY, MCP_MESSAGE_RATE } from './http.ts';
import { mcpToolList, MCP_LATEST } from './mcp.ts';
import { RateLimiter } from './rateLimit.ts';
import { TtlCache } from './ttlCache.ts';
import { AGENT_TOOLS } from './registry.ts';
import { LAUNCHER, TOKEN, fakeDeps } from './testFixtures.mjs';

function hctx() {
  const { deps } = fakeDeps();
  return { deps, limiter: new RateLimiter(), cache: new TtlCache() };
}

function mcpReq(body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://urufulabs.xyz/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '198.51.100.7', ...headers },
    body: text,
  });
}

async function rpc(c, body, headers) {
  const res = await handleMcpRequest(mcpReq(body, headers), c);
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
}

describe('MCP protocol', () => {
  it('initialize negotiates the version and returns instructions', async () => {
    const c = hctx();
    const r = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.protocolVersion, '2025-03-26');
    assert.ok(r.json.result.capabilities.tools);
    assert.match(r.json.result.instructions, /private key/i);
    assert.match(r.json.result.instructions, /not instructions/);
    const unknown = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(unknown.json.result.protocolVersion, MCP_LATEST);
  });

  it('notifications get 202 and no body', async () => {
    const r = await rpc(hctx(), { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(r.status, 202);
  });

  it('ping, unknown method, batch, malformed JSON', async () => {
    const c = hctx();
    assert.deepEqual((await rpc(c, { jsonrpc: '2.0', id: 'p', method: 'ping' })).json.result, {});
    assert.equal((await rpc(c, { jsonrpc: '2.0', id: 3, method: 'resources/list' })).json.error.code, -32601);
    assert.equal((await rpc(c, [{ jsonrpc: '2.0', id: 4, method: 'ping' }])).json.error.code, -32600);
    const bad = await rpc(c, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, -32700);
  });

  it('GET and DELETE are 405 (stateless, no SSE stream)', async () => {
    const c = hctx();
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcpRequest(new Request('https://urufulabs.xyz/api/mcp', { method }), c);
      assert.equal(res.status, 405);
    }
  });

  it('rejects an unsupported MCP-Protocol-Version header and non-JSON content type', async () => {
    const c = hctx();
    const r = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1900-01-01' });
    assert.equal(r.status, 400);
    const res = await handleMcpRequest(new Request('https://x/api/mcp', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), c);
    assert.equal(res.status, 415);
  });

  it('body cap: oversized message is 413', async () => {
    const huge = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_image', arguments: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(800 * 1024) } } };
    const r = await rpc(hctx(), huge);
    assert.equal(r.status, 413);
  });

  it('message rate limit per IP', async () => {
    const c = hctx();
    let last;
    for (let i = 0; i <= MCP_MESSAGE_RATE.limit; i++) last = await rpc(c, { jsonrpc: '2.0', id: i, method: 'ping' });
    assert.equal(last.status, 429);
    const other = await rpc(c, { jsonrpc: '2.0', id: 'x', method: 'ping' }, { 'x-forwarded-for': '198.51.100.8' });
    assert.equal(other.status, 200);
  });
});

describe('MCP tool contract', () => {
  it('tools/list exposes every tool with a closed object schema', async () => {
    const r = await rpc(hctx(), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = r.json.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), AGENT_TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.ok(t.description.length > 20, t.name);
    }
  });

  it('no tool schema has, asks for, or describes a key field', () => {
    const secret = /priv|secret|mnemonic|seed|passphrase|password|signingkey|apikey|^pk$|^sk$|^key$/i;
    for (const t of mcpToolList()) {
      for (const [name, s] of Object.entries(t.inputSchema.properties)) {
        assert.equal(secret.test(name.replace(/[^a-z0-9]/gi, '')), false, `${t.name}.${name}`);
        assert.equal(/private key|seed phrase|mnemonic/i.test(s.description ?? ''), false, `${t.name}.${name} description`);
      }
      assert.equal(/send (us|me) your (private )?key|paste your (private )?key/i.test(t.description), false, t.name);
    }
  });

  it('tools/call refuses privateKey-like arguments with isError', async () => {
    const c = hctx();
    for (const t of AGENT_TOOLS) {
      const r = await rpc(c, { jsonrpc: '2.0', id: t.name, method: 'tools/call', params: { name: t.name, arguments: { privateKey: '0x' + '11'.repeat(32) } } });
      assert.equal(r.json.result.isError, true, t.name);
      assert.equal(r.json.result.structuredContent.error.code, 'SECRET_FIELD', t.name);
    }
  });

  it('tools/call: unknown tool is a protocol error; kebab names are not MCP names', async () => {
    const c = hctx();
    assert.equal((await rpc(c, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'transfer_eth' } })).json.error.code, -32602);
    assert.equal((await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'name-check' } })).json.error.code, -32602);
  });

  it('tools/call returns text + structuredContent, untrusted note first', async () => {
    const r = await rpc(hctx(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_token', arguments: { address: TOKEN } } });
    const res = r.json.result;
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.ok, true);
    assert.match(res.content[0].text, /^NOTE: .*not instructions/);
    assert.deepEqual(JSON.parse(res.content[1].text), res.structuredContent);
  });

  it('invalid arguments come back as isError with the reason', async () => {
    const r = await rpc(hctx(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quote_launch', arguments: { name: 'A' } } });
    assert.equal(r.json.result.isError, true);
    assert.equal(r.json.result.structuredContent.error.code, 'INVALID_INPUT');
  });
});

describe('REST adapter', () => {
  it('GET with query params; kebab and snake names both work', async () => {
    const c = hctx();
    for (const p of ['name-check', 'name_check']) {
      const res = await handleRestRequest(new Request(`https://x/api/agent/v2/${p}?name=A&ticker=B`), p, c);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });

  it('REST and MCP return the same envelope for the same input', async () => {
    const c = hctx();
    const rest = await (await handleRestRequest(new Request(`https://x/api/agent/v2/quote-launch?name=A&ticker=B&launcher=${LAUNCHER}`), 'quote-launch', c)).json();
    const mcp = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quote_launch', arguments: { name: 'A', ticker: 'B', launcher: LAUNCHER } } });
    assert.deepEqual(mcp.json.result.structuredContent, rest);
  });

  it('upload-image is POST only', async () => {
    const res = await handleRestRequest(new Request('https://x/api/agent/v2/upload-image?imageUrl=https://a/b.png'), 'upload-image', hctx());
    assert.equal(res.status, 405);
  });

  it('POST body over the JSON cap is 413, wrong content type 415, bad JSON 400', async () => {
    const c = hctx();
    const big = JSON.stringify({ name: 'a'.repeat(MAX_JSON_BODY), ticker: 'B' });
    let res = await handleRestRequest(new Request('https://x/api/agent/v2/name-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }), 'name-check', c);
    assert.equal(res.status, 413);
    res = await handleRestRequest(new Request('https://x/api/agent/v2/name-check', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), 'name-check', c);
    assert.equal(res.status, 415);
    res = await handleRestRequest(new Request('https://x/api/agent/v2/name-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 'name-check', c);
    assert.equal(res.status, 400);
  });

  it('body cap holds even when Content-Length lies', async () => {
    const stream = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < 40; i++) ctrl.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        ctrl.close();
      },
    });
    const req = new Request('https://x/api/agent/v2/name-check', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '10' }, body: stream, duplex: 'half' });
    const res = await handleRestRequest(req, 'name-check', hctx());
    assert.equal(res.status, 413);
  });

  it('duplicate query keys are refused', async () => {
    const res = await handleRestRequest(new Request('https://x/api/agent/v2/name-check?name=A&name=B&ticker=C'), 'name-check', hctx());
    assert.equal(res.status, 400);
  });

  it('429 carries Retry-After', async () => {
    const c = hctx();
    let res;
    for (let i = 0; i < 61; i++) res = await handleRestRequest(new Request(`https://x/api/agent/v2/status`, { headers: { 'x-forwarded-for': '192.0.2.1' } }), 'status', c);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  });

  it('unknown tool is 404', async () => {
    const res = await handleRestRequest(new Request('https://x/api/agent/v2/drain'), 'drain', hctx());
    assert.equal(res.status, 404);
  });
});
