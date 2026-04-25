import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { createMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  const authResult = await authenticateMcpRequest(request);
  if (!authResult.ok) return authResult.response;

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — no cross-request session state. Every call re-authenticates.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(request, {
      authInfo: authResult.authInfo,
    });
  } finally {
    // Best-effort cleanup; transport is per-request so this is important
    // to release any dangling listeners when the response is sent.
    await server.close().catch(() => {});
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
