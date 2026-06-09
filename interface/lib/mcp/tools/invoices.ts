import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import {
  addLineItem,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  finalizeInvoice,
  findInvoiceByNumber,
  formatInvoiceForMcp,
  formatInvoiceSummaryForMcp,
  getInvoice,
  invoiceShareUrl,
  listInvoices,
  markInvoicePaid,
  removeLineItem,
  setShareEnabled,
  updateInvoice,
  updateLineItem,
  voidInvoice,
} from "@/lib/invoices";
import { sendInvoiceByEmail, type SendInvoiceOutcome } from "@/lib/email/sendInvoice";
import { withIdempotency } from "@/lib/idempotency";
import { SUPPORTED_CHAIN_IDS } from "@/lib/web3/chain";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError, type ErrorCode } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const amount = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s$€£¥]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "Amount must be a number (e.g. 5000 or 2499.99).",
      });
      return z.NEVER;
    }
    const [intPart, decPart = ""] = raw.split(".");
    return `${intPart}.${(decPart + "00").slice(0, 2)}`;
  });

const quantity = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({ code: "custom", message: "Quantity must be a number." });
      return z.NEVER;
    }
    return raw;
  });

const taxRate = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s%]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({ code: "custom", message: "Tax rate must be a fraction like 0.08." });
      return z.NEVER;
    }
    const n = Number(raw);
    if (n > 1 || n < 0) {
      ctx.addIssue({
        code: "custom",
        message: `Tax rate ${raw} out of range. Use a fraction between 0 and 1 (e.g. 0.08 for 8%).`,
      });
      return z.NEVER;
    }
    return n.toFixed(4);
  });

const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD'")
  .transform((s) => s.toUpperCase());

// Single canonical attachment shape: a URL returned by POST /api/upload.
// Bytes never enter the model's context — the upload endpoint hands back
// a URL on enwise's own Vercel Blob host that we trust on resolve.
const attachmentSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  attachment_url: z.string().url(),
});
const attachments = z.array(attachmentSchema).max(10).optional();

const lineItemSchema = z.object({
  business_id: uuid.optional(),
  description: z.string().min(1).max(500),
  quantity,
  unit_price: amount,
  tax_rate: taxRate.optional(),
  product_id: uuid.nullish(),
  note: z.string().max(1000).nullish(),
  attachments,
});

const paymentMethodsTopSchema = z.array(z.enum(["bank", "crypto_wallet"]));

