/// Shared request pipeline for v2 REST and MCP: secret-field guard, per-IP rate
/// limits (per tool + overall), schema validation, cached reads, and the response
/// envelope that keeps computed `data` apart from user-written `untrusted` text.

import { RateLimiter } from './rateLimit';
import { assertNoSecretFields, ToolInputError, validateInput } from './schema';
import { AGENT_TOOLS, AGENT_V2_CHAIN_ID, findTool, ToolError, type AgentDeps } from './tools';
import { TtlCache } from './ttlCache';

/// Ceiling across all tools for one IP, on top of each tool's own limit.
export const GLOBAL_RATE = { limit: 120, windowMs: 60_000 };

export interface RunContext {
  ip: string;
  deps: AgentDeps;
  limiter: RateLimiter;
  cache: TtlCache;
  /// Coerce query-string values (REST GET).
  coerce?: boolean;
  source: 'rest' | 'mcp';
}

export interface ToolResult {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableKey((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const fail = (tool: string, status: number, code: string, message: string, retryAfter?: number): ToolResult => ({
  status,
  retryAfter,
  body: { ok: false, tool, chainId: AGENT_V2_CHAIN_ID, error: { code, message } },
});

export async function runTool(name: string, rawInput: unknown, ctx: RunContext): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return fail(name.slice(0, 40), 404, 'UNKNOWN_TOOL', `no tool named "${name.slice(0, 40)}". tools: ${AGENT_TOOLS.map((t) => t.name).join(', ')}`);

  // Secrets are refused before anything else, including rate accounting.
  try {
    assertNoSecretFields(rawInput);
  } catch (err) {
    const e = err as ToolInputError;
    return fail(tool.name, 400, e.code, e.message);
  }

  const all = ctx.limiter.check(`ip:${ctx.ip}`, GLOBAL_RATE);
  if (!all.ok) return fail(tool.name, 429, 'RATE_LIMITED', `too many requests; retry in ${all.retryAfter}s`, all.retryAfter);
  const per = ctx.limiter.check(`tool:${tool.name}:${ctx.ip}`, tool.rate);
  if (!per.ok) return fail(tool.name, 429, 'RATE_LIMITED', `too many ${tool.name} calls; retry in ${per.retryAfter}s`, per.retryAfter);

  let input: Record<string, unknown>;
  try {
    input = validateInput(tool.inputSchema, rawInput, ctx.coerce ?? false);
  } catch (err) {
    if (err instanceof ToolInputError) return fail(tool.name, 400, err.code, err.message);
    throw err;
  }

  try {
    const run = () => tool.handler(ctx.deps, input);
    const out = tool.cacheTtlMs > 0 ? await ctx.cache.get(`${tool.name}:${stableKey(input)}`, tool.cacheTtlMs, run) : await run();
    const body: Record<string, unknown> = { ok: true, tool: tool.name, chainId: AGENT_V2_CHAIN_ID, data: out.data };
    if (out.untrusted) body.untrusted = out.untrusted;
    return { status: 200, body };
  } catch (err) {
    if (err instanceof ToolError) return fail(tool.name, err.status, err.code, err.message);
    if (err instanceof ToolInputError) return fail(tool.name, 400, err.code, err.message);
    console.error(`[agent-v2] ${tool.name} failed`, err);
    return fail(tool.name, 502, 'UPSTREAM', 'upstream read failed; try again shortly');
  }
}

/// JSON with bigints as strings (handlers already stringify; this is a backstop).
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}
