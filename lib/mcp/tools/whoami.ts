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
        hint: buildHint(business, Number(clientCount ?? 0)),
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

const WRITING_STYLE = `Invoice writing style — keep each field crisp and in its own lane:
- line item description = product or service name only (e.g. "MacBook Pro 14\\" M5 Pro (24GB/1TB)", "Claude Max subscription"). No "Reimbursement:" prefix, no reference numbers, no dates, no conversion math.
- invoice notes = context for the whole invoice (reimbursement framing, FX notes, reference numbers). E.g. "Reimbursement for work laptop. Converted from INR 246,400 at 93.75 INR/USD. See attached Apple invoice."
- attachments = the actual receipt/PDF. Don't retype its contents into the description.

When converting currency, include the source (mid-market rate, where you looked it up) in the notes so the client can verify.`;

function buildHint(
  business: { name: string; addressLine1: string | null; country: string | null; taxId: string | null },
  clientCount: number,
): string {
  const profileEmpty =
    !business.addressLine1 && !business.country && !business.taxId;

  if (profileEmpty && clientCount === 0) {
    return `FRESH ACCOUNT. Walk the user through setup, step by step, in this order:

STEP 1 — Business profile. Ask for: (a) business name (current: "${business.name}" — confirm or change), (b) address + country, (c) default currency (USD if unspecified), (d) tax ID if applicable. Save with update_business_profile.

STEP 2 — First client. After the profile is saved, offer to add their first client. Ask for: client name, email, and address. Save with create_client. Do NOT add a client before the business profile is saved.

STEP 3 — After both are done, tell the user they're ready to invoice. Ask what they'd like to bill the client for (description, quantity, unit price). Only then call create_invoice.

Do NOT invent data at any step. Do NOT create a sample/demo invoice. If the user says "just demo it" or "make something up", refuse and explain that invoices are real business records — ask for real details instead.`;
  }

  if (profileEmpty) {
    return `Business profile "${business.name}" is incomplete (no address/tax ID). Before sending any invoices, ask the user to fill in their address and tax ID so real invoices look right. Use update_business_profile.`;
  }

  if (clientCount === 0) {
    return `Business "${business.name}" is configured but has no clients yet. Offer to add the user's first client — ask for name, email, and address, then use create_client. Do not invent a client. After the client is saved, ask what they'd like to bill for and call create_invoice.\n\n${WRITING_STYLE}`;
  }

  return `Business "${business.name}" has ${clientCount} client${clientCount === 1 ? "" : "s"}. Ask the user what they'd like to do. Use find_client to resolve names they mention.\n\n${WRITING_STYLE}`;
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
