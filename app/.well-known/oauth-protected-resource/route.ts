import type { NextRequest } from "next/server";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Claude Code's MCP client follows the WWW-Authenticate `resource_metadata`
 * pointer here when probing how to authenticate against /api/mcp. enwise
 * uses static bearer tokens minted from the dashboard, not an OAuth flow,
 * so this document advertises bearer-in-header as the only supported method
 * and points clients at the dashboard for token issuance.
 */
export function GET(req: NextRequest): Response {
  const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  return Response.json(
    {
      resource: `${baseUrl}/api/mcp`,
      bearer_methods_supported: ["header"],
      resource_documentation: `${baseUrl}/dashboard/connect`,
    },
    {
      headers: {
        // Cache briefly. metadata is stable across deploys.
        "cache-control": "public, max-age=300",
      },
    },
  );
}
