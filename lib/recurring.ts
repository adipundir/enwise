import { addDays, addMonths, addYears } from "date-fns";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, recurringInvoiceTemplates, type RecurringInvoiceTemplate } from "@/lib/db/schema";
import { createInvoice, type LineItemInput } from "@/lib/invoices";
import type { ScopedCtx } from "@/lib/mcp/context";
import { sendInvoiceByEmail } from "@/lib/email/sendInvoice";

export type Interval = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

export interface RecurringTemplateInput {
  clientId: string;
  name?: string | null;
  lineItems: LineItemInput[];
  currency?: string;
  interval: Interval;
  anchorDay?: number | null;
  startDate: string; // YYYY-MM-DD
  notes?: string | null;
  terms?: string | null;
  paymentTermsDays?: number | null;
  autoSend?: boolean;
}

export type RecurringResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "not_found" | "client_not_found" | "invalid_input";
      message: string;
      hint?: string;
    };

// ---------- Interval math ----------

/**
 * Compute the next run date after `from`. Monthly and longer intervals keep
 * anchorDay if set; day is clamped to month end when the target month has
 * fewer days (Jan 31 → Feb 28/29).
 */
export function computeNext(
  interval: Interval,
  anchorDay: number | null | undefined,
  from: string,
): string {
  const d = new Date(from + "T00:00:00Z");
  let next: Date;
  switch (interval) {
    case "weekly":
      next = addDays(d, 7);
      break;
    case "biweekly":
      next = addDays(d, 14);
      break;
    case "monthly":
      next = addMonths(d, 1);
      if (anchorDay) next = clampToAnchor(next, anchorDay);
      break;
    case "quarterly":
      next = addMonths(d, 3);
      if (anchorDay) next = clampToAnchor(next, anchorDay);
      break;
    case "yearly":
      next = addYears(d, 1);
      if (anchorDay) next = clampToAnchor(next, anchorDay);
      break;
  }
  return next.toISOString().slice(0, 10);
}

function clampToAnchor(date: Date, anchorDay: number): Date {
  // date-fns returns the same day-of-month when possible; clamp if anchor > month length.
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  // Last day of that month:
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, last);
  return new Date(Date.UTC(year, month, day));
}

// ---------- CRUD ----------

export async function createRecurring(
  ctx: ScopedCtx,
  input: RecurringTemplateInput,
): Promise<RecurringResult<RecurringInvoiceTemplate>> {
  if (input.lineItems.length === 0) {
    return { ok: false, code: "invalid_input", message: "At least one line item required." };
  }
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.ownerUserId, ctx.userId)));
  if (!client) return { ok: false, code: "client_not_found", message: `No client with id ${input.clientId}.` };

  const currency = (input.currency ?? client.defaultCurrency ?? "USD").toUpperCase();
  const anchor = input.anchorDay ?? inferAnchor(input.interval, input.startDate);

  const [row] = await db
    .insert(recurringInvoiceTemplates)
    .values({
      ownerUserId: ctx.userId,
      businessId: ctx.businessId,
      clientId: input.clientId,
      name: input.name ?? null,
      lineItems: input.lineItems,
      currency,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      interval: input.interval,
      anchorDay: anchor,
      nextRunAt: input.startDate,
      active: true,
      autoSend: input.autoSend ?? false,
    })
    .returning();
  return { ok: true, value: row! };
}

function inferAnchor(interval: Interval, start: string): number | null {
  if (interval === "weekly" || interval === "biweekly") {
    return new Date(start + "T00:00:00Z").getUTCDay();
  }
  return new Date(start + "T00:00:00Z").getUTCDate();
}

export interface RecurringPatch {
  name?: string | null;
  lineItems?: LineItemInput[];
  currency?: string;
  notes?: string | null;
  terms?: string | null;
  paymentTermsDays?: number | null;
  interval?: Interval;
  anchorDay?: number | null;
  nextRunAt?: string;
  autoSend?: boolean;
}

