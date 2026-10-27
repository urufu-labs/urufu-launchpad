/// Web-standard Request -> Response adapters for the v2 REST routes and the MCP
/// route. Route files only pick the deps; everything testable lives here.

import { BodyError, readJsonBody } from './body';
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS } from './mcp';
import { clientIp, RateLimiter } from './rateLimit';
import { runTool, toJson, type ToolResult } from './runner';
import { findTool } from './registry';
import type { AgentDeps } from './tools';
import { TtlCache } from './ttlCache';

/// JSON tool bodies are tiny; upload_image carries up to 512 KB of base64.
export const MAX_JSON_BODY = 16 * 1024;
export const MAX_UPLOAD_BODY = 768 * 1024;
export const MAX_MCP_BODY = 768 * 1024;
/// Per-IP ceiling on raw MCP messages (initialize, tools/list, ...), on top of tool limits.
export const MCP_MESSAGE_RATE = { limit: 240, windowMs: 60_000 };

export interface HttpContext {
  deps: AgentDeps;
  limiter: RateLimiter;
  cache: TtlCache;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(toJson(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
}

function toolResponse(res: ToolResult): Response {
  const extra: Record<string, string> = {};
  if (res.retryAfter) extra['retry-after'] = String(res.retryAfter);
  return json(res.body, res.status, extra);
}

export async function handleRestRequest(req: Request, toolName: string, ctx: HttpContext): Promise<Response> {
  const tool = findTool(toolName);
  const ip = clientIp(req.headers);
  if (!tool) return toolResponse(await runTool(toolName, {}, { ...ctx, ip, source: 'rest' }));

  let input: unknown;
  if (req.method === 'GET') {
    if (tool.postOnly) return json({ ok: false, tool: tool.name, error: { code: 'METHOD', message: 'use POST with a JSON body' } }, 405, { allow: 'POST' });
    const url = new URL(req.url);
    if (url.search.length > 4096) return json({ ok: false, tool: tool.name, error: { code: 'TOO_LARGE', message: 'query string too long' } }, 414);
    const q: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      if (k in q) return json({ ok: false, tool: tool.name, error: { code: 'INVALID_INPUT', message: `"${k.slice(0, 40)}" given more than once` } }, 400);
      q[k] = v;
    }
    input = q;
  } else if (req.method === 'POST') {
    try {
      input = await readJsonBody(req, tool.postOnly ? MAX_UPLOAD_BODY : MAX_JSON_BODY);
    } catch (err) {
      const e = err as BodyError;
      return json({ ok: false, tool: tool.name, error: { code: e.status === 413 ? 'TOO_LARGE' : 'INVALID_BODY', message: e.message } }, e.status ?? 400);
    }
  } else {
    return json({ ok: false, error: { code: 'METHOD', message: 'use GET or POST' } }, 405, { allow: 'GET, POST' });
  }
  return toolResponse(await runTool(tool.name, input, { ...ctx, ip, coerce: req.method === 'GET', source: 'rest' }));
}

export async function handleMcpRequest(req: Request, ctx: HttpContext): Promise<Response> {
  if (req.method !== 'POST') {
    // Stateless server: no SSE stream to resume, no session to delete.
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const pv = req.headers.get('mcp-protocol-version');
  if (pv && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(pv)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${pv.slice(0, 20)}` } }, 400);
  }
  const ip = clientIp(req.headers);
  const gate = ctx.limiter.check(`mcp:${ip}`, MCP_MESSAGE_RATE);
  if (!gate.ok) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `rate limited; retry in ${gate.retryAfter}s` } }, 429, { 'retry-after': String(gate.retryAfter) });
  }
  let msg: unknown;
  try {
    msg = await readJsonBody(req, MAX_MCP_BODY);
  } catch (err) {
    const e = err as BodyError;
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }, e.status ?? 400);
  }
  const reply = await handleMcpMessage(msg, { ...ctx, ip, source: 'mcp' });
  if (reply.body === null) return new Response(null, { status: 202 });
  return json(reply.body, 200);
}

/// Process-wide limiter + cache shared by every v2 route and the MCP route, so an
/// IP's budget is the same whichever door it uses.
let shared: { limiter: RateLimiter; cache: TtlCache } | null = null;
export function sharedState() {
  if (!shared) shared = { limiter: new RateLimiter(), cache: new TtlCache() };
  return shared;
}
