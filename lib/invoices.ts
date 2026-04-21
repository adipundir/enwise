import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  clients,
  invoiceEvents,
  invoiceLineItems,
  invoices,
  type Invoice,
  type InvoiceLineItem,
} from "@/lib/db/schema";
import type { EnvoiceCtx } from "@/lib/mcp/context";
import { addAmounts, computeLine, isValidCurrency } from "@/lib/money";
import { allocateInvoiceNumber } from "@/lib/numbering";

// ---------- Shared shapes ----------

export type LineItemInput = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate?: string;
  productId?: string | null;
};

export type CreateInvoiceInput = {
  clientId: string;
  lineItems: LineItemInput[];
  issueDate?: string; // YYYY-MM-DD
  dueDate?: string;   // YYYY-MM-DD
  currency?: string;  // ISO 4217, defaults to client.default_currency or business.default_currency
  notes?: string | null;
  terms?: string | null;
  clientRequestId?: string | null;
};

export type InvoiceWithLineItems = Invoice & {
  lineItems: InvoiceLineItem[];
};

// ---------- Helpers ----------

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toDateStr(d);
}

function isEditable(inv: Invoice): boolean {
  return inv.status === "draft" && inv.deletedAt === null;
}

function recomputeTotals(lines: Pick<InvoiceLineItem, "lineSubtotal" | "lineTax">[]) {
  const subtotal = addAmounts(...lines.map((l) => l.lineSubtotal), "0");
  const taxTotal = addAmounts(...lines.map((l) => l.lineTax), "0");
  const total = addAmounts(subtotal, taxTotal);
  return { subtotal, taxTotal, total };
}

async function writeEvent(
  invoiceId: string,
  eventType: string,
  tokenId: string | null,
  metadata?: Record<string, unknown>,
) {
  await db.insert(invoiceEvents).values({
    invoiceId,
    eventType,
    actor: tokenId ? `mcp:${tokenId.slice(0, 8)}` : null,
    metadata: metadata ?? null,
  });
}

async function getClientScoped(ctx: EnvoiceCtx, clientId: string) {
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, ctx.businessId)));
  return row ?? null;
}

// ---------- Create ----------

export type CreateInvoiceResult =
  | { ok: true; invoice: InvoiceWithLineItems }
  | { ok: false; code: "client_not_found" | "invalid_currency" | "no_line_items" | "invalid_amount"; message: string };

export async function createInvoice(
  ctx: EnvoiceCtx,
  input: CreateInvoiceInput,
): Promise<CreateInvoiceResult> {
  if (input.lineItems.length === 0) {
    return {
      ok: false,
      code: "no_line_items",
      message: "An invoice needs at least one line item.",
    };
  }

  const client = await getClientScoped(ctx, input.clientId);
  if (!client) {
    return {
      ok: false,
      code: "client_not_found",
      message: `No client with id ${input.clientId}.`,
    };
  }

  // Idempotency: early return if client_request_id already used.
  if (input.clientRequestId) {
    const [existing] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, ctx.businessId),
          eq(invoices.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (existing) {
      const items = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, existing.id));
      return { ok: true, invoice: { ...existing, lineItems: items } };
    }
  }

  // Allocate invoice number + snapshot business (atomic).
  const allocation = await allocateInvoiceNumber(ctx);
  if (!allocation) {
    return {
      ok: false,
      code: "client_not_found",
      message: "Business row missing for this token. auth integrity failure.",
    };
  }

  const currency = (input.currency ?? client.defaultCurrency ?? allocation.businessSnapshot.defaultCurrency).toUpperCase();
  if (!isValidCurrency(currency)) {
    return {
      ok: false,
      code: "invalid_currency",
      message: `Currency '${currency}' is not a valid 3-letter ISO 4217 code.`,
    };
  }

  const issueDate = input.issueDate ?? toDateStr(new Date());
  const dueDate = input.dueDate ?? addDays(issueDate, 30);
  const shareSlug = nanoid(24);

  // Compute line totals.
  let computedLines: Array<{
    position: number;
    productId: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    taxRate: string;
    lineSubtotal: string;
    lineTax: string;
    lineTotal: string;
  }>;
  try {
    computedLines = input.lineItems.map((li, idx) => {
      const taxRate = li.taxRate ?? "0";
      const math = computeLine({
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxRate,
      });
      return {
        position: idx,
        productId: li.productId ?? null,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxRate,
        ...math,
      };
    });
  } catch (err) {
    return {
      ok: false,
      code: "invalid_amount",
      message: (err as Error).message,
    };
  }

  const totals = recomputeTotals(computedLines);

  const [invoice] = await db
    .insert(invoices)
    .values({
      businessId: ctx.businessId,
      clientId: client.id,
      invoiceNumber: allocation.invoiceNumber,
      status: "draft",
      issueDate,
      dueDate,
      currency,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      shareSlug,
      clientRequestId: input.clientRequestId ?? null,
      // Snapshots land on finalize (send), not at draft time.
    })
    .returning();
  if (!invoice) {
    return {
      ok: false,
      code: "invalid_amount",
      message: "Failed to insert invoice.",
    };
  }

  await db.insert(invoiceLineItems).values(
    computedLines.map((l) => ({
      invoiceId: invoice.id,
      position: l.position,
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      lineSubtotal: l.lineSubtotal,
      lineTax: l.lineTax,
      lineTotal: l.lineTotal,
    })),
  );

  await writeEvent(invoice.id, "created", ctx.tokenId);

  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoice.id));

  return { ok: true, invoice: { ...invoice, lineItems: items } };
}

