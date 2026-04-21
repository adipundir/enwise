import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const LIMIT_PER_MINUTE = 180;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * DB-backed per-token rate limiter. One row per (token, minute). UPSERT
 * increments atomically. The count returned is the caller's place in line for
 * the current minute; if it exceeds the limit, reject.
 *
 * Cheap: indexed primary key, single round-trip per request.
 */
export async function hitRateLimit(tokenId: string): Promise<RateLimitResult> {
  const result = await db.execute(sql`
    insert into rate_buckets (token_id, window_start, count)
    values (${tokenId}, date_trunc('minute', now()), 1)
    on conflict (token_id, window_start)
    do update set count = rate_buckets.count + 1
    returning count
  `);
  const row = result.rows[0] as { count: number | string } | undefined;
  const count = row ? Number(row.count) : 1;
  const remaining = Math.max(0, LIMIT_PER_MINUTE - count);
  const nowSec = Math.floor(Date.now() / 1000);
  const retryAfter = 60 - (nowSec % 60);
  return {
    allowed: count <= LIMIT_PER_MINUTE,
    remaining,
    limit: LIMIT_PER_MINUTE,
    retryAfterSeconds: retryAfter,
  };
}

/**
 * Housekeeping: drop rows older than the given cutoff. Called from the daily
 * cron to keep the bucket table tiny. No need for a dedicated cleanup job.
 */
export async function pruneRateBuckets(olderThanMinutes = 60): Promise<number> {
  const result = await db.execute(sql`
    with deleted as (
      delete from rate_buckets
      where window_start < (now() - make_interval(mins => ${olderThanMinutes}))
      returning 1
    )
    select count(*)::int as n from deleted
  `);
  const row = result.rows[0] as { n: number | string } | undefined;
  return row ? Number(row.n) : 0;
}
