/// POST /api/mcp: MCP server (streamable HTTP, stateless, JSON responses) exposing
/// the same tools as /api/agent/v2/* through lib/agentV2. Read tools and unsigned
/// launch quotes only; no tool accepts or asks for a key.

import type { NextRequest } from 'next/server';

import { productionDeps } from '@/lib/agentV2/deps';
import { handleMcpRequest, sharedState } from '@/lib/agentV2/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  return handleMcpRequest(req, { deps: productionDeps(), ...sharedState() });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
