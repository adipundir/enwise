import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyKeys } from "@/lib/db/schema";
import type { EnvoiceCtx } from "@/lib/mcp/context";

const DEFAULT_TTL_HOURS = 24;

/**
 * Wrap an operation with idempotency. If `clientRequestId` is null/empty, the
 * operation runs unconditionally. Otherwise the first call persists its
 * response; repeat calls within the TTL return the cached response without
 * re-executing.
 *
 * Safe under concurrency: the unique index on (business_id, tool_name, client_request_id)
 * causes the second concurrent inserter to throw, which we catch and treat
 * as "the other caller is doing the work". we then fetch the cached value,
 * spinning a few times if it isn't written yet.
 */
export async function withIdempotency<T>(
  ctx: EnvoiceCtx,
  toolName: string,
  clientRequestId: string | null | undefined,
  run: () => Promise<T>,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<T> {
  if (!clientRequestId) {
    return run();
  }
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  // 1. Fast path: cached hit?
  const cached = await readCached<T>(ctx.businessId, toolName, clientRequestId);
  if (cached !== undefined) return cached;

  // 2. Try to claim the slot by inserting a pending placeholder.
  try {
    await db.insert(idempotencyKeys).values({
      businessId: ctx.businessId,
      toolName,
      clientRequestId,
      responseJson: null,
      expiresAt,
    });
  } catch {
    // Concurrent insert. the other caller is running. Wait briefly for the
    // cached response to materialize.
    return waitForCached<T>(ctx.businessId, toolName, clientRequestId, run);
  }

  // 3. We claimed it. Run the operation, persist the result.
  const value = await run();
  await db
    .update(idempotencyKeys)
    .set({ responseJson: value as unknown as Record<string, unknown> })
    .where(
      and(
        eq(idempotencyKeys.businessId, ctx.businessId),
        eq(idempotencyKeys.toolName, toolName),
        eq(idempotencyKeys.clientRequestId, clientRequestId),
      ),
    );
  return value;
}

async function readCached<T>(
  businessId: string,
  toolName: string,
  clientRequestId: string,
): Promise<T | undefined> {
  const [row] = await db
    .select({ response: idempotencyKeys.responseJson })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.businessId, businessId),
        eq(idempotencyKeys.toolName, toolName),
        eq(idempotencyKeys.clientRequestId, clientRequestId),
        gt(idempotencyKeys.expiresAt, sql`now()`),
      ),
    );
  if (!row) return undefined;
  if (row.response === null) return undefined; // pending slot
  return row.response as T;
}

async function waitForCached<T>(
  businessId: string,
  toolName: string,
  clientRequestId: string,
  fallback: () => Promise<T>,
): Promise<T> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const cached = await readCached<T>(businessId, toolName, clientRequestId);
    if (cached !== undefined) return cached;
  }
  // The other caller never finished or crashed before writing. Run fresh and
  // overwrite the pending slot so this token isn't stuck forever.
  const value = await fallback();
  await db
    .update(idempotencyKeys)
    .set({ responseJson: value as unknown as Record<string, unknown> })
    .where(
      and(
        eq(idempotencyKeys.businessId, businessId),
        eq(idempotencyKeys.toolName, toolName),
        eq(idempotencyKeys.clientRequestId, clientRequestId),
      ),
    );
  return value;
}
