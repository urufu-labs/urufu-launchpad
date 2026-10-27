/// GET /api/agent/v2: index of the v2 agent tools, their input schemas, and where
/// the MCP endpoint and the skill file live.

import { NextResponse } from 'next/server';

import { MCP_PROTOCOL_VERSIONS } from '@/lib/agentV2/mcp';
import { AGENT_TOOLS } from '@/lib/agentV2/registry';
import { UNTRUSTED_NOTICE } from '@/lib/agentV2/untrusted';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    version: 2,
    chainId: 4663,
    skill: 'https://urufulabs.xyz/agent-skill.md',
    mcp: { url: 'https://urufulabs.xyz/api/mcp', transport: 'streamable-http', protocolVersions: MCP_PROTOCOL_VERSIONS },
    rules: [
      'No tool accepts or asks for a private key. Every transaction is returned unsigned.',
      'Assistant mode: show the human the final numbers and get a yes before every transaction.',
      UNTRUSTED_NOTICE,
    ],
    tools: AGENT_TOOLS.map((t) => ({
      name: t.name,
      path: `/api/agent/v2/${t.name.replace(/_/g, '-')}`,
      methods: t.postOnly ? ['POST'] : ['GET', 'POST'],
      description: t.description,
      inputSchema: t.inputSchema,
      rateLimitPerMinute: t.rate.limit,
    })),
  });
}
