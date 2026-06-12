import { z } from "zod";
import {
  cancelRecurring,
  createRecurring,
  formatRecurringForMcp,
  getRecurring,
  listRecurring,
  runTemplateById,
  setActive,
  updateRecurring,
  type Interval,
} from "@/lib/recurring";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const amount = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s$€£¥]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({ code: "custom", message: "Amount must be a number." });
      return z.NEVER;
    }
    const [intPart, decPart = ""] = raw.split(".");
    return `${intPart}.${(decPart + "00").slice(0, 2)}`;
  });

const quantity = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

const taxRate = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s%]/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      ctx.addIssue({ code: "custom", message: "Tax rate must be a fraction between 0 and 1." });
      return z.NEVER;
    }
    return n.toFixed(4);
  });

const lineItemSchema = z.object({
  business_id: uuid.optional(),
  description: z.string().min(1).max(500),
  quantity,
  unit_price: amount,
  tax_rate: taxRate.optional(),
  product_id: uuid.nullish(),
});

const intervalSchema = z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);

const createSchema = {
  business_id: uuid.optional(),
  client_id: uuid,
  name: z.string().max(200).nullish(),
  line_items: z.array(lineItemSchema).min(1).max(200),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((s) => s.toUpperCase())
    .optional(),
  interval: intervalSchema,
  anchor_day: z.number().int().min(0).max(31).nullish(),
  start_date: isoDate,
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  payment_terms_days: z.number().int().min(0).max(365).nullish(),
  auto_send: z.boolean().optional(),
};

function toLineItems(items: z.infer<typeof lineItemSchema>[]) {
  return items.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unit_price,
    taxRate: l.tax_rate,
    productId: l.product_id ?? null,
  }));
}

