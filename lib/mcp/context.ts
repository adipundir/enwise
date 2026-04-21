import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Authenticated context attached to every MCP tool invocation.
 * Populated by lib/mcp/auth.ts from the bearer token.
 */
export interface EnwiseCtx {
  businessId: string;
  tokenId: string;
}

export function authInfoForCtx(
  ctx: EnwiseCtx,
  rawToken: string,
): AuthInfo {
  return {
    token: rawToken,
    clientId: ctx.tokenId,
    scopes: [],
    extra: { businessId: ctx.businessId, tokenId: ctx.tokenId },
  };
}

export function ctxFromAuthInfo(authInfo: AuthInfo | undefined): EnwiseCtx {
  const extra = authInfo?.extra as
    | { businessId?: string; tokenId?: string }
    | undefined;
  if (!extra?.businessId || !extra?.tokenId) {
    throw new Error("MCP tool handler missing business context");
  }
  return { businessId: extra.businessId, tokenId: extra.tokenId };
}
