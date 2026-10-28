/// Every v2 / MCP tool, in the order `tools/list` shows them.

import { ACCOUNT_TOOLS } from './accountTools';
import { agentIdentityTools } from './agentTools';
import { AGENT_TOKEN_TOOLS } from './agentTokenTools';
import { METADATA_TOOLS } from './metadataTools';
import { SWARM_TOOLS } from './swarmTools';
import { CORE_TOOLS, type ToolDef } from './tools';
import { TRADE_TOOLS } from './tradeTools';

export const AGENT_TOOLS: ReadonlyArray<ToolDef<never>> = [...CORE_TOOLS, ...METADATA_TOOLS, ...TRADE_TOOLS, ...agentIdentityTools, ...ACCOUNT_TOOLS, ...AGENT_TOKEN_TOOLS, ...SWARM_TOOLS];

export function findTool(name: string): ToolDef<Record<string, unknown>> | undefined {
  const n = name.replace(/-/g, '_');
  return AGENT_TOOLS.find((t) => t.name === n) as ToolDef<Record<string, unknown>> | undefined;
}
