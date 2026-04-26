import { runDueNow } from "@/lib/recurring";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron entry point. fires daily at 09:00 UTC per vercel.json.
 *
 * Auth: Vercel sets the `x-vercel-cron` header on legitimate cron invocations
 * AND sends `Authorization: Bearer <CRON_SECRET>`. We require both.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const vercelHeader = req.headers.get("x-vercel-cron");

  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const presentedSecret = bearerMatch?.[1]?.trim();

  if (!expected) {
    return json(503, {
      ok: false,
      error: "CRON_SECRET is not configured on this server.",
    });
  }
  if (!vercelHeader && presentedSecret !== expected) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (vercelHeader && presentedSecret !== expected) {
    // Vercel cron header present but secret wrong. suspicious.
    return json(401, { ok: false, error: "unauthorized" });
  }

  const results = await runDueNow();
  const summary = {
    ok: true,
    processed: results.length,
    generated: results.filter((r) => r.status === "generated").length,
    auto_sent: results.filter((r) => r.status === "auto_sent").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  };
  return json(200, summary);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