export function registerRecurringTools(server: McpServer) {
  server.registerTool(
    "create_recurring_invoice",
    {
      title: "Create recurring invoice template",
      description:
        "Schedule an invoice to be created on a cadence (weekly/biweekly/monthly/quarterly/yearly). On each run, a new draft invoice is generated from the line items; if auto_send is true, it's also emailed to the client. Use this for 'invoice Acme $5k every month'.",
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
      const result = await createRecurring(ctx, {
        clientId: d.client_id,
        name: d.name ?? null,
        lineItems: toLineItems(d.line_items),
        currency: d.currency,
        interval: d.interval as Interval,
        anchorDay: d.anchor_day ?? null,
        startDate: d.start_date,
        notes: d.notes ?? null,
        terms: d.terms ?? null,
        paymentTermsDays: d.payment_terms_days ?? null,
        autoSend: d.auto_send,
      });
      if (!result.ok) {
        const code =
          result.code === "client_not_found" ? "not_found" : "invalid_input";
        return toolError(code, result.message, { hint: result.hint });
      }
      return toolOk(formatRecurringForMcp(result.value));
    },
  );

  const updateSchema = {
    business_id: uuid.optional(),
    recurring_id: uuid,
    name: z.string().max(200).nullish(),
    line_items: z.array(lineItemSchema).min(1).max(200).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()).optional(),
    notes: z.string().max(4000).nullish(),
    terms: z.string().max(4000).nullish(),
    payment_terms_days: z.number().int().min(0).max(365).nullish(),
    interval: intervalSchema.optional(),
    anchor_day: z.number().int().min(0).max(31).nullish(),
    next_run_at: isoDate.optional(),
    auto_send: z.boolean().optional(),
  };

  server.registerTool(
    "update_recurring_invoice",
    {
      title: "Update recurring invoice template",
      description:
        "Partially update a recurring template. Change line items, interval, anchor day, next run date, or toggle auto_send. Omitted fields stay as-is.",
      inputSchema: updateSchema,
    },
    async (args, extra) => {
      const parsed = z.object(updateSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const d = parsed.data;
      const result = await updateRecurring(ctx, d.recurring_id, {
        name: d.name ?? undefined,
        lineItems: d.line_items ? toLineItems(d.line_items) : undefined,
        currency: d.currency,
        notes: d.notes ?? undefined,
        terms: d.terms ?? undefined,
        paymentTermsDays: d.payment_terms_days ?? undefined,
        interval: d.interval as Interval | undefined,
        anchorDay: d.anchor_day ?? undefined,
        nextRunAt: d.next_run_at,
        autoSend: d.auto_send,
      });
      if (!result.ok) return toolError("not_found", result.message);
      return toolOk(formatRecurringForMcp(result.value));
    },
  );

  server.registerTool(
    "list_recurring_invoices",
    {
      title: "List recurring invoice templates",
      description:
        "List recurring invoice templates on this account, ordered by `next_run_at` ascending (next-to-fire first). Filter by `client_id` to only see templates for one client. By default includes both active and paused; pass `active_only: true` to filter to currently-firing templates. Each row includes id, client, cadence, currency, last_run_at, next_run_at, auto_send flag, and active status. Pass `business_id` if the user owns multiple businesses.",
      inputSchema: {
        business_id: uuid.optional(),
        client_id: uuid.optional(),
        active_only: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          business_id: uuid.optional(),
          client_id: uuid.optional(),
          active_only: z.boolean().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, parsed.data.business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const rows = await listRecurring(ctx, {
        clientId: parsed.data.client_id,
        activeOnly: parsed.data.active_only,
      });
      return toolOk({ templates: rows.map(formatRecurringForMcp) });
    },
  );

  server.registerTool(
    "get_recurring_invoice",
    {
      title: "Get recurring invoice template",
      description:
        "Fetch a single recurring invoice template by id, including its full line items, cadence (interval + anchor_day), next_run_at / last_run_at, auto_send flag, and active status. Use when the user asks for the details of one schedule ('what's on the monthly Acme invoice?') — list_recurring_invoices to resolve the id first if you only have a client or name.",
      inputSchema: {
    business_id: uuid.optional(), recurring_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), recurring_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const row = await getRecurring(ctx, parsed.data.recurring_id);
      if (!row) {
        return toolError("not_found", `No recurring template with id ${parsed.data.recurring_id}.`);
      }
      return toolOk(formatRecurringForMcp(row));
    },
  );

  server.registerTool(
    "pause_recurring_invoice",
    {
      title: "Pause recurring template",
      description: "Set active=false. No more invoices generated until resumed.",
      inputSchema: {
    business_id: uuid.optional(), recurring_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), recurring_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await setActive(ctx, parsed.data.recurring_id, false);
      if (!r.ok) return toolError("not_found", r.message);
      return toolOk(formatRecurringForMcp(r.value));
    },
  );

  server.registerTool(
    "resume_recurring_invoice",
    {
      title: "Resume recurring template",
      description:
        "Set active=true on a paused recurring template. Invoice generation resumes on the next cron fire (does NOT immediately generate; use run_recurring_invoice_now for that). Inverse of pause_recurring_invoice.",
      inputSchema: {
    business_id: uuid.optional(), recurring_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), recurring_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await setActive(ctx, parsed.data.recurring_id, true);
      if (!r.ok) return toolError("not_found", r.message);
      return toolOk(formatRecurringForMcp(r.value));
    },
  );

  server.registerTool(
    "cancel_recurring_invoice",
    {
      title: "Cancel recurring template",
      description:
        "Permanently delete a recurring template. Invoices already generated from it are unaffected. Use pause_recurring_invoice if you want to temporarily stop.",
      inputSchema: {
    business_id: uuid.optional(), recurring_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), recurring_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await cancelRecurring(ctx, parsed.data.recurring_id);
      if (!r.ok) return toolError("not_found", r.message);
      return toolOk(r.value);
    },
  );

  server.registerTool(
    "run_recurring_invoice_now",
    {
      title: "Run recurring template now (manual)",
      description:
        "Immediately generate the next invoice for a recurring template, regardless of next_run_at. Useful for testing. Advances next_run_at as if the cron had fired.",
      inputSchema: {
    business_id: uuid.optional(), recurring_id: uuid },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), recurring_id: uuid }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const r = await runTemplateById(ctx, parsed.data.recurring_id);
      if (!r.ok) return toolError("not_found", r.message);
      return toolOk(r.value);
    },
  );

  void getRecurring; // keep import (reserved for future get_recurring_invoice tool)
}
