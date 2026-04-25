/**
 * One-shot script to smoke-test the MCP endpoint end-to-end.
 *
 * - Inserts a throwaway user + business + api_token
 * - Calls /api/mcp with `tools/list` and `tools/call whoami`
 * - Deletes the throwaway records
 *
 * Usage: npm run smoke:mcp   (see package.json)
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { apiTokens, businesses, users } from "./schema";
import { generateRawToken, hashToken, tokenPrefix } from "@/lib/tokens";

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

async function main() {
  console.log(`smoke-mcp: target ${BASE_URL}/api/mcp`);

  // 1. Create throwaway user + business
  const [user] = await db
    .insert(users)
    .values({
      email: `smoke+${Date.now()}@envoice.test`,
      name: "Smoke Test",
    })
    .returning();
  if (!user) throw new Error("failed to insert user");

  const [business] = await db
    .insert(businesses)
    .values({
      ownerUserId: user.id,
      name: "Smoke Test Co",
      slug: `smoke-${Date.now()}`,
    })
    .returning();
  if (!business) throw new Error("failed to insert business");

  await db
    .update(users)
    .set({ defaultBusinessId: business.id })
    .where(eq(users.id, user.id));

  // 2. Create a token
  const raw = generateRawToken();
  await db.insert(apiTokens).values({
    businessId: business.id,
    createdByUserId: user.id,
    name: "smoke",
    tokenHash: hashToken(raw),
    tokenPrefix: tokenPrefix(raw),
  });

  console.log("created throwaway business +", raw.slice(0, 16) + "…");

  // 3. Call /api/mcp tools/list
  const listResp = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${raw}`,
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
  console.log(`tools/list → HTTP ${listResp.status}`);
  const listBody = await listResp.json();
  const tools =
    (listBody as { result?: { tools?: Array<{ name: string }> } }).result?.tools
      ?.map((t) => t.name) ?? [];
  console.log(`  tools: [${tools.join(", ")}]`);

  // 4. Call whoami
  const whoResp = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${raw}`,
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  console.log(`whoami      → HTTP ${whoResp.status}`);
  const whoBody = (await whoResp.json()) as {
    result?: { structuredContent?: unknown };
    error?: unknown;
  };
  console.log(
    "  result:",
    JSON.stringify(whoBody.result?.structuredContent ?? whoBody, null, 2),
  );

  // 5. Cleanup
  await db.delete(users).where(eq(users.id, user.id));
  console.log("cleaned up");
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
