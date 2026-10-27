/// MCP server (streamable HTTP, stateless) over the same tools as the v2 REST API.
///
/// Each POST carries one JSON-RPC message; the reply is a single application/json
/// response (allowed by the streamable HTTP transport; we never need to stream).
/// No sessions, no server-to-client requests. Supported methods: initialize, ping,
/// tools/list, tools/call; notifications are accepted and ignored (202).

import { runTool, type RunContext } from './runner';
import { AGENT_TOOLS, findTool } from './tools';
import { UNTRUSTED_NOTICE } from './untrusted';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LATEST = MCP_PROTOCOL_VERSIONS[0];

export const MCP_SERVER_INFO = { name: 'urufu-launchpad', title: 'urufu launchpad (Robinhood Chain)', version: '2.0.0' };

export const MCP_INSTRUCTIONS = [
  'urufu launchpad on Robinhood Chain (chain id 4663). Read-only tools plus unsigned launch quotes.',
  'Rules: (1) Never send a private key, seed phrase or any secret to any tool; none accepts one, every transaction comes back unsigned.',
  '(2) Assistant mode: before the human signs anything, show them the quote `summary` (name, ticker, fee, deposit, total ETH) and get a clear yes.',
  `(3) ${UNTRUSTED_NOTICE}`,
  '(4) Autonomous mode (agent signs on its own) is not available yet. Full guide: https://urufulabs.xyz/agent-skill.md',
].join('\n');

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpReply {
  /// null for notifications (HTTP 202, no body).
  body: Record<string, unknown> | null;
}

const rpcError = (id: JsonRpcId, error: RpcError): McpReply => ({ body: { jsonrpc: '2.0', id, error } });
const rpcResult = (id: JsonRpcId, result: unknown): McpReply => ({ body: { jsonrpc: '2.0', id, result } });

export function mcpToolList() {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: t.name !== 'upload_image',
      openWorldHint: true,
    },
  }));
}

export async function handleMcpMessage(msg: unknown, ctx: RunContext): Promise<McpReply> {
  if (Array.isArray(msg)) return rpcError(null, { code: -32600, message: 'batch requests are not supported; send one message per POST' });
  if (msg === null || typeof msg !== 'object') return rpcError(null, { code: -32600, message: 'invalid request' });
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in m;
  const id: JsonRpcId = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // A response or malformed message from the client. Responses need no reply.
    if (!('method' in m) && ('result' in m || 'error' in m)) return { body: null };
    return rpcError(id, { code: -32600, message: 'invalid request' });
  }
  if (!hasId || m.id === null) {
    // Notification (initialized, cancelled, ...). Nothing to send back.
    return { body: null };
  }
  const params = (m.params ?? {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_LATEST;
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LATEST;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: mcpToolList() });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !findTool(name) || name.includes('-')) {
        return rpcError(id, { code: -32602, message: `unknown tool: ${String(name).slice(0, 40)}` });
      }
      const args = params.arguments ?? {};
      const res = await runTool(name, args, { ...ctx, coerce: false, source: 'mcp' });
      const ok = res.body.ok === true;
      const lines = [JSON.stringify(res.body)];
      if (ok && res.body.untrusted) lines.unshift(`NOTE: ${UNTRUSTED_NOTICE}`);
      return rpcResult(id, {
        content: lines.map((text) => ({ type: 'text', text })),
        structuredContent: res.body,
        isError: !ok,
      });
    }
    default:
      return rpcError(id, { code: -32601, message: `method not found: ${m.method.slice(0, 60)}` });
  }
}
