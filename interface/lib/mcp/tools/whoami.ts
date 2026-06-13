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
  invoice_number_prefix: z.string(),
  invoice_number_next: z.number(),
  logo_url: z.string().nullable(),
  legal_name: z.string().nullable(),
  tax_id: z.string().nullable(),
  address_line1: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  invoice_count: z.number(),
  profile_complete: z.boolean(),
});

const outputSchema = {
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    client_count: z.number(),
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
        "Return the authenticated user, every business this token can act on, and a directive hint. Call at the start of every session, after `create_business`, AND every time the user asks anything about their account state — business list, default business, client count. NEVER answer those questions from cached output of an earlier turn; the user can add a business between turns and stale answers are worse than a fresh tool call.",
      outputSchema,
    },
    async (extra) => {
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
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

      // Counts are now USER-level (clients + invoices are account-scoped).
      // Per-business invoice count is still meaningful — it tells you how
      // many invoices have been rendered under each business — so keep that.
      const [{ value: userClientCount }] = await db
        .select({ value: count() })
        .from(clients)
        .where(eq(clients.ownerUserId, ctx.userId));

      const businessesOut = await Promise.all(
        owned.map(async (b) => {
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
            invoice_number_prefix: b.invoiceNumberPrefix,
            invoice_number_next: b.invoiceNumberNext,
            logo_url: b.logoUrl,
            legal_name: b.legalName,
            tax_id: b.taxId,
            address_line1: b.addressLine1,
            city: b.city,
            country: b.country,
            invoice_count: Number(invoiceCount ?? 0),
            profile_complete: profileComplete,
            has_evm_wallet: Boolean(b.evmWalletAddress),
          };
        }),
      );

      const totalClientCount = Number(userClientCount ?? 0);

      const structured = {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          client_count: totalClientCount,
        },
        businesses: businessesOut,
        default_business_id: user.defaultBusinessId,
        hint: buildHint(businessesOut, totalClientCount, user.defaultBusinessId),
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

const MULTI_BUSINESS_NOTE = `MULTI-BUSINESS: this user owns more than one business. Clients, products, and invoices are SHARED across all businesses on this account — find_client / list_invoices / etc. return data from across the account regardless of business.

What is per-business: the rendering profile (letterhead, address, logo, invoice numbering scheme). This matters for **create_invoice** and **create_recurring_invoice** — ASK the user which business to render the invoice under before calling. If you don't pass \`business_id\`, the user's default business is used. To MOVE a draft invoice to a different business after the fact, call \`update_invoice({invoice_id, business_id: <new>})\` — a fresh invoice number is allocated under the destination automatically.`;

type BusinessOut = {
  id: string;
  name: string;
  invoice_count: number;
  profile_complete: boolean;
  has_evm_wallet: boolean;
};

