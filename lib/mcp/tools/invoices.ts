import { z } from "zod";
import {
  addLineItem,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
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
import { ctxFromAuthInfo } from "@/lib/mcp/context";
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

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity,
  unit_price: amount,
  tax_rate: taxRate.optional(),
  product_id: uuid.nullish(),
});

const createSchema = {
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
    case "invoice_not_draft":
      return "invoice_not_draft";
    case "invalid_currency":
    case "invalid_amount":
    case "no_line_items":
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
        "Create a draft invoice for a client with one or more line items. Invoice number is allocated automatically (e.g. INV-0001). Dates default to today + net-30; currency defaults to the client's default, then the business's. Returns the full invoice including line totals and a share URL. To send it to the client, call send_invoice next (Phase 5).",
      inputSchema: createSchema,
    },
    async (args, extra) => {
      const parsed = z.object(createSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        })),
      });
      if (!result.ok) {
        return toolError(mapMutateError(result.code), result.message);
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
        "Update draft invoice headers (client, dates, notes, terms). Only drafts are editable. To change line items use add_line_item / update_line_item / remove_line_item. For finalized invoices use void_invoice + duplicate_invoice.",
      inputSchema: {
        invoice_id: uuid,
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
          client_id: uuid.optional(),
          issue_date: isoDate.optional(),
          due_date: isoDate.optional(),
          notes: z.string().max(4000).nullish(),
          terms: z.string().max(4000).nullish(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const d = parsed.data;
      const r = await updateInvoice(ctx, d.invoice_id, {
        clientId: d.client_id,
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
        "Append a line item to a draft invoice. Totals are recomputed automatically.",
      inputSchema: {
        invoice_id: uuid,
        description: z.string().min(1).max(500),
        quantity,
        unit_price: amount,
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        invoice_id: uuid,
        description: z.string().min(1).max(500),
        quantity,
        unit_price: amount,
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const d = parsed.data;
      const r = await addLineItem(ctx, d.invoice_id, {
        description: d.description,
        quantity: d.quantity,
        unitPrice: d.unit_price,
        taxRate: d.tax_rate,
        productId: d.product_id ?? null,
      });
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "update_line_item",
    {
      title: "Update line item (draft only)",
      inputSchema: {
        invoice_id: uuid,
        line_item_id: uuid,
        description: z.string().min(1).max(500).optional(),
        quantity: quantity.optional(),
        unit_price: amount.optional(),
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        invoice_id: uuid,
        line_item_id: uuid,
        description: z.string().min(1).max(500).optional(),
        quantity: quantity.optional(),
        unit_price: amount.optional(),
        tax_rate: taxRate.optional(),
        product_id: uuid.nullish(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const d = parsed.data;
      const patch: Parameters<typeof updateLineItem>[3] = {};
      if (d.description !== undefined) patch.description = d.description;
      if (d.quantity !== undefined) patch.quantity = d.quantity;
      if (d.unit_price !== undefined) patch.unitPrice = d.unit_price;
      if (d.tax_rate !== undefined) patch.taxRate = d.tax_rate;
      if (d.product_id !== undefined) patch.productId = d.product_id ?? null;
      const r = await updateLineItem(ctx, d.invoice_id, d.line_item_id, patch);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "remove_line_item",
    {
      title: "Remove line item (draft only)",
      inputSchema: { invoice_id: uuid, line_item_id: uuid },
    },
    async (args, extra) => {
      const schema = z.object({ invoice_id: uuid, line_item_id: uuid });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const r = await removeLineItem(ctx, parsed.data.invoice_id, parsed.data.line_item_id);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk(formatInvoiceForMcp(r.value));
    },
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description: "Fetch an invoice by id — full header, line items, and totals.",
      inputSchema: { invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        client_id: uuid.optional(),
        status: z.enum(["draft", "sent", "paid", "void", "overdue"]).optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        client_id: uuid.optional(),
        status: z.enum(["draft", "sent", "paid", "void", "overdue"]).optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
      inputSchema: { invoice_number: z.string().min(1).max(40) },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_number: z.string().min(1).max(40) }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        invoice_id: uuid,
        client_id: uuid.optional(),
        new_issue_date: isoDate.optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        invoice_id: uuid,
        client_id: uuid.optional(),
        new_issue_date: isoDate.optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        "Record payment for an invoice. Defaults amount to the invoice total and paid_at to today. Supports partial payments — pass an amount less than total to reflect that. Amount must be >= 0.",
      inputSchema: {
        invoice_id: uuid,
        amount: nonNegativeAmount.optional(),
        paid_at: isoDate.optional(),
      },
    },
    async (args, extra) => {
      const schema = z.object({
        invoice_id: uuid,
        amount: nonNegativeAmount.optional(),
        paid_at: isoDate.optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        "Void an invoice (any status). Voided invoices are kept for audit, but can't be paid or edited. Use this when a sent invoice needs correction — then call duplicate_invoice for the replacement.",
      inputSchema: { invoice_id: uuid, reason: z.string().max(500).optional() },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_id: uuid, reason: z.string().max(500).optional() }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
        "Soft-delete a draft invoice. Sent/paid/void invoices must be kept for audit — use void_invoice instead.",
      inputSchema: { invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
      inputSchema: { invoice_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const inv = await getInvoice(ctx, parsed.data.invoice_id);
      if (!inv) return toolError("not_found", `No invoice with id ${parsed.data.invoice_id}.`);
      return toolOk({
        url: invoiceShareUrl(inv.shareSlug),
        slug: inv.shareSlug,
        enabled: inv.shareEnabled,
      });
    },
  );

  server.registerTool(
    "send_invoice",
    {
      title: "Email invoice to client",
      description:
        "Send an invoice to the client by email. Generates the PDF as an attachment and includes a link to the public share page. Defaults `to` to the client's email; pass `to` to override. Flips the invoice from draft to sent and freezes the client+business snapshot onto the invoice (so later edits to the client don't mutate the sent copy). Safe to call again on an already-sent invoice — it just re-sends without re-snapshotting.",
      inputSchema: {
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
        invoice_id: uuid,
        to: z.array(z.string().email()).max(10).optional(),
        cc: z.array(z.string().email()).max(10).optional(),
        bcc: z.array(z.string().email()).max(10).optional(),
        message: z.string().max(2000).nullish(),
        client_request_id: z.string().max(64).optional(),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
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
      inputSchema: { invoice_id: uuid, enabled: z.boolean() },
    },
    async (args, extra) => {
      const parsed = z.object({ invoice_id: uuid, enabled: z.boolean() }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const r = await setShareEnabled(ctx, parsed.data.invoice_id, parsed.data.enabled);
      if (!r.ok) return toolError(mapMutateError(r.code), r.message);
      return toolOk({
        url: invoiceShareUrl(r.value.shareSlug),
        enabled: r.value.shareEnabled,
      });
    },
  );
}