// ---------- Read ----------

export async function getInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
): Promise<InvoiceWithLineItems | null> {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.businessId, ctx.businessId),
        isNull(invoices.deletedAt),
      ),
    );
  if (!inv) return null;
  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, inv.id))
    .orderBy(invoiceLineItems.position);
  return { ...inv, lineItems: items };
}

export async function getInvoiceBySlug(
  slug: string,
): Promise<InvoiceWithLineItems | null> {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.shareSlug, slug),
        eq(invoices.shareEnabled, true),
        isNull(invoices.deletedAt),
      ),
    );
  if (!inv) return null;
  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, inv.id))
    .orderBy(invoiceLineItems.position);
  return { ...inv, lineItems: items };
}

export type ListInvoicesOpts = {
  clientId?: string;
  status?: "draft" | "sent" | "paid" | "void" | "overdue";
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
};

export async function listInvoices(
  ctx: EnvoiceCtx,
  opts: ListInvoicesOpts = {},
): Promise<Invoice[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const conditions = [
    eq(invoices.businessId, ctx.businessId),
    isNull(invoices.deletedAt),
  ];
  if (opts.clientId) conditions.push(eq(invoices.clientId, opts.clientId));
  if (opts.status === "overdue") {
    conditions.push(eq(invoices.status, "sent"));
    conditions.push(sql`${invoices.dueDate} < current_date`);
  } else if (opts.status) {
    conditions.push(eq(invoices.status, opts.status));
  }
  if (opts.dateFrom) conditions.push(sql`${invoices.issueDate} >= ${opts.dateFrom}`);
  if (opts.dateTo) conditions.push(sql`${invoices.issueDate} <= ${opts.dateTo}`);

  return db
    .select()
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.issueDate), desc(invoices.invoiceNumber))
    .limit(limit);
}

export async function findInvoiceByNumber(
  ctx: EnvoiceCtx,
  invoiceNumber: string,
): Promise<Invoice | null> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, ctx.businessId),
        eq(invoices.invoiceNumber, invoiceNumber),
        isNull(invoices.deletedAt),
      ),
    );
  return row ?? null;
}

// ---------- Mutate (draft only) ----------

export type UpdateInvoiceInput = {
  clientId?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string | null;
  terms?: string | null;
};

export type MutateResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "invoice_not_draft" | "client_not_found"; message: string };