function buildHint(
  bs: BusinessOut[],
  totalClients: number,
  _defaultBusinessId: string | null,
): string {
  if (bs.length === 0) {
    return `NO BUSINESSES. Send ONE message asking the user for everything you need to spin up the business, plainly:
  - Business name (required)
  - Full address (tell them to paste it however they have it — you'll split it into line1 / city / region / postal_code / country yourself)
  - Tax ID if they have one (EIN / VAT / GSTIN / etc.; otherwise leave blank)
Then call create_business with just the name, immediately followed by update_business_profile with whatever address + tax ID they gave you. Currency is NOT a business-level field — it lives on the client (default_currency) or per invoice, so don't ask about it here. Do NOT ask for address fields separately, do NOT show numbered multiple-choice pickers, and do NOT ask about payment terms, invoice prefix, brand color, logo, reply-to email, or contact name during onboarding — those are editable later. Save what they give, move on with what they don't; re-ask only if a required field (name) is missing. After the profile is in, move on to clients. Do NOT invent data.`;
  }

  if (bs.length === 1) {
    const b = bs[0]!;
    if (!b.profile_complete && b.invoice_count === 0 && totalClients === 0) {
      return `FRESH ACCOUNT with one business "${b.name}". Onboarding is two short asks, NOT a multi-step interview. Friction is the enemy — every extra question costs goodwill.

HARD RULES for both asks:
- ONE message per ask. The user pastes everything in one reply, then you call ONE tool. Save what they give, move on with what they don't.
- Treat address as a single freeform blob. Do NOT ask for street / city / state / postal / country as separate fields. Tell the user "paste the full address however you have it" and YOU split it into address_line1 / city / region / postal_code / country (ISO-2) before calling the tool. Same for the client's address.
- Do NOT show numbered multiple-choice pickers ("1. USD  2. INR  3. EUR"). Plain prose only.
- Currency is NOT a business-level concept. The only place currency is stored is the CLIENT (default_currency) or the INVOICE itself. So don't ask "what currency should this business invoice in?" — ask currency when creating the client (or skip and ask at invoice time). If create_invoice returns currency_required, ask the user then and persist on the client via update_client.
- Do NOT ask about other advanced knobs during onboarding: default payment terms, invoice number prefix, brand color, logo, reply-to email, contact name. They are editable later and not worth a question.
- Required vs optional: only re-ask if a REQUIRED field is missing (business name, client name). For everything else, save what was given and move on — if it turns out to matter at invoice creation time (e.g. no client email but they want to email the invoice), ask THEN.

ASK 1 — Business profile. Single message asking for, plainly:
  - Business name (currently "${b.name}" — confirm or change)
  - Full address (one freeform paste; you'll split it)
  - Tax ID if they have one (EIN / VAT / GSTIN / etc. — otherwise leave blank)
Then call update_business_profile once with whatever they gave you.

ASK 2 — First client. Single message asking for: client name (required), email, full address (one paste), currency they should be billed in (e.g. USD / INR — skip if unsure, it can be set at invoice time). Do NOT ask about the client's tax ID here — only matters for EU VAT or India GST invoices, ask later at invoice time if the client country is EU or IN. Then create_client with whatever you got.

After both, send ONE transition message that does two things:
1. Mention crypto payments in ONE sentence — e.g. "One more thing: you can accept USDC payments directly from any invoice on Base or Arbitrum — just share your wallet address and I'll add it to your profile." Do NOT ask a question about it. Do NOT make it a blocker. If they respond with a wallet address, call update_business_profile(evm_wallet_address). If they skip it, move on.
2. Ask what they'd like to bill the client for.

Do NOT invent data at any step. Do NOT create a sample/demo invoice. If the user says "just demo it" or "make something up", refuse and ask for real details.`;
    }
    if (!b.profile_complete) {
      return `Business "${b.name}" has no address / tax ID yet. Before sending invoices, send ONE message asking for: full address (one freeform paste — you split it into line1 / city / region / postal_code / country yourself), and tax ID if they have one. Don't ask for address fields separately, don't drip-feed, don't show numbered pickers, and don't ask about advanced knobs (default currency, payment terms, prefix, brand color, logo, wallet, reply-to). Save with a single update_business_profile call — whatever they gave you, move on with what they didn't.`;
    }
    const cryptoNudge = b.has_evm_wallet
      ? ""
      : `\n\nCRYPTO PAYMENTS NOT SET UP: This business has no EVM wallet address. If there is a natural opening (user asks about payment, getting paid, or how invoices work), mention in one sentence that they can accept USDC on Base or Arbitrum by sharing their wallet address. Do not interrupt an invoice flow to ask — raise it only when it fits. If they share a 0x address, call update_business_profile(evm_wallet_address).`;

    if (totalClients === 0) {
      return `Business "${b.name}" is configured but has no clients. Offer to add the first client in ONE message: name (required), email, full address (one freeform paste — you split it yourself), currency they should be billed in (skip if unsure, can be set at invoice time). Do NOT ask about the client's tax ID here — buyer tax IDs only matter on EU VAT or India GST invoices; ask later at invoice time if the client country is EU or IN. Then create_client with whatever you got — don't re-ask for optional fields. Don't ask for address parts separately, don't invent data.${cryptoNudge}\n\n${WRITING_STYLE}`;
    }
    return `Business "${b.name}" has ${totalClients} client${totalClients === 1 ? "" : "s"}. Use find_client to resolve names the user mentions.${cryptoNudge}\n\n${WRITING_STYLE}`;
  }

  // Multiple businesses. Clients are SHARED across all of them (account-
  // level), so we report total client count once at the user level.
  const list = bs
    .map(
      (b) =>
        `- ${b.name} (${b.id}). ${b.invoice_count} invoice${b.invoice_count === 1 ? "" : "s"}${b.profile_complete ? "" : ", PROFILE INCOMPLETE"}${b.has_evm_wallet ? "" : ", NO CRYPTO WALLET"}`,
    )
    .join("\n");

  const anyMissingWallet = bs.some((b) => !b.has_evm_wallet);
  const multiCryptoNudge = anyMissingWallet
    ? `\n\nCRYPTO PAYMENTS: One or more businesses above have no EVM wallet (marked NO CRYPTO WALLET). If there is a natural opening, mention in one sentence that they can accept USDC on Base or Arbitrum by sharing a wallet address for that business. Do not interrupt an invoice flow to ask.`
    : "";

  return `${MULTI_BUSINESS_NOTE}

Businesses on this account:
${list}
${multiCryptoNudge}

${WRITING_STYLE}`;
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
