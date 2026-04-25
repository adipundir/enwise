import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { businesses, clients, invoices } from "@/lib/db/schema";
import { ctxFromAuthInfo } from "@/lib/mcp/context";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const outputSchema = {
  business: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    default_currency: z.string(),
    invoice_number_prefix: z.string(),
    invoice_number_next: z.number(),
    logo_url: z.string().nullable(),
    legal_name: z.string().nullable(),
    tax_id: z.string().nullable(),
    address_line1: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
  }),
  stats: z.object({
    client_count: z.number(),
    invoice_count: z.number(),
  }),
  hint: z.string(),
};

export function registerWhoami(server: McpServer) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I?",
      description:
        "Return the current business profile + quick stats. Call this at the start of a session so you have free context about the user's business before other tool calls.",
      outputSchema,
    },
    async (extra) => {
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const [business] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, ctx.businessId));
      if (!business) {
        return toolError("Authenticated token has no associated business.");
      }

      const [{ value: clientCount }] = await db
        .select({ value: count() })
        .from(clients)
        .where(eq(clients.businessId, ctx.businessId));
      const [{ value: invoiceCount }] = await db
        .select({ value: count() })
        .from(invoices)
        .where(eq(invoices.businessId, ctx.businessId));

      const structured = {
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          default_currency: business.defaultCurrency,
          invoice_number_prefix: business.invoiceNumberPrefix,
          invoice_number_next: business.invoiceNumberNext,
          logo_url: business.logoUrl,
          legal_name: business.legalName,
          tax_id: business.taxId,
          address_line1: business.addressLine1,
          city: business.city,
          country: business.country,
        },
        stats: {
          client_count: Number(clientCount ?? 0),
          invoice_count: Number(invoiceCount ?? 0),
        },
        hint: buildHint(business.name, Number(clientCount ?? 0)),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(structured, null, 2),
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

function buildHint(name: string, clientCount: number): string {
  if (clientCount === 0) {
    return `Business "${name}" is set up but has no clients or invoices yet. Offer to help the user fill in their business profile (update_business_profile) or add their first client (create_client).`;
  }
  return `Business "${name}" has ${clientCount} client${clientCount === 1 ? "" : "s"}. Ask what they'd like to do next.`;
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
