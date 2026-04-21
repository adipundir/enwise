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

  // 4. Exercise each tool
  await callTool(raw, "whoami", {});
  await callTool(raw, "get_business_profile", {});
  await callTool(raw, "update_business_profile", {
    name: "Smoke Test Co (renamed)",
    tax_id: "TEST-123",
    default_currency: "eur",
    country: "gb",
  });

  // Clients
  const c1 = await callTool(raw, "create_client", {
    name: "Acme Corp",
    email: "ap@acme.example",
  });
  await callTool(raw, "create_client", {
    name: "Ácme Industries",
  });
  await callTool(raw, "create_client", {
    name: "Globex",
  });
  await callTool(raw, "find_client", { query: "acme" });
  await callTool(raw, "find_client", { query: "globex" });
  await callTool(raw, "find_client", { query: "zzz-nothing" });
  await callTool(raw, "list_clients", {});
  if (c1) {
    await callTool(raw, "update_client", {
      client_id: c1,
      phone: "+1-555-0100",
    });
  }

  // Products
  const p1 = await callTool(raw, "create_product", {
    name: "Logo design",
    unit_price: "2000",
    currency: "USD",
    default_tax_rate: "0.08",
  });
  await callTool(raw, "create_product", {
    name: "Website revisions",
    unit_price: 500,
    currency: "usd",
    sku: "WEB-REV",
  });
  await callTool(raw, "find_product", { query: "logo" });
  await callTool(raw, "find_product", { query: "WEB-REV" });
  await callTool(raw, "list_products", {});
  if (p1) {
    await callTool(raw, "archive_product", { product_id: p1 });
  }

  // Invoices
  if (c1) {
    const invoiceId = await callTool(raw, "create_invoice", {
      client_id: c1,
      line_items: [
        {
          description: "Q2 brand refresh",
          quantity: "1",
          unit_price: "5000",
          tax_rate: "0.08",
        },
        {
          description: "Rush fee",
          quantity: "1",
          unit_price: "500",
        },
      ],
      notes: "Thanks for your business!",
      terms: "Net 30",
    });
    if (invoiceId) {
      await callTool(raw, "get_invoice", { invoice_id: invoiceId });
      await callTool(raw, "add_line_item", {
        invoice_id: invoiceId,
        description: "Additional round of revisions",
        quantity: "2",
        unit_price: "250",
        tax_rate: "0.08",
      });
      await callTool(raw, "list_invoices", { client_id: c1 });
      await callTool(raw, "get_invoice_share_url", { invoice_id: invoiceId });
      // send_invoice: expected to fail with email_not_configured unless RESEND_API_KEY is set.
      await callTool(raw, "send_invoice", { invoice_id: invoiceId });
      await callTool(raw, "mark_invoice_paid", { invoice_id: invoiceId });
      await callTool(raw, "duplicate_invoice", { invoice_id: invoiceId });
      // Test immutability
      await callTool(raw, "update_invoice", {
        invoice_id: invoiceId,
        notes: "should fail — invoice is paid",
      });

      // Analytics
      await callTool(raw, "get_client_summary", { client_id: c1 });
      await callTool(raw, "get_revenue_summary", { period: "month" });
      await callTool(raw, "get_outstanding_invoices", {});

      // Recurring
      const recId = await callTool(raw, "create_recurring_invoice", {
        client_id: c1,
        interval: "monthly",
        start_date: new Date().toISOString().slice(0, 10),
        line_items: [
          { description: "Monthly retainer", quantity: "1", unit_price: "3000" },
        ],
      });
      await callTool(raw, "list_recurring_invoices", {});
      if (recId) {
        await callTool(raw, "run_recurring_invoice_now", { recurring_id: recId });
        await callTool(raw, "pause_recurring_invoice", { recurring_id: recId });
        await callTool(raw, "resume_recurring_invoice", { recurring_id: recId });
        await callTool(raw, "cancel_recurring_invoice", { recurring_id: recId });
      }

      // Verify PDF endpoint
      const inv = await callTool(raw, "get_invoice", { invoice_id: invoiceId });
      const slug = inv ? await fetchShareSlug(raw, invoiceId) : null;
      if (slug) {
        const pdfResp = await fetch(`${BASE_URL}/i/${slug}/pdf`);
        const ct = pdfResp.headers.get("content-type") ?? "";
        const size = Number(pdfResp.headers.get("content-length") ?? "0");
        const buf = await pdfResp.arrayBuffer();
        console.log(
          `${pdfResp.ok && ct.startsWith("application/pdf") ? "✓" : "✗"} pdf endpoint              HTTP ${pdfResp.status} (${ct}, ${size || buf.byteLength} bytes)`,
        );
      }
    }
  }

  // 5. Cleanup
  await db.delete(users).where(eq(users.id, user.id));
  console.log("cleaned up");
}

async function fetchShareSlug(token: string, invoiceId: string): Promise<string | null> {
  const resp = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name: "get_invoice_share_url", arguments: { invoice_id: invoiceId } },
    }),
  });
  const body = (await resp.json()) as {
    result?: { structuredContent?: { data?: { slug?: string } } };
  };
  return body.result?.structuredContent?.data?.slug ?? null;
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const resp = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await resp.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  const structured = body.result?.structuredContent;
  const ok = body.result?.isError !== true;
  const label = `${ok ? "✓" : "✗"} ${name.padEnd(26)} HTTP ${resp.status}`;
  console.log(label);
  if (structured) {
    const summary = summarizeStructured(structured);
    if (summary) console.log(`    ${summary}`);
    const id = (
      (structured as { data?: { id?: string } | null })?.data ?? null
    )?.id;
    return id ?? null;
  }
  return null;
}

function summarizeStructured(s: unknown): string {
  const obj = s as {
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  if (obj.ok === false && obj.error) {
    return `error: ${obj.error.code} — ${obj.error.message}`;
  }
  const d = obj.data as
    | {
        business?: { name?: string };
        name?: string;
        default_currency?: string;
        currency?: string;
        tax_id?: string | null;
        matches?: Array<{ name?: string; score?: number }>;
        clients?: unknown[];
        products?: unknown[];
        invoices?: unknown[];
        unit_price?: string;
        archived?: boolean;
        id?: string;
        invoice_number?: string;
        status?: string;
        total?: string;
        outstanding?: string;
        share_url?: string;
        url?: string;
      }
    | undefined;
  if (d?.business?.name) return `business: ${d.business.name}`;
  if (d?.matches) {
    return `matches: [${d.matches.map((m) => `${m.name} (${(m.score ?? 0).toFixed(2)})`).join(", ")}]`;
  }
  if (d?.clients) return `${d.clients.length} clients`;
  if (d?.products) return `${d.products.length} products`;
  if (d?.invoices) return `${d.invoices.length} invoices`;
  if (d?.invoice_number)
    return `${d.invoice_number} ${d.status} total=${d.total} ${d.currency}`;
  if (d?.url) return d.url;
  if (d?.unit_price)
    return `${d.name} — ${d.unit_price} ${d.currency} ${d.archived ? "(archived)" : ""}`.trim();
  if (d?.name)
    return `${d.name}${d.default_currency ? ` (${d.default_currency})` : ""}${d.archived ? " [archived]" : ""}`;
  return "";
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
