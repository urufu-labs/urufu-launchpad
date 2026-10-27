/// Every v2 / MCP tool, in the order `tools/list` shows them.

import { agentIdentityTools } from './agentTools';
import { CORE_TOOLS, type ToolDef } from './tools';
import { TRADE_TOOLS } from './tradeTools';

export const AGENT_TOOLS: ReadonlyArray<ToolDef<never>> = [...CORE_TOOLS, ...TRADE_TOOLS, ...agentIdentityTools];

export function findTool(name: string): ToolDef<Record<string, unknown>> | undefined {
  const n = name.replace(/-/g, '_');
  return AGENT_TOOLS.find((t) => t.name === n) as ToolDef<Record<string, unknown>> | undefined;
}