export async function updateInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
  patch: UpdateInvoiceInput,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts are editable.`,
    };
  }
  if (patch.clientId && patch.clientId !== inv.clientId) {
    const c = await getClientScoped(ctx, patch.clientId);
    if (!c) return { ok: false, code: "client_not_found", message: `No client with id ${patch.clientId}.` };
  }
  const values: Partial<Invoice> = { updatedAt: new Date() };
  if (patch.clientId !== undefined) values.clientId = patch.clientId;
  if (patch.issueDate !== undefined) values.issueDate = patch.issueDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.terms !== undefined) values.terms = patch.terms;

  await db.update(invoices).set(values).where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "updated", ctx.tokenId);
  const after = await getInvoice(ctx, inv.id);
  return { ok: true, value: after! };
}

async function withRecomputedTotals(invoiceId: string) {
  const items = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(invoiceLineItems.position);
  const totals = recomputeTotals(items);
  await db
    .update(invoices)
    .set({
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId));
  return items;
}

export async function addLineItem(
  ctx: EnvoiceCtx,
  invoiceId: string,
  item: LineItemInput,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts are editable.`,
    };
  }
  const math = computeLine({
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate ?? "0",
  });
  const existingCount = inv.lineItems.length;
  await db.insert(invoiceLineItems).values({
    invoiceId: inv.id,
    position: existingCount,
    productId: item.productId ?? null,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate ?? "0",
    ...math,
  });
  await withRecomputedTotals(inv.id);
  await writeEvent(inv.id, "updated", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

export async function updateLineItem(
  ctx: EnvoiceCtx,
  invoiceId: string,
  lineItemId: string,
  patch: Partial<LineItemInput>,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts are editable.`,
    };
  }
  const existing = inv.lineItems.find((l) => l.id === lineItemId);
  if (!existing) return { ok: false, code: "not_found", message: `No line item with id ${lineItemId} on invoice ${inv.invoiceNumber}.` };

  const next = {
    description: patch.description ?? existing.description,
    quantity: patch.quantity ?? existing.quantity,
    unitPrice: patch.unitPrice ?? existing.unitPrice,
    taxRate: patch.taxRate ?? existing.taxRate,
    productId: patch.productId !== undefined ? patch.productId ?? null : existing.productId,
  };
  const math = computeLine(next);
  await db
    .update(invoiceLineItems)
    .set({ ...next, ...math })
    .where(eq(invoiceLineItems.id, lineItemId));
  await withRecomputedTotals(inv.id);
  await writeEvent(inv.id, "updated", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

export async function removeLineItem(
  ctx: EnvoiceCtx,
  invoiceId: string,
  lineItemId: string,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts are editable.`,
    };
  }
  await db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, lineItemId));
  // Renumber positions and recompute.
  const remaining = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, inv.id))
    .orderBy(invoiceLineItems.position);
  for (let i = 0; i < remaining.length; i++) {
    const li = remaining[i]!;
    if (li.position !== i) {
      await db.update(invoiceLineItems).set({ position: i }).where(eq(invoiceLineItems.id, li.id));
    }
  }
  await withRecomputedTotals(inv.id);
  await writeEvent(inv.id, "updated", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

// ---------- Finalize (take snapshot + flip draft→sent) ----------

/**
 * Captures client + business snapshots on the invoice row on first finalize,
 * flips status draft→sent, stamps sent_at. Re-sending an already-sent invoice
 * only bumps sent_at; snapshots are preserved.
 *
 * This is an internal service function, called by the email send pipeline.
 */
export async function finalizeInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (inv.status === "void") {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is void and cannot be sent.`,
    };
  }

  // Re-send: already finalized, just bump sent_at.
  if (inv.clientNameSnapshot !== null) {
    await db
      .update(invoices)
      .set({ sentAt: new Date(), updatedAt: new Date() })
      .where(eq(invoices.id, inv.id));
    await writeEvent(inv.id, "sent", ctx.tokenId, { resend: true });
    return { ok: true, value: (await getInvoice(ctx, inv.id))! };
  }

  // First send: snapshot client + business rows onto the invoice.
  const client = await getClientScoped(ctx, inv.clientId);
  if (!client) {
    return {
      ok: false,
      code: "client_not_found",
      message: `No client with id ${inv.clientId}.`,
    };
  }
  const bizRows = await db.execute(sql`
    select name, logo_url, address_line1, address_line2, city, region, postal_code, country
    from businesses where id = ${ctx.businessId}
  `);
  const biz = bizRows.rows[0] as
    | {
        name: string;
        logo_url: string | null;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        region: string | null;
        postal_code: string | null;
        country: string | null;
      }
    | undefined;
  if (!biz) {
    return {
      ok: false,
      code: "not_found",
      message: "Business row missing.",
    };
  }

  const now = new Date();
  await db
    .update(invoices)
    .set({
      status: "sent",
      sentAt: now,
      updatedAt: now,
      clientNameSnapshot: client.name,
      clientEmailSnapshot: client.email,
      clientAddressSnapshot: {
        line1: client.addressLine1,
        line2: client.addressLine2,
        city: client.city,
        region: client.region,
        postal_code: client.postalCode,
        country: client.country,
      },
      businessNameSnapshot: biz.name,
      businessLogoUrlSnapshot: biz.logo_url,
      businessAddressSnapshot: {
        line1: biz.address_line1,
        line2: biz.address_line2,
        city: biz.city,
        region: biz.region,
        postal_code: biz.postal_code,
        country: biz.country,
      },
    })
    .where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "sent", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

// ---------- Status transitions ----------

export async function markInvoicePaid(
  ctx: EnvoiceCtx,
  invoiceId: string,
  opts: { amount?: string; paidAt?: string } = {},
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (inv.status === "void") {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is void and cannot be marked paid.`,
    };
  }
  const amount = opts.amount ?? inv.total;
  const paidAt = opts.paidAt ? new Date(opts.paidAt) : new Date();
  await db
    .update(invoices)
    .set({
      status: "paid",
      amountPaid: amount,
      paidAt,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "paid", ctx.tokenId, { amount });
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

export async function voidInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
  opts: { reason?: string } = {},
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (inv.status === "void") {
    return { ok: true, value: inv };
  }
  await db
    .update(invoices)
    .set({ status: "void", voidedAt: new Date(), updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "voided", ctx.tokenId, opts.reason ? { reason: opts.reason } : undefined);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

export async function deleteInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
): Promise<MutateResult<{ deleted: true }>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts can be deleted. Use void_invoice instead.`,
    };
  }
  await db
    .update(invoices)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));
  return { ok: true, value: { deleted: true } };
}

export async function setShareEnabled(
  ctx: EnvoiceCtx,
  invoiceId: string,
  enabled: boolean,
): Promise<MutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  await db
    .update(invoices)
    .set({ shareEnabled: enabled, updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

// ---------- Duplicate ----------

export async function duplicateInvoice(
  ctx: EnvoiceCtx,
  invoiceId: string,
  opts: { clientId?: string; newIssueDate?: string } = {},
): Promise<CreateInvoiceResult> {
  const source = await getInvoice(ctx, invoiceId);
  if (!source) {
    return { ok: false, code: "client_not_found", message: `No invoice with id ${invoiceId}.` };
  }
  return createInvoice(ctx, {
    clientId: opts.clientId ?? source.clientId,
    lineItems: source.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      productId: l.productId,
    })),
    issueDate: opts.newIssueDate,
    currency: source.currency,
    notes: source.notes,
    terms: source.terms,
  });
}

// ---------- Mark viewed (public page) ----------

export async function markInvoiceViewed(slug: string) {
  await db
    .update(invoices)
    .set({ viewedAt: new Date() })
    .where(
      and(
        eq(invoices.shareSlug, slug),
        isNull(invoices.viewedAt),
      ),
    );
}

// ---------- MCP formatting ----------

export function formatInvoiceForMcp(inv: InvoiceWithLineItems) {
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    status: inv.status,
    client_id: inv.clientId,
    issue_date: inv.issueDate,
    due_date: inv.dueDate,
    currency: inv.currency,
    subtotal: inv.subtotal,
    tax_total: inv.taxTotal,
    total: inv.total,
    amount_paid: inv.amountPaid,
    outstanding: addAmounts(inv.total, `-${inv.amountPaid}`),
    notes: inv.notes,
    terms: inv.terms,
    share_slug: inv.shareSlug,
    share_enabled: inv.shareEnabled,
    sent_at: inv.sentAt?.toISOString() ?? null,
    viewed_at: inv.viewedAt?.toISOString() ?? null,
    paid_at: inv.paidAt?.toISOString() ?? null,
    voided_at: inv.voidedAt?.toISOString() ?? null,
    line_items: inv.lineItems.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      tax_rate: l.taxRate,
      line_subtotal: l.lineSubtotal,
      line_tax: l.lineTax,
      line_total: l.lineTotal,
      product_id: l.productId,
    })),
  };
}

export function formatInvoiceSummaryForMcp(inv: Invoice) {
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    status: inv.status,
    client_id: inv.clientId,
    issue_date: inv.issueDate,
    due_date: inv.dueDate,
    currency: inv.currency,
    total: inv.total,
    amount_paid: inv.amountPaid,
    outstanding: addAmounts(inv.total, `-${inv.amountPaid}`),
    share_slug: inv.shareSlug,
    share_enabled: inv.shareEnabled,
  };
}

export function invoiceShareUrl(slug: string): string {
  const base =
    process.env.PUBLIC_BASE_URL ??
    process.env.AUTH_URL ??
    "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/i/${slug}`;
}
