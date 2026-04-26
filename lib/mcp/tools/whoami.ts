import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { businesses, clients, invoices, users } from "@/lib/db/schema";
import { ctxFromAuthInfo } from "@/lib/mcp/context";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const businessSchema = z.object({
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
  client_count: z.number(),
  invoice_count: z.number(),
  profile_complete: z.boolean(),
});

const outputSchema = {
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    plan: z.enum(["free", "pro"]),
  }),
  businesses: z.array(businessSchema),
  default_business_id: z.string().nullable(),
  hint: z.string(),
};

export function registerWhoami(server: McpServer) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I?",
      description:
        "Return the authenticated user, every business this token can act on, and a directive hint. Call this at the start of a session. and again after `create_business`. so you know which businesses exist and which to act on before mutating anything.",
      outputSchema,
    },
    async (extra) => {
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          plan: users.plan,
          defaultBusinessId: users.defaultBusinessId,
        })
        .from(users)
        .where(eq(users.id, ctx.userId));
      if (!user) {
        return toolError("Authenticated token has no associated user.");
      }

      const owned = await db
        .select()
        .from(businesses)
        .where(eq(businesses.ownerUserId, ctx.userId))
        .orderBy(asc(businesses.createdAt));

      const businessesOut = await Promise.all(
        owned.map(async (b) => {
          const [{ value: clientCount }] = await db
            .select({ value: count() })
            .from(clients)
            .where(eq(clients.businessId, b.id));
          const [{ value: invoiceCount }] = await db
            .select({ value: count() })
            .from(invoices)
            .where(eq(invoices.businessId, b.id));
          const profileComplete = Boolean(
            b.addressLine1 || b.country || b.taxId,
          );
          return {
            id: b.id,
            name: b.name,
            slug: b.slug,
            default_currency: b.defaultCurrency,
            invoice_number_prefix: b.invoiceNumberPrefix,
            invoice_number_next: b.invoiceNumberNext,
            logo_url: b.logoUrl,
            legal_name: b.legalName,
            tax_id: b.taxId,
            address_line1: b.addressLine1,
            city: b.city,
            country: b.country,
            client_count: Number(clientCount ?? 0),
            invoice_count: Number(invoiceCount ?? 0),
            profile_complete: profileComplete,
          };
        }),
      );

      const structured = {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          plan: user.plan,
        },
        businesses: businessesOut,
        default_business_id: user.defaultBusinessId,
        hint: buildHint(businessesOut, user.defaultBusinessId),
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(structured, null, 2) },
        ],
        structuredContent: structured,
      };
    },
  );
}

const WRITING_STYLE = `Invoice writing style. each field has its own lane:
- line item description = product or service name only (e.g. "MacBook Pro 14\\" M5 Pro (24GB/1TB)", "Claude Max subscription"). No "Reimbursement:" prefix, no reference numbers, no dates, no conversion math.
- line item note (per-item) = context that ISN'T already visible elsewhere on the invoice. Things like billing periods, conversion math, FX rates, why this item is listed. DO NOT include the source invoice number, source filename, or "Source: …" text if you've also uploaded the source as an attachment. the attachment label already shows that. Repeating the same info as text + paperclip is visual noise.
- invoice notes (invoice-level) = context for the WHOLE invoice. payment instructions, thank-yous, reimbursement framing when the entire invoice is one thing.
- attachments = the actual receipt/PDF/screenshot. Label them naturally (e.g. "Apple receipt", "Hotel folio"). that label IS the source citation. Don't retype the attachment's contents into the note.

Rule of thumb: context about ONE line item that the recipient can't see from the attachment → line_items[].note. Context about the whole invoice → notes. When you convert currency, put the rate + source in the line's note (or the invoice note if the whole invoice uses one FX rate). Keep notes terse. a single short line is usually enough.`;

const MULTI_BUSINESS_NOTE = `MULTI-BUSINESS: this user owns more than one business. Every tool that creates or modifies data takes an optional \`business_id\`. Before calling those tools, ask the user which business to act under. do not guess. If they say "the one for Acme" or similar, pick the matching business by name. Pass the chosen id as \`business_id\`.`;

type BusinessOut = {
  id: string;
  name: string;
  client_count: number;
  invoice_count: number;
  profile_complete: boolean;
};

function buildHint(
  bs: BusinessOut[],
  _defaultBusinessId: string | null,
): string {
  if (bs.length === 0) {
    return `NO BUSINESSES. Call \`create_business\` first. ask the user for (a) business name, (b) default currency (USD if unspecified). Then walk the user through filling in the profile: address + country, tax ID. Only after that, ask about clients and invoices. Do NOT invent data.`;
  }

  if (bs.length === 1) {
    const b = bs[0]!;
    if (!b.profile_complete && b.invoice_count === 0 && b.client_count === 0) {
      return `FRESH ACCOUNT with one business "${b.name}". Walk the user through setup, step by step:

STEP 1. Business profile. Ask for: (a) business name (current: "${b.name}". confirm or change), (b) address + country, (c) default currency (USD if unspecified), (d) tax ID if applicable. Save with update_business_profile.

STEP 2. First client. After profile saved, offer to add their first client. Ask for name, email, address. Save with create_client. Do NOT add a client before the profile is saved.

STEP 3. Invoice. After both are done, ask what they'd like to bill the client for. Only then call create_invoice.

Do NOT invent data at any step. Do NOT create a sample/demo invoice. If the user says "just demo it" or "make something up", refuse and ask for real details.`;
    }
    if (!b.profile_complete) {
      return `Business "${b.name}" has no address / tax ID yet. Before sending invoices, ask the user to fill that in via update_business_profile.`;
    }
    if (b.client_count === 0) {
      return `Business "${b.name}" is configured but has no clients. Offer to add the first client (name, email, address) via create_client. Don't invent one.\n\n${WRITING_STYLE}`;
    }
    return `Business "${b.name}" has ${b.client_count} client${b.client_count === 1 ? "" : "s"}. Use find_client to resolve names the user mentions.\n\n${WRITING_STYLE}`;
  }

  // Multiple businesses.
  const list = bs
    .map(
      (b) =>
        `- ${b.name} (${b.id}). ${b.client_count} client${b.client_count === 1 ? "" : "s"}, ${b.invoice_count} invoice${b.invoice_count === 1 ? "" : "s"}${b.profile_complete ? "" : ", PROFILE INCOMPLETE"}`,
    )
    .join("\n");
  return `${MULTI_BUSINESS_NOTE}

Businesses on this account:
${list}

${WRITING_STYLE}`;
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
