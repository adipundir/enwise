import { z } from "zod";
import {
  getClientSummary,
  getOutstandingInvoices,
  getRevenueSummary,
} from "@/lib/analytics";
import { ctxFromAuthInfo } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const uuid = z.string().uuid();

export function registerAnalyticsTools(server: McpServer) {
  server.registerTool(
    "get_client_summary",
    {
      title: "Client summary",
      description:
        "Return lifetime invoicing summary for a single client, grouped by currency (never mixed): total billed, total paid, outstanding (sum of sent-but-unpaid), invoice count, and last invoice date. Use this when the user asks things like 'how much has Acme paid me this year?' or 'what does Acme still owe?'.",
      inputSchema: { client_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({ client_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const summary = await getClientSummary(ctx, parsed.data.client_id);
      if (!summary) {
        return toolError("not_found", `No client with id ${parsed.data.client_id}.`);
      }
      return toolOk(summary);
    },
  );

  server.registerTool(
    "get_revenue_summary",
    {
      title: "Revenue summary",
      description:
        "Revenue grouped by period (month/quarter/year) and currency, plus top 5 clients in the window. Windows: month → last 12 months, quarter → last 12 months, year → last 5 years. Totals never sum across currencies.",
      inputSchema: {
        period: z.enum(["month", "quarter", "year"]).optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({ period: z.enum(["month", "quarter", "year"]).optional() })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const summary = await getRevenueSummary(ctx, {
        period: parsed.data.period ?? "month",
      });
      return toolOk(summary);
    },
  );

  server.registerTool(
    "get_outstanding_invoices",
    {
      title: "Outstanding invoices",
      description:
        "List sent invoices that haven't been paid. Sorted by due_date ascending (most urgent first). Optional client_id filter scopes to one client; overdue_only=true limits to due_date < today.",
      inputSchema: {
        client_id: uuid.optional(),
        overdue_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          client_id: uuid.optional(),
          overdue_only: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const rows = await getOutstandingInvoices(ctx, {
        clientId: parsed.data.client_id,
        overdueOnly: parsed.data.overdue_only,
        limit: parsed.data.limit,
      });
      return toolOk({ invoices: rows });
    },
  );
}
