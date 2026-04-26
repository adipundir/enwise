import { z } from "zod";
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

const attachmentSchema = z.object({
  business_id: uuid.optional(),
  label: z.string().min(1).max(120).optional(),
  file_base64: z.string().min(1),
  mime_type: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ]),
  filename: z.string().min(1).max(120).optional(),
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

const createSchema = {
  business_id: uuid.optional(),
  client_id: uuid,
  issue_date: isoDate.optional(),
  due_date: isoDate.optional(),
  currency: currency.optional(),
  line_items: z.array(lineItemSchema).min(1).max(200),
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  client_request_id: z.string().max(64).optional(),
};

function mapMutateError(code: string): ErrorCode {
  switch (code) {
    case "not_found":
    case "client_not_found":
      return "not_found";
    case "business_not_found":
      return "business_not_found";
    case "invoice_not_draft":
      return "invoice_not_draft";
    case "invalid_currency":
    case "invalid_amount":
    case "no_line_items":
      return "invalid_input";
    case "onboarding_required":
    case "attachment_too_large":
    case "attachment_invalid_mime":
    case "attachment_storage_unavailable":
    case "attachment_count_exceeded":
    case "monthly_limit_reached":
      return code;
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
        "Create a draft invoice for a client under a specific business. If the user owns multiple businesses, pass `business_id`. ASK the user which business this invoice is under before calling. If they own one, `business_id` can be omitted. Every line item description, quantity, unit price, and tax rate MUST come from the user. NEVER invent them.\n\nFIELD SEPARATION RULES:\n- `line_items[].description`: just the product or service name. Short and specific (e.g., `MacBook Pro 14\" M5 Pro (24GB / 1TB)`, `Consulting. April 2026`). No 'Reimbursement' prefix, no reference numbers, no conversion math, no 'see attached'.\n- `line_items[].note` (per-item): context that ISN'T already shown elsewhere on the invoice. Conversion math, FX rates, billing periods, dates the recipient can't see otherwise. **Do NOT include 'Source: Invoice X' or filenames in the note when you've also attached the source PDF. the attachment label is the citation. Repeating it as text is visual noise.** Keep it terse.\n- `notes` (invoice-level): context for the WHOLE invoice. payment instructions, thank-yous, reimbursement framing.\n- `terms` (invoice-level): standing terms like `Payment due within 30 days via bank transfer`.\n- `attachments` on a line item: supporting files. The label IS the source citation. name them naturally (`Apple receipt`, `Hotel folio`). Don't repeat their contents in the description or note.\n\nATTACHMENTS: base64 uploads only. `{file_base64, mime_type, filename?, label?}` where mime_type is `image/png`, `image/jpeg`, `image/webp`, or `application/pdf` (max 8 MB, 10 per line item). Pass PDFs through as-is. don't rasterize.\n\nInvoice number is allocated automatically. Dates default to today + net-30; currency defaults to the client's default then the business's. Returns the full invoice + share URL. To email it, call send_invoice next.",
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
        issueDate: d.issue_date,
        dueDate: d.due_date,
        currency: d.currency,
        notes: d.notes ?? null,
        terms: d.terms ?? null,
        clientRequestId: d.client_request_id ?? null,
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
        });
      }
      return toolOk({
        ...formatInvoiceForMcp(result.invoice),
        share_url: invoiceShareUrl(result.invoice.shareSlug),
      });
    },
  );

  server.registerTool(
    "update_invoice",
    {
      title: "Update invoice (draft only)",
      description:
        "Update draft invoice headers. Only drafts are editable. Pass `business_id` to MOVE the invoice to render under a different business — a new invoice number is allocated under that business automatically. To change line items use add_line_item / update_line_item / remove_line_item. For finalized invoices use void_invoice + duplicate_invoice.",
      inputSchema: {
        invoice_id: uuid,
        business_id: uuid.optional(),
        client_id: uuid.optional(),
        issue_date: isoDate.optional(),
        due_date: isoDate.optional(),
        notes: z.string().max(4000).nullish(),
        terms: z.string().max(4000).nullish(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          invoice_id: uuid,
          business_id: uuid.optional(),
          client_id: uuid.optional(),
          issue_date: isoDate.optional(),
          due_date: isoDate.optional(),
          notes: z.string().max(4000).nullish(),
          terms: z.string().max(4000).nullish(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, undefined);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const r = await updateInvoice(ctx, d.invoice_id, {
        clientId: d.client_id,
        businessId: d.business_id,
        issueDate: d.issue_date,
        dueDate: d.due_date,
        notes: d.notes ?? undefined,
        terms: d.terms ?? undefined,
      });
      if (!r.ok)
        return toolError(mapMutateError(r.code), r.message, {
          hint:
            r.code === "invoice_not_draft"
              ? "Void the invoice and call duplicate_invoice to create a new draft."
              : r.code === "business_not_found"
                ? "Call whoami to see businesses on this account, then pass a valid id."
                : undefined,
        });
      return toolOk({ ...formatInvoiceForMcp(r.value), share_url: invoiceShareUrl(r.value.shareSlug) });
    },
  );

  server.registerTool(
    "add_line_item",
    {
      title: "Add line item (draft only)",
      description:
        "Append a line item to a draft invoice. Totals are recomputed automatically. Optional `attachments` accepts an array of supporting docs. each is either `{url, label?}` (passthrough link) or `{file_base64, mime_type, filename?, label?}` (inline upload; mime_type = image/png|jpeg|webp or application/pdf, max 8 MB). If the user shared a file, upload it via base64. pass PDFs through as-is, don't convert them to images.",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "update_line_item",
    {
      title: "Update line item (draft only)",
      description:
        "Update fields on a draft invoice line item. Pass only the fields you want to change. Passing `attachments` REPLACES the whole list (send every file you want on the line item. any attachment you don't re-send is removed). Pass `attachments: []` to clear.",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "remove_line_item",
    {
      title: "Remove line item (draft only)",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description: "Fetch an invoice by id. full header, line items, and totals.",
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
        "List invoices with optional filters. Order: issue_date desc. Use this for 'get the last 10 invoices to this client', 'what's outstanding?', etc. Status 'overdue' is computed (status=sent AND due_date<today).",
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
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const rows = await listInvoices(ctx, {
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
      description: "Resolve an invoice_number like 'INV-0042' to an invoice id.",
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
        "Clone an existing invoice's line items into a new draft. Optionally retarget to a different client. Returns the new draft invoice.",
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
        "Record payment for an invoice. Defaults amount to the invoice total and paid_at to today. Supports partial payments. pass an amount less than total to reflect that. Amount must be >= 0.",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "void_invoice",
    {
      title: "Void invoice",
      description:
        "Void an invoice (any status). Voided invoices are kept for audit, but can't be paid or edited. Use this when a sent invoice needs correction. then call duplicate_invoice for the replacement.",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete invoice (draft only)",
      description:
        "Soft-delete a draft invoice. Sent/paid/void invoices must be kept for audit. use void_invoice instead.",
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
        "Return the public share URL for an invoice. The URL is unguessable and public until share_enabled is set to false via set_invoice_share_enabled.",
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
        "Flip a draft invoice to 'sent' status WITHOUT emailing anyone. Use this when the user delivered the invoice some other way (handed it over in person, WhatsApp, Slack, printed and mailed, etc.) or just wants to lock it in for their own records. Takes the client + business snapshot onto the row. For email delivery, use send_invoice instead. Returns the updated invoice. Already-sent / paid / void invoices are left untouched.",
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
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "send_invoice",
    {
      title: "Email invoice to client",
      description:
        "Send an invoice to the client by email. Generates the PDF as an attachment and includes a link to the public share page. Defaults `to` to the client's email; pass `to` to override. Flips the invoice from draft to sent and freezes the client+business snapshot onto the invoice (so later edits to the client don't mutate the sent copy). Safe to call again on an already-sent invoice. it just re-sends without re-snapshotting.",
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