const supportedChainIdSchema = z
  .number()
  .int()
  .refine((n) => (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n), {
    message: `must be one of: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
  });
// Per-invoice override of payable EVM chains. Array of supported chain ids.
const chainIdsSchema = z.array(supportedChainIdSchema);

const createSchema = {
  business_id: uuid.optional(),
  client_id: uuid,
  /** Desired invoice number. Omit to auto-assign the next in sequence. Pass
   *  bare digits ("2") or the full form ("INV-0002"). Must be available in
   *  this business; if taken, the tool returns duplicate_invoice_number with
   *  a list of free numbers. */
  invoice_number: z.string().min(1).max(40).optional(),
  issue_date: isoDate.optional(),
  due_date: isoDate.optional(),
  currency: currency.optional(),
  line_items: z.array(lineItemSchema).min(1).max(200),
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  client_request_id: z.string().max(64).optional(),
  /** Which payment rails to show on this invoice. Defaults to `["bank"]`
   *  when omitted — wallet is opt-in. Pass `["bank", "crypto_wallet"]` only
   *  when the user explicitly asks to accept crypto / show their wallet on
   *  this invoice. Pass `[]` to hide all rails. */
  accepted_payment_methods: paymentMethodsTopSchema.optional(),
  /** Which bank account(s) to show on this invoice. Omit to use the
   *  business's default (the server will return bank_account_required if
   *  the business has multiple accounts and no default is set yet — in
   *  that case ASK the user which account, then retry with their pick). */
  accepted_bank_account_ids: z.array(uuid).optional(),
  /** Per-invoice override of which EVM chains the payer may pay on (e.g.
   *  `[8453, 42161]` for Base + Arbitrum). Omit to use the business's
   *  accepted_chain_ids / payment_chain_id. The same evm_wallet_address
   *  receives on every chain. */
  accepted_chain_ids: chainIdsSchema.optional(),
};

async function businessBelongsToUser(
  userId: string,
  businessId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.ownerUserId, userId)));
  return Boolean(row);
}

function mapMutateError(code: string): ErrorCode {
  switch (code) {
    case "not_found":
    case "client_not_found":
      return "not_found";
    case "business_not_found":
      return "business_not_found";
    case "invoice_not_draft":
      return "invoice_not_draft";
    case "duplicate_invoice_number":
    case "invalid_invoice_number":
      return code;
    case "invalid_currency":
    case "currency_required":
    case "invalid_amount":
    case "no_line_items":
      return "invalid_input";
    case "onboarding_required":
    case "attachment_too_large":
    case "attachment_invalid_mime":
    case "attachment_storage_unavailable":
      return code;
    case "bank_account_required":
    case "invalid_bank_account":
      return "invalid_input";
    default:
      return "internal_error";
  }
}

export function registerInvoiceTools(server: McpServer) {
  server.registerTool(
    "create_invoice",
    {
      title: "Create invoice",
      description:
        "Create a draft invoice for a client under a specific business. If the user owns multiple businesses, pass `business_id`. ASK the user which business this invoice is under before calling. If they own one, `business_id` can be omitted. Every line item description, quantity, unit price, and tax rate MUST come from the user. NEVER invent them.\n\nFIELD SEPARATION RULES:\n- `line_items[].description`: just the product or service name. Short and specific (e.g., `MacBook Pro 14\" M5 Pro (24GB / 1TB)`, `Consulting April 2026`). No 'Reimbursement' prefix, no reference numbers, no conversion math, no 'see attached'.\n- `line_items[].note` (per-item): context that ISN'T already shown elsewhere on the invoice. Conversion math, FX rates, billing periods, dates the recipient can't see otherwise. **Do NOT include 'Source: Invoice X' or filenames in the note when you've also attached the source PDF — the attachment label is the citation, repeating it as text is visual noise.** Keep it terse.\n- `notes` (invoice-level): context for the WHOLE invoice — payment instructions, thank-yous, reimbursement framing.\n- `terms` (invoice-level): standing terms like `Payment due within 30 days via bank transfer`.\n- `attachments` on a line item: supporting files. The label IS the source citation; name them naturally (`Apple receipt`, `Hotel folio`).\n\nATTACHMENTS — supported types: PNG / JPEG / WebP / PDF, up to 10 MB per file, up to 10 files per line item. ALWAYS upload via curl first, then reference by URL. NEVER inline file bytes, NEVER chunk/split files.\n\n  Step 1 — upload from disk (one curl, any size up to 10 MB):\n    curl -X POST https://enwise.app/api/upload \\\n      -H \"Authorization: Bearer <YOUR_TOKEN>\" \\\n      -F \"file=@/path/to/receipt.pdf\"\n  Returns `{url, mime_type, size_bytes, filename}`. If the file is larger than 4 MB the endpoint hands back a presigned PUT URL instead — follow the `next_step` field in the response and curl the bytes one more time. Either way you get back `{url}`.\n\n  Step 2 — pass the url as attachment_url on the line item:\n    `{attachment_url: \"https://...blob.vercel-storage.com/...\", label?}`\n\n  Pass PDFs through as-is — don't rasterize.\n\nInvoice number is allocated automatically (next in sequence) when you omit `invoice_number`. To use a SPECIFIC number, pass `invoice_number` as either the digits (\"2\") or the full form (\"INV-0002\"). It must be AVAILABLE in this business; deleting an invoice frees its number for reuse, and gaps left by past deletions/voids are claimable. If the number is taken, the tool returns `duplicate_invoice_number` with an `available_numbers` list. surface it and let the user pick. Only set a custom number when the user explicitly asks for one. Dates default to today + net-30; currency defaults to the client's default; otherwise create_invoice returns currency_required. To email it, call send_invoice next.\n\nPAYMENT RAILS — derived from business state when caller doesn't pick. When `accepted_payment_methods` is omitted, the server derives the default from what the business has configured: if the business has ANY active bank account, the default is `[\"bank\"]` (bank wins when both rails are configured — most clients pay invoices by bank by habit); if there are no bank accounts but the business has at least one wallet (EVM / Starknet / Aptos), the default is `[\"crypto_wallet\"]` (crypto-only merchants don't need to opt in every invoice); if neither is configured, `[\"bank\"]` (neutral, nothing renders either way). To override, pass it explicitly: `[\"bank\", \"crypto_wallet\"]` to show both, `[\"crypto_wallet\"]` for crypto-only on this invoice (even though merchant has bank set up), `[]` to hide all rails.\n\n**ALWAYS display the returned `share_url` to the user verbatim after this call.** That's the public, copyable link to the invoice — it's the primary artifact the user expects to see.\n\nIf the response includes a `payment_rails_note` field (set when the invoice currency isn't USD), surface it to the user in plain English right after the share_url. USDC / wallet payments are USD-only; non-USD invoices show bank rails only. The user should know this BEFORE they share the invoice so they can re-issue in USD if they wanted crypto payment.",
      inputSchema: createSchema,
    },
    async (args, extra) => {
      const parsed = z.object(createSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const result = await createInvoice(ctx, {
        clientId: d.client_id,
        invoiceNumber: d.invoice_number,
        issueDate: d.issue_date,
        dueDate: d.due_date,
        currency: d.currency,
        notes: d.notes ?? null,
        terms: d.terms ?? null,
        clientRequestId: d.client_request_id ?? null,
        acceptedPaymentMethods: d.accepted_payment_methods,
        acceptedBankAccountIds: d.accepted_bank_account_ids,
        acceptedChainIds: d.accepted_chain_ids,
        lineItems: d.line_items.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unit_price,
          taxRate: l.tax_rate,
          productId: l.product_id ?? null,
          note: l.note ?? null,
          attachments: l.attachments,
        })),
      });
      if (!result.ok) {
        return toolError(mapMutateError(result.code), result.message, {
          hint: result.hint,
          ...(result.code === "bank_account_required" && result.bank_accounts
            ? { bank_accounts: result.bank_accounts }
            : {}),
          ...(result.code === "duplicate_invoice_number" && result.available_numbers
            ? { suggestions: { available_numbers: result.available_numbers } }
            : {}),
        });
      }
      return toolOk({
        ...formatInvoiceForMcp(result.invoice),
        share_url: invoiceShareUrl(result.invoice.shareSlug),
      });
    },
  );

  // Sub-schemas for per-invoice display overrides. Every field is optional.
  // Key PRESENCE distinguishes override-with-explicit-null (= hide) from
  // "don't touch" (key absent). nullish() preserves that.
  const overrideAddress = z
    .object({
      line1: z.string().max(200).nullish(),
      line2: z.string().max(200).nullish(),
      city: z.string().max(120).nullish(),
      region: z.string().max(120).nullish(),
      postal_code: z.string().max(40).nullish(),
      country: z.string().length(2).nullish(),
    })
    .partial()
    .nullable();
  const overrideBank = z
    .object({
      account_holder: z.string().max(200).nullish(),
      bank_name: z.string().max(200).nullish(),
      account_number: z.string().max(200).nullish(),
      ifsc: z.string().max(40).nullish(),
      swift: z.string().max(40).nullish(),
      iban: z.string().max(60).nullish(),
      ach_routing: z.string().max(40).nullish(),
      fedwire_routing: z.string().max(40).nullish(),
      branch_address: z.string().max(300).nullish(),
    })
    .partial()
    .nullable();
  const displayOverridesSchema = z
    .object({
      business: z
        .object({
          name: z.string().max(200).nullish(),
          legal_name: z.string().max(200).nullish(),
          tax_id: z.string().max(80).nullish(),
          contact_name: z.string().max(120).nullish(),
          evm_wallet_address: z.string().max(200).nullish(),
          starknet_wallet_address: z.string().max(200).nullish(),
          aptos_wallet_address: z.string().max(200).nullish(),
          logo_url: z.string().url().nullish(),
          address: overrideAddress.optional(),
          bank_details: overrideBank.optional(),
        })
        .partial()
        .optional(),
      client: z
        .object({
          name: z.string().max(200).nullish(),
          contact_name: z.string().max(120).nullish(),
          email: z.string().email().nullish(),
          address: overrideAddress.optional(),
        })
        .partial()
        .optional(),
    })
    .nullable();
  const paymentMethodsSchema = z
    .array(z.enum(["bank", "crypto_wallet"]))
    .nullable();
  const bankAccountIdsSchema = z.array(uuid).nullable();

  server.registerTool(
    "update_invoice",
    {
      title: "Update invoice (draft only)",
      description:
        "Update invoice headers. The merchant has full control over their own invoice — every field is editable at every status. But editing a SENT or PAID invoice is consequential and Claude MUST warn the user before doing so when CONTRACT fields are involved.\n\nCONTRACT fields (client_id, business_id, invoice_number, issue_date, due_date, notes, terms): these change what the invoice document says. If the invoice is already sent, the recipient has the original PDF / screenshot / printout — your change does NOT travel back to them, so the merchant's record will diverge from what the recipient sees. Before calling update_invoice with any of these on a non-draft invoice, EXPLICITLY confirm with the user: 'This invoice is already sent. Changing <field> means your record will differ from the copy <recipient> already received. They won't be notified. Want me to proceed, void+reissue instead, or use display_overrides?' Wait for a clear yes.\n\nDISPLAY-ONLY fields (accepted_payment_methods, accepted_bank_account_ids, display_overrides): these only change how the share page renders the payment surface — invoice content is unchanged. Safe on any status, no warning needed. Use these to flip on crypto, swap bank account, or override a display label on an already-sent invoice. Pass `business_id` to MOVE the invoice to render under a different business — a new invoice number is allocated under that business automatically. Pass `invoice_number` (digits \"2\" or full form \"INV-0002\") to RENUMBER the invoice to a specific available number; if it's taken the tool returns `duplicate_invoice_number` with an `available_numbers` list. Renumbering a SENT invoice is a contract change. warn the user first, since the recipient's copy keeps the old number. To change line items use add_line_item / update_line_item / remove_line_item. For finalized invoices use void_invoice + duplicate_invoice.\n\n`display_overrides` lets you override any business/client field shown on this specific invoice WITHOUT mutating the underlying business/client record. Resolution order: override > snapshot > live. Key presence = override; null value = explicitly hide. Pass `display_overrides: null` to clear all overrides.\n  Example — hide just the EVM wallet on this invoice:\n    `{ display_overrides: { business: { evm_wallet_address: null } } }`\n  Same shape for `starknet_wallet_address` / `aptos_wallet_address`.\n  Example — override the legal name without touching the business record:\n    `{ display_overrides: { business: { legal_name: 'ZK Labs Pte. Ltd.' } } }`\n\n`accepted_payment_methods` gates which payment rails are displayed. Values: 'bank' (bank details block), 'crypto_wallet' (business wallet address + Pay-with-USDC button on Base for the EVM wallet). At create_invoice time the default is derived from what the business has configured (bank wins when both are set, crypto wins when only wallets exist). At update_invoice time, override explicitly: `[\"bank\", \"crypto_wallet\"]` to show both, `[\"crypto_wallet\"]` for crypto-only, `[\"bank\"]` for bank-only, `[]` to hide all rails. NULL on an existing row = legacy \"show everything\" behavior; do not write NULL going forward — always be explicit.\n\n`accepted_bank_account_ids` picks WHICH bank accounts to surface (when 'bank' is among the accepted methods). Values: NULL = use the business's default account (the standard behavior). `[]` = hide the bank panel even if 'bank' is in accepted_payment_methods. `[id, ...]` = show exactly these accounts in this order. Call list_bank_accounts first to get the ids. If the merchant explicitly picks one account here AND no default is set yet, it gets promoted to default for future invoices.\n\nReturns the updated invoice including `share_url`. **Always show the share_url** so the user can re-view the updated invoice.",
      inputSchema: {
        invoice_id: uuid,
        business_id: uuid.optional(),
        client_id: uuid.optional(),
        invoice_number: z.string().min(1).max(40).optional(),
        issue_date: isoDate.optional(),
        due_date: isoDate.optional(),
        notes: z.string().max(4000).nullish(),
        terms: z.string().max(4000).nullish(),
        display_overrides: displayOverridesSchema.optional(),
        accepted_payment_methods: paymentMethodsSchema.optional(),
        accepted_bank_account_ids: bankAccountIdsSchema.optional(),
        accepted_chain_ids: chainIdsSchema.nullable().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          invoice_id: uuid,
          business_id: uuid.optional(),
          client_id: uuid.optional(),
          invoice_number: z.string().min(1).max(40).optional(),
          issue_date: isoDate.optional(),
          due_date: isoDate.optional(),
          notes: z.string().max(4000).nullish(),
          terms: z.string().max(4000).nullish(),
          display_overrides: displayOverridesSchema.optional(),
          accepted_payment_methods: paymentMethodsSchema.optional(),
          accepted_bank_account_ids: bankAccountIdsSchema.optional(),
          accepted_chain_ids: chainIdsSchema.nullable().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, parsed.data.business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const r = await updateInvoice(ctx, d.invoice_id, {
        clientId: d.client_id,
        businessId: d.business_id,
        ...(d.invoice_number !== undefined && { invoiceNumber: d.invoice_number }),
        issueDate: d.issue_date,
        dueDate: d.due_date,
        // Preserve null (= "clear field") vs undefined (= "don't touch"). The
        // core updateInvoice keys off `!== undefined`, so `?? undefined` would
        // silently drop a caller's request to clear notes/terms.
        ...(d.notes !== undefined && { notes: d.notes }),
        ...(d.terms !== undefined && { terms: d.terms }),
        ...(d.display_overrides !== undefined && {
          displayOverrides: d.display_overrides,
        }),
        ...(d.accepted_payment_methods !== undefined && {
          acceptedPaymentMethods: d.accepted_payment_methods,
        }),
        ...(d.accepted_bank_account_ids !== undefined && {
          acceptedBankAccountIds: d.accepted_bank_account_ids,
        }),
        ...(d.accepted_chain_ids !== undefined && {
          acceptedChainIds: d.accepted_chain_ids,
        }),
      });
      if (!r.ok)
        return toolError(mapMutateError(r.code), r.message, {
          hint:
            r.hint ??
            (r.code === "invoice_not_draft"
              ? "Void the invoice and call duplicate_invoice to create a new draft."
              : r.code === "business_not_found"
                ? "Call whoami to see businesses on this account, then pass a valid id."
                : undefined),
          ...(r.code === "duplicate_invoice_number" && r.available_numbers
            ? { suggestions: { available_numbers: r.available_numbers } }
            : {}),
        });
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "add_line_item",
    {
      title: "Add line item",
      description:
        'Append a line item to an invoice. Totals are recomputed automatically. Works on ANY status — but if the invoice is already sent or paid, WARN the user first: the new line changes the merchant\'s record while the recipient still has the old PDF/printout. Confirm with the user ("This invoice is already sent. Adding a line will change the amount the recipient sees on the share page but they won\'t be notified. Continue, void+reissue, or stop?") before calling. Optional `attachments` (PNG/JPEG/WebP/PDF, up to 10 MB each, up to 10 per item): upload first via `curl -X POST -H "Authorization: Bearer <TOKEN>" -F "file=@/path/to/file.pdf" https://enwise.app/api/upload` and pass the returned `url` as `{attachment_url, label?}`. NEVER inline bytes, NEVER chunk a file. Pass PDFs through as-is, don\'t rasterize.\n\nReturns the updated invoice including `share_url`. Show the share_url to the user when reporting the result.',
      inputSchema: {
        business_id: uuid.optional(),
        invoice_id: uuid,
        description: z.string().min(1).max(500),
        quantity,
        unit_price: amount,
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
        note: z.string().max(1000).nullish(),
        attachments,
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        invoice_id: uuid,
        description: z.string().min(1).max(500),
        quantity,
        unit_price: amount,
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
        note: z.string().max(1000).nullish(),
        attachments,
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const r = await addLineItem(ctx, d.invoice_id, {
        description: d.description,
        quantity: d.quantity,
        unitPrice: d.unit_price,
        taxRate: d.tax_rate,
        productId: d.product_id ?? null,
        note: d.note ?? null,
        attachments: d.attachments,
      });
      if (!r.ok) return toolError(mapMutateError(r.code), r.message, { hint: r.hint });
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "update_line_item",
    {
      title: "Update line item",
      description:
        "Update fields on a line item. Works on ANY invoice status; the merchant has full control. But if the invoice is already SENT or PAID, WARN the user first: the recipient still has the original PDF, your edit changes the share-page total while they're unaware. Confirm before calling. Pass only the fields you want to change. Passing `attachments` REPLACES the whole list (send every file you want on the line item; anything you don't re-send is removed). Pass `attachments: []` to clear. Attachment shape: `{attachment_url, label?}` — upload first via POST /api/upload (curl from disk), then pass the returned `url`. PNG / JPEG / WebP / PDF, 10 MB cap each.\n\nReturns the updated invoice including `share_url`. Show the share_url to the user when reporting the result.",
      inputSchema: {
        business_id: uuid.optional(),
        invoice_id: uuid,
        line_item_id: uuid,
        description: z.string().min(1).max(500).optional(),
        quantity: quantity.optional(),
        unit_price: amount.optional(),
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
        note: z.string().max(1000).nullish(),
        attachments,
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        invoice_id: uuid,
        line_item_id: uuid,
        description: z.string().min(1).max(500).optional(),
        quantity: quantity.optional(),
        unit_price: amount.optional(),
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
        note: z.string().max(1000).nullish(),
        attachments,
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const patch: Parameters<typeof updateLineItem>[3] = {};
      if (d.description !== undefined) patch.description = d.description;
      if (d.quantity !== undefined) patch.quantity = d.quantity;
      if (d.unit_price !== undefined) patch.unitPrice = d.unit_price;
      if (d.tax_rate !== undefined) patch.taxRate = d.tax_rate;
      if (d.product_id !== undefined) patch.productId = d.product_id ?? null;
      if (d.note !== undefined) patch.note = d.note ?? null;
      if (d.attachments !== undefined) patch.attachments = d.attachments;
      const r = await updateLineItem(ctx, d.invoice_id, d.line_item_id, patch);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message, { hint: r.hint });
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "remove_line_item",
    {
      title: "Remove line item",
      description:
        "Remove a line item from an invoice by id. Totals are recomputed automatically. Works on ANY status; the merchant has full control. WARN the user before removing a line from a SENT or PAID invoice — the recipient still has the original PDF with that line on it, your removal makes the share-page total lower than the printed one. Confirm before calling. Use this to delete a single line; to clear and rebuild, call remove_line_item per id or duplicate_invoice + edit. Returns the updated invoice including `share_url`. Show the share_url to the user when reporting the result.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid, line_item_id: uuid },
    },
    async (args, extra) => {
      const schema = z.object({
      business_id: uuid.optional(), invoice_id: uuid, line_item_id: uuid });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await removeLineItem(ctx, parsed.data.invoice_id, parsed.data.line_item_id);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description:
        "Fetch a single invoice by id. Returns the full header (status, dates, totals, currency, notes, terms, snapshot fields, display_overrides, accepted_payment_methods) plus the ordered line items (description, qty, unit_price, tax, attachments) and `share_url`. Use this when you have an id and need the full payload; for searching by invoice number use find_invoice; for lists use list_invoices.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const inv = await getInvoice(ctx, parsed.data.invoice_id);
      if (!inv) return toolError("not_found", `No invoice with id ${parsed.data.invoice_id}.`);
      return toolOk({ ...formatInvoiceForMcp(inv), share_url: invoiceShareUrl(inv.shareSlug) });
    },
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description:
        "List invoices with optional filters. Order: issue_date desc. Filters compose: pass `business_id` to scope to one business, `client_id` to scope to one client, both to scope to invoices for that client under that business. Omit `business_id` to list across every business the user owns. Status 'overdue' is computed (status=sent AND due_date<today). Use this for 'all invoices from ZK Labs', 'last 10 invoices to this client', 'what's outstanding?', etc.",
      inputSchema: {
        business_id: uuid.optional(),
        client_id: uuid.optional(),
        status: z.enum(["draft", "sent", "paid", "void", "overdue"]).optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        client_id: uuid.optional(),
        status: z.enum(["draft", "sent", "paid", "void", "overdue"]).optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      // Don't use scopeFromCtx here: this is the one read tool that's
      // legitimately cross-business. Validate business_id if passed,
      // otherwise list across every business the user owns.
      if (parsed.data.business_id) {
        const owned = await businessBelongsToUser(ctx.userId, parsed.data.business_id);
        if (!owned) {
          return toolError(
            "business_not_found",
            `No business with id ${parsed.data.business_id} belongs to the authenticated user.`,
            { hint: "Call `whoami` to list the businesses this token can act on." },
          );
        }
      }
      const rows = await listInvoices(ctx, {
        businessId: parsed.data.business_id,
        clientId: parsed.data.client_id,
        status: parsed.data.status,
        dateFrom: parsed.data.date_from,
        dateTo: parsed.data.date_to,
        limit: parsed.data.limit,
      });
      return toolOk({ invoices: rows.map(formatInvoiceSummaryForMcp) });
    },
  );

  server.registerTool(
    "find_invoice",
    {
      title: "Find invoice by number",
      description:
        "Resolve an invoice_number like 'INV-0042' to an invoice id (and a summary). Invoice numbers are unique within a business but not across businesses, so pass `business_id` when the user owns multiple. Returns the matching invoice summary (id, status, client, totals) on hit, or a not_found error. Follow up with get_invoice if you need the full payload including line items.",
      inputSchema: {
    business_id: uuid.optional(), invoice_number: z.string().min(1).max(40) },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_number: z.string().min(1).max(40) }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const inv = await findInvoiceByNumber(ctx, parsed.data.invoice_number);
      if (!inv) return toolError("not_found", `No invoice with number ${parsed.data.invoice_number}.`);
      return toolOk(formatInvoiceSummaryForMcp(inv));
    },
  );

  server.registerTool(
    "duplicate_invoice",
    {
      title: "Duplicate invoice",
      description:
        "Clone an existing invoice's line items into a new draft under the same business. Optionally retarget to a different client via `client_id`, or change the issue date via `new_issue_date` (due_date is recomputed from the business's default net terms). Returns the new DRAFT invoice including `share_url`. **Always show the share_url** so the user can open the new draft and confirm before sending.",
      inputSchema: {
        business_id: uuid.optional(),
        invoice_id: uuid,
        client_id: uuid.optional(),
        new_issue_date: isoDate.optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        invoice_id: uuid,
        client_id: uuid.optional(),
        new_issue_date: isoDate.optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await duplicateInvoice(ctx, parsed.data.invoice_id, {
        clientId: parsed.data.client_id,
        newIssueDate: parsed.data.new_issue_date,
      });
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({ ...formatInvoiceForMcp(r.invoice), share_url: invoiceShareUrl(r.invoice.shareSlug) });
    },
  );

  const nonNegativeAmount = amount.refine(
    (v) => Number(v) >= 0,
    "amount must be >= 0",
  );

  server.registerTool(
    "mark_invoice_paid",
    {
      title: "Mark invoice paid",
      description:
        "Record payment for an invoice. Defaults amount to the invoice total and paid_at to today. Supports partial payments — pass an amount less than total to reflect that. Amount must be >= 0. Returns the updated invoice including `share_url`. Show the share_url to the user when reporting the result so they can re-view or forward the (now paid) invoice.",
      inputSchema: {
        business_id: uuid.optional(),
        invoice_id: uuid,
        amount: nonNegativeAmount.optional(),
        paid_at: isoDate.optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        invoice_id: uuid,
        amount: nonNegativeAmount.optional(),
        paid_at: isoDate.optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await markInvoicePaid(ctx, parsed.data.invoice_id, {
        amount: parsed.data.amount,
        paidAt: parsed.data.paid_at,
      });
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "void_invoice",
    {
      title: "Void invoice",
      description:
        "Void an invoice (any status). Voided invoices are kept for audit, but can't be paid or edited. Use this when a sent invoice needs correction — then call duplicate_invoice for the replacement. Optional `reason` is recorded in the invoice event log and included in the void-notification email. If the invoice was previously delivered (sent_to_email is set), an email is automatically sent to the recipient explaining the void; failures don't block the void itself. The share page and the PDF both render a 'VOIDED' banner so anyone viewing the link sees the status immediately. Returns the voided invoice including `share_url`. Show the share_url so the user can confirm the void state visually.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid, reason: z.string().max(500).optional() },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid, reason: z.string().max(500).optional() }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await voidInvoice(ctx, parsed.data.invoice_id, { reason: parsed.data.reason });
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete invoice",
      description:
        "**HARD-DELETE** an invoice and all its children (line items, events, payment records). Works on any status. THIS IS PERMANENT and unrecoverable — there is no soft-delete tombstone, no undo. ALWAYS confirm with the user before calling.\n\nMandatory pre-call warning. For drafts: 'This will permanently delete draft INV-XXXX and free up the number for reuse on your next invoice. Confirm?' For sent / paid / void invoices: 'INV-XXXX is already sent. Deleting permanently removes it from your records and makes the share link 404 for the recipient. The recipient still has whatever PDF / screenshot you sent — but you lose all server-side history (events, payments). For sent invoices, void_invoice is usually safer (keeps the audit record, sends a void-notification email). Want me to delete or void?' Get an explicit yes before calling.\n\nAfter delete, businesses.invoice_number_next is recomputed as MAX(remaining invoice numbers on this business) + 1, so the deleted number becomes available again if it was the latest. Mid-sequence gaps from voids are preserved.\n\nReturns `{ deleted: true, invoice_number: '...' }`. Tell the user the number is now free to reuse if they want a fresh INV-XXXX with the same number.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await deleteInvoice(ctx, parsed.data.invoice_id);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk(r.value);
    },
  );

  server.registerTool(
    "get_invoice_share_url",
    {
      title: "Get invoice share URL",
      description:
        "Return the public share URL for an invoice plus its `enabled` flag. The URL is unguessable (long random slug) and is publicly accessible until `share_enabled` is set to false via set_invoice_share_enabled. Use this when the user asks 'what's the link for INV-X' on an already-known invoice; for newly-created/updated invoices, prefer the `share_url` returned from the mutating tool itself.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const inv = await getInvoice(ctx, parsed.data.invoice_id);
      if (!inv) return toolError("not_found", `No invoice with id ${parsed.data.invoice_id}.`);
      return toolOk({
        url: invoiceShareUrl(inv.shareSlug),
        enabled: inv.shareEnabled,
      });
    },
  );

  server.registerTool(
    "finalize_invoice",
    {
      title: "Mark invoice as sent (no email)",
      description:
        "Flip a draft invoice to 'sent' status WITHOUT emailing anyone. Use this when the user delivered the invoice some other way (handed it over in person, WhatsApp, Slack, printed and mailed, etc.) or just wants to lock it in for their own records. Takes the client + business snapshot onto the row. For email delivery, use send_invoice instead. Already-sent / paid / void invoices are left untouched.\n\nReturns the updated invoice including `share_url`. **Always show the share_url** so the user has a copyable link to forward.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await finalizeInvoice(ctx, parsed.data.invoice_id);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "send_invoice",
    {
      title: "Email invoice to client",
      description:
        "Send an invoice to the client by email. Generates the PDF as an attachment and includes a link to the public share page. Defaults `to` to the client's email; pass `to` to override. Flips the invoice from draft to sent and freezes the client+business snapshot onto the invoice (so later edits to the client don't mutate the sent copy). Safe to call again on an already-sent invoice — it just re-sends without re-snapshotting.\n\nReturns the invoice with `share_url`, `sent_to` (list of recipients), and `resend_id`. **Always show the share_url and the list of recipients** when reporting the result.",
      inputSchema: {
        business_id: uuid.optional(),
        invoice_id: uuid,
        to: z.array(z.string().email()).max(10).optional(),
        cc: z.array(z.string().email()).max(10).optional(),
        bcc: z.array(z.string().email()).max(10).optional(),
        message: z.string().max(2000).nullish(),
        client_request_id: z.string().max(64).optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        business_id: uuid.optional(),
        invoice_id: uuid,
        to: z.array(z.string().email()).max(10).optional(),
        cc: z.array(z.string().email()).max(10).optional(),
        bcc: z.array(z.string().email()).max(10).optional(),
        message: z.string().max(2000).nullish(),
        client_request_id: z.string().max(64).optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const result = await withIdempotency<SendInvoiceOutcome>(
        ctx,
        "send_invoice",
        d.client_request_id ?? null,
        () =>
          sendInvoiceByEmail(ctx, {
            invoiceId: d.invoice_id,
            to: d.to,
            cc: d.cc,
            bcc: d.bcc,
            message: d.message ?? null,
          }),
      );
      if (!result.ok) {
        const code = result.code === "email_not_configured" ? "internal_error"
          : result.code === "resend_failure" ? "internal_error"
          : result.code === "no_recipient" ? "invalid_input"
          : mapMutateError(result.code);
        return toolError(code, result.message, { hint: result.hint });
      }
      return toolOk({
        ...formatInvoiceForMcp(result.invoice),
        share_url: invoiceShareUrl(result.invoice.shareSlug),
        sent_to: result.to,
        resend_id: result.resendId,
      });
    },
  );

  server.registerTool(
    "set_invoice_share_enabled",
    {
      title: "Enable/disable invoice share link",
      description:
        "Revoke (or re-enable) public access to an invoice's share URL. Disabled links return 404.",
      inputSchema: {
    business_id: uuid.optional(), invoice_id: uuid, enabled: z.boolean() },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), invoice_id: uuid, enabled: z.boolean() }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await setShareEnabled(ctx, parsed.data.invoice_id, parsed.data.enabled);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({
        url: invoiceShareUrl(r.value.shareSlug),
        enabled: r.value.shareEnabled,
      });
    },
  );
}
