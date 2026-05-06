import type { NextRequest } from "next/server";
import { sweepReadyNotes } from "@/lib/private/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron — sweeps shielded notes for invoices whose noteId has been
 * indexed but not yet unshielded. Runs every 5 minutes per vercel.json.
 *
 * Auth: same dual-check as recurring/. Vercel sets `x-vercel-cron` AND
 * `Authorization: Bearer <CRON_SECRET>` on legitimate invocations.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const vercelHeader = req.headers.get("x-vercel-cron");
  const presentedSecret = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!expected) {
    return json(503, { ok: false, error: "CRON_SECRET is not configured" });
  }
  if (!vercelHeader && presentedSecret !== expected) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (vercelHeader && presentedSecret !== expected) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  try {
    const results = await sweepReadyNotes();
    return json(200, {
      ok: true,
      processed: results.length,
      swept: results.filter((r) => r.status === "swept").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: message });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
