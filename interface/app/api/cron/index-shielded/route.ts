import type { NextRequest } from "next/server";
import { indexShieldedEvents } from "@/lib/private/indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron — scans EnwisePay.Shielded events and links noteIds onto
 * invoices that paid via the relayer endpoint. Runs every 2 minutes per
 * vercel.json.
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
    const result = await indexShieldedEvents();
    return json(200, { ok: true, ...result });
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
