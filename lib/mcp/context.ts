import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { toolError } from "@/lib/mcp/errors";

/**
 * Authenticated context attached to every MCP tool invocation.
 * Populated by lib/mcp/auth.ts from the bearer token.
 *
 * A token authenticates a USER. A user can own many businesses; tools
 * that mutate or read business-scoped data must resolve which business
 * to act on via `resolveBusinessId()`.
 */
export interface EnwiseCtx {
  userId: string;
  tokenId: string;
}

/**
 * Context scoped to a specific business. Produced at the MCP tool boundary
 * by resolving `business_id` (explicit or fallback). The service layer
 * (lib/invoices, lib/clients, …) takes this so every `.where()` naturally
 * filters by `businessId` without re-plumbing the userId at every layer.
 */
export interface ScopedCtx extends EnwiseCtx {
  businessId: string;
}

export function authInfoForCtx(
  ctx: EnwiseCtx,
  rawToken: string,
): AuthInfo {
  return {
    token: rawToken,
    clientId: ctx.tokenId,
    scopes: [],
    extra: { userId: ctx.userId, tokenId: ctx.tokenId },
  };
}

export function ctxFromAuthInfo(authInfo: AuthInfo | undefined): EnwiseCtx {
  const extra = authInfo?.extra as
    | { userId?: string; tokenId?: string }
    | undefined;
  if (!extra?.userId || !extra?.tokenId) {
    throw new Error("MCP tool handler missing user context");
  }
  return { userId: extra.userId, tokenId: extra.tokenId };
}

export type ResolveBusinessResult =
  | { ok: true; businessId: string }
  | {
      ok: false;
      code: "multiple_businesses" | "no_businesses" | "business_not_found";
      message: string;
      hint: string;
      suggestions?: Array<{ business_id: string; name: string }>;
    };

/**
 * Pick which business a tool call should operate on.
 *
 * - Explicit `business_id` passed → validate it belongs to `ctx.userId` and use it.
 * - No arg, user owns exactly one business → use it silently.
 * - No arg, user owns multiple → refuse with `multiple_businesses` and list them
 *   so Claude can ask the user which one.
 * - No arg, user owns zero → refuse with `no_businesses` (shouldn't happen in
 *   practice; signup always mints one).
 */
export async function resolveBusinessId(
  ctx: EnwiseCtx,
  businessIdArg: string | undefined | null,
): Promise<ResolveBusinessResult> {
  if (businessIdArg) {
    const [row] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(
        and(
          eq(businesses.id, businessIdArg),
          eq(businesses.ownerUserId, ctx.userId),
        ),
      );
    if (!row) {
      return {
        ok: false,
        code: "business_not_found",
        message: `No business with id ${businessIdArg} belongs to the authenticated user.`,
        hint: "Call `whoami` to list the businesses this token can act on.",
      };
    }
    return { ok: true, businessId: row.id };
  }

  const owned = await db
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.ownerUserId, ctx.userId))
    .orderBy(asc(businesses.createdAt));

  if (owned.length === 0) {
    return {
      ok: false,
      code: "no_businesses",
      message: "This user has no businesses.",
      hint: "Call `create_business` to set one up before creating invoices.",
    };
  }
  if (owned.length === 1) {
    return { ok: true, businessId: owned[0]!.id };
  }
  return {
    ok: false,
    code: "multiple_businesses",
    message:
      "This user owns multiple businesses. Ask the user which one to use and pass `business_id` on the next call.",
    hint: "Show the user the list in `suggestions` and ask which business this action should happen under. Don't guess.",
    suggestions: owned.map((b) => ({ business_id: b.id, name: b.name })),
  };
}

/**
 * Boilerplate for every business-scoped MCP tool handler. Resolves
 * `business_id` (explicit or fallback) and returns a `ScopedCtx` ready to
 * hand to the service layer, or a pre-built `CallToolResult` error the
 * handler can return directly.
 */
export async function scopeFromCtx(
  ctx: EnwiseCtx,
  businessIdArg: string | undefined | null,
): Promise<
  | { ok: true; scoped: ScopedCtx }
  | { ok: false; error: CallToolResult }
> {
  const r = await resolveBusinessId(ctx, businessIdArg);
  if (!r.ok) {
    return {
      ok: false,
      error: toolError(r.code, r.message, {
        hint: r.hint,
        suggestions: r.suggestions,
      }),
    };
  }
  return {
    ok: true,
    scoped: { ...ctx, businessId: r.businessId },
  };
}
