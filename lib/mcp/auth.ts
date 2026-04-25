import { authInfoForCtx, type EnvoiceCtx } from "@/lib/mcp/context";
import { hitRateLimit } from "@/lib/ratelimit";
import { resolveBearer } from "@/lib/tokens";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const BEARER_RE = /^Bearer\s+(.+)$/i;

export async function authenticateMcpRequest(
  request: Request,
): Promise<
  | { ok: true; ctx: EnvoiceCtx; authInfo: AuthInfo; rawToken: string }
  | { ok: false; response: Response }
> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(BEARER_RE);
  if (!match) {
    return { ok: false, response: unauthorized("missing_bearer") };
  }
  const rawToken = match[1]!.trim();
  const resolved = await resolveBearer(rawToken);
  if (!resolved) {
    return { ok: false, response: unauthorized("invalid_token") };
  }

  // Per-token rate limit. Cheap: single indexed UPSERT.
  const rl = await hitRateLimit(resolved.tokenId);
  if (!rl.allowed) {
    return { ok: false, response: rateLimited(rl.limit, rl.retryAfterSeconds) };
  }

  return {
    ok: true,
    ctx: resolved,
    rawToken,
    authInfo: authInfoForCtx(resolved, rawToken),
  };
}

function unauthorized(code: "missing_bearer" | "invalid_token"): Response {
  const message =
    code === "missing_bearer"
      ? "Missing Authorization: Bearer <token> header"
      : "Invalid or revoked API token";
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message, data: { reason: code } },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="envoice"',
      },
    },
  );
}

function rateLimited(limit: number, retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: `Rate limit exceeded: ${limit} requests per minute per token.`,
        data: { reason: "rate_limited", retry_after_seconds: retryAfter },
      },
      id: null,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      },
    },
  );
}
