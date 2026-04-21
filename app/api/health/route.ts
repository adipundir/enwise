import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight uptime probe. Runs one ping against Neon so the endpoint
 * tells you whether the app can talk to its database, not just whether
 * the server is listening.
 */
export async function GET(): Promise<Response> {
  const started = Date.now();
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const ms = Date.now() - started;

  return Response.json(
    {
      ok: dbOk,
      db_ok: dbOk,
      latency_ms: ms,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
      timestamp: new Date().toISOString(),
    },
    { status: dbOk ? 200 : 503 },
  );
}