export async function updateRecurring(
  ctx: ScopedCtx,
  id: string,
  patch: RecurringPatch,
): Promise<RecurringResult<RecurringInvoiceTemplate>> {
  const values: Partial<RecurringInvoiceTemplate> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name ?? null;
  if (patch.lineItems !== undefined) values.lineItems = patch.lineItems;
  if (patch.currency !== undefined) values.currency = patch.currency.toUpperCase();
  if (patch.notes !== undefined) values.notes = patch.notes ?? null;
  if (patch.terms !== undefined) values.terms = patch.terms ?? null;
  if (patch.paymentTermsDays !== undefined) values.paymentTermsDays = patch.paymentTermsDays ?? null;
  if (patch.interval !== undefined) values.interval = patch.interval;
  if (patch.anchorDay !== undefined) values.anchorDay = patch.anchorDay ?? null;
  if (patch.nextRunAt !== undefined) values.nextRunAt = patch.nextRunAt;
  if (patch.autoSend !== undefined) values.autoSend = patch.autoSend;

  const [row] = await db
    .update(recurringInvoiceTemplates)
    .set(values)
    .where(
      and(
        eq(recurringInvoiceTemplates.id, id),
        eq(recurringInvoiceTemplates.ownerUserId, ctx.userId),
      ),
    )
    .returning();
  if (!row) return { ok: false, code: "not_found", message: `No recurring template with id ${id}.` };
  return { ok: true, value: row };
}

export async function listRecurring(
  ctx: ScopedCtx,
  opts: { clientId?: string; activeOnly?: boolean } = {},
): Promise<RecurringInvoiceTemplate[]> {
  const conditions = [eq(recurringInvoiceTemplates.ownerUserId, ctx.userId)];
  if (opts.clientId) conditions.push(eq(recurringInvoiceTemplates.clientId, opts.clientId));
  if (opts.activeOnly) conditions.push(eq(recurringInvoiceTemplates.active, true));
  return db
    .select()
    .from(recurringInvoiceTemplates)
    .where(and(...conditions))
    .orderBy(asc(recurringInvoiceTemplates.nextRunAt));
}

export async function getRecurring(
  ctx: ScopedCtx,
  id: string,
): Promise<RecurringInvoiceTemplate | null> {
  const [row] = await db
    .select()
    .from(recurringInvoiceTemplates)
    .where(
      and(
        eq(recurringInvoiceTemplates.id, id),
        eq(recurringInvoiceTemplates.ownerUserId, ctx.userId),
      ),
    );
  return row ?? null;
}

export async function setActive(
  ctx: ScopedCtx,
  id: string,
  active: boolean,
): Promise<RecurringResult<RecurringInvoiceTemplate>> {
  const [row] = await db
    .update(recurringInvoiceTemplates)
    .set({ active, updatedAt: new Date() })
    .where(
      and(
        eq(recurringInvoiceTemplates.id, id),
        eq(recurringInvoiceTemplates.ownerUserId, ctx.userId),
      ),
    )
    .returning();
  if (!row) return { ok: false, code: "not_found", message: `No recurring template with id ${id}.` };
  return { ok: true, value: row };
}

export async function cancelRecurring(
  ctx: ScopedCtx,
  id: string,
): Promise<RecurringResult<{ deleted: true }>> {
  const [row] = await db
    .delete(recurringInvoiceTemplates)
    .where(
      and(
        eq(recurringInvoiceTemplates.id, id),
        eq(recurringInvoiceTemplates.ownerUserId, ctx.userId),
      ),
    )
    .returning({ id: recurringInvoiceTemplates.id });
  if (!row) return { ok: false, code: "not_found", message: `No recurring template with id ${id}.` };
  return { ok: true, value: { deleted: true } };
}

// ---------- Runner (shared between manual + cron) ----------

export interface RunResult {
  template_id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  status: "generated" | "auto_sent" | "send_failed" | "skipped" | "error";
  error?: string;
}

