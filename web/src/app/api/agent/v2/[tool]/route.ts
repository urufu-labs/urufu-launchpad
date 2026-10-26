/// /api/agent/v2/<tool>: the v2 agent API (phase 1a, docs/PLAN-agents-and-swarms.md).
///
/// One route for every tool so REST and MCP share a single code path
/// (lib/agentV2). Tool names accept kebab or snake case: /api/agent/v2/name-check
/// and /api/agent/v2/name_check are the same tool. GET takes query params, POST a
/// JSON body (upload-image is POST only). v1 routes under /api/agent/* are unchanged.

import type { NextRequest } from 'next/server';

import { productionDeps } from '@/lib/agentV2/deps';
import { handleRestRequest, sharedState } from '@/lib/agentV2/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  return handleRestRequest(req, tool, { deps: productionDeps(), ...sharedState() });
}

export const GET = handle;
export const POST = handle;