export async function runTemplate(
  template: RecurringInvoiceTemplate,
): Promise<RunResult> {
  // Cron runs outside a user session. Look up the business owner so the
  // synthesized ScopedCtx has a real userId. tools downstream that assume
  // an authenticated user (e.g. any future per-user rate limiting) keep
  // working against cron-generated invoices.
  const [owner] = await db
    .select({ userId: businesses.ownerUserId })
    .from(businesses)
    .where(eq(businesses.id, template.businessId));
  if (!owner) {
    return {
      template_id: template.id,
      invoice_id: null,
      invoice_number: null,
      status: "error",
      error: "Business for this template no longer exists.",
    };
  }
  const ctx: ScopedCtx = {
    userId: owner.userId,
    businessId: template.businessId,
    tokenId: "cron",
  };
  const lineItems = template.lineItems as LineItemInput[];
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = template.paymentTermsDays
    ? addDaysIso(issueDate, template.paymentTermsDays)
    : addDaysIso(issueDate, 30);

  const created = await createInvoice(ctx, {
    clientId: template.clientId,
    currency: template.currency,
    issueDate,
    dueDate,
    lineItems,
    notes: template.notes,
    terms: template.terms,
    clientRequestId: `recurring:${template.id}:${template.nextRunAt}`,
  });
  if (!created.ok) {
    return {
      template_id: template.id,
      invoice_id: null,
      invoice_number: null,
      status: "error",
      error: created.message,
    };
  }

  let sentOk = false;
  let sendError: string | null = null;
  if (template.autoSend) {
    const sendResult = await sendInvoiceByEmail(ctx, { invoiceId: created.invoice.id });
    sentOk = sendResult.ok;
    if (!sendResult.ok) sendError = `${sendResult.code}: ${sendResult.message}`;
  }

  const nextRunAt = computeNext(template.interval, template.anchorDay, issueDate);
  await db
    .update(recurringInvoiceTemplates)
    .set({
      lastRunAt: issueDate,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(recurringInvoiceTemplates.id, template.id));

  // Surface auto-send failures so cron summaries / manual `run_now` callers
  // can see that the invoice was created but not delivered. The invoice
  // itself stays in "draft" state (sendInvoiceByEmail reverts on failure)
  // so the user can retry via send_invoice once the underlying issue
  // (Resend API key, unverified domain, etc.) is fixed.
  if (template.autoSend && !sentOk) {
    return {
      template_id: template.id,
      invoice_id: created.invoice.id,
      invoice_number: created.invoice.invoiceNumber,
      status: "send_failed",
      error: sendError ?? "Auto-send failed for unknown reason.",
    };
  }

  return {
    template_id: template.id,
    invoice_id: created.invoice.id,
    invoice_number: created.invoice.invoiceNumber,
    status: sentOk ? "auto_sent" : "generated",
  };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Cron entry point. Finds all active templates due today or earlier across all
 * businesses and runs them. Returns per-template results.
 */
export async function runDueNow(opts: { limit?: number } = {}): Promise<RunResult[]> {
  const limit = opts.limit ?? 500;
  const due = await db
    .select()
    .from(recurringInvoiceTemplates)
    .where(
      and(
        eq(recurringInvoiceTemplates.active, true),
        lte(recurringInvoiceTemplates.nextRunAt, sql`current_date`),
      ),
    )
    .limit(limit);

  const results: RunResult[] = [];
  for (const template of due) {
    try {
      results.push(await runTemplate(template));
    } catch (err) {
      results.push({
        template_id: template.id,
        invoice_id: null,
        invoice_number: null,
        status: "error",
        error: (err as Error).message,
      });
    }
  }
  return results;
}

export async function runTemplateById(
  ctx: ScopedCtx,
  id: string,
): Promise<RecurringResult<RunResult>> {
  const template = await getRecurring(ctx, id);
  if (!template) return { ok: false, code: "not_found", message: `No recurring template with id ${id}.` };
  const result = await runTemplate(template);
  return { ok: true, value: result };
}

export function formatRecurringForMcp(row: RecurringInvoiceTemplate) {
  return {
    id: row.id,
    name: row.name,
    client_id: row.clientId,
    currency: row.currency,
    interval: row.interval,
    anchor_day: row.anchorDay,
    next_run_at: row.nextRunAt,
    last_run_at: row.lastRunAt,
    active: row.active,
    auto_send: row.autoSend,
    line_items: row.lineItems,
    notes: row.notes,
    terms: row.terms,
    payment_terms_days: row.paymentTermsDays,
  };
}
