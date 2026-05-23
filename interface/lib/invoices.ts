import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  businesses,
  clients,
  invoiceEvents,
  invoiceLineItems,
  invoicePayments,
  invoices,
  type Invoice,
  type InvoiceLineItem,
  type InvoicePayment,
} from "@/lib/db/schema";
import type { EnwiseCtx, ScopedCtx } from "@/lib/mcp/context";
import {
  getDefaultBankAccount,
  listBankAccounts,
  resolveInvoiceBankAccounts,
  setDefaultBankAccount,
  toSnapshotShape,
} from "@/lib/bankAccounts";
import { addAmounts, computeLine, isValidCurrency } from "@/lib/money";
import { allocateInvoiceNumber } from "@/lib/numbering";
import {
  resolveAttachment,
  type AttachmentInput,
  type AttachmentResolved,
} from "@/lib/storage/blob";

const ATTACHMENTS_PER_LINE_ITEM = 10;

// ---------- Shared shapes ----------

export type LineItemAttachment = AttachmentResolved;

export type LineItemInput = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate?: string;
  productId?: string | null;
  /** Per-item context: conversion math, source reference numbers, dates, etc.
   *  Whole-invoice context belongs on the invoice's `notes` field. */
  note?: string | null;
  /**
   * Optional supporting docs. External callers (the MCP layer) pass
   * `{attachment_url}` entries pointing at files already uploaded to our
   * Blob via POST /api/upload. Internal callers (duplicate_invoice) can
   * pass already-resolved `{label, url}` entries — we re-use them as-is.
   */
  attachments?: (AttachmentInput | LineItemAttachment)[];
};

export type CreateInvoiceInput = {
  clientId: string;
  lineItems: LineItemInput[];
  issueDate?: string; // YYYY-MM-DD
  dueDate?: string;   // YYYY-MM-DD
  currency?: string;  // ISO 4217. Falls back to client.default_currency; otherwise create_invoice returns currency_required.
  notes?: string | null;
  terms?: string | null;
  clientRequestId?: string | null;
  /** Per-invoice payment-rail gate.
   *  - undefined → caller (MCP create_invoice handler) defaults to ["bank"]
   *  - ["bank"]               → bank panel only, no wallet
   *  - ["bank","crypto_wallet"] → both rails
   *  - []                     → no payment block at all
   *  Wallet is opt-in: a non-empty value omitting crypto_wallet hides the
   *  wallet address on the share page and the Pay-with-USDC button. */
  acceptedPaymentMethods?: string[];
  /** Per-invoice bank-account picker:
   *  - undefined → use the business's default account (or prompt if none set)
   *  - []        → no bank panel on this invoice
   *  - [id, …]   → exactly those accounts, in this order
   *  When exactly one id is passed and the business has no current default,
   *  that id is promoted to default for future invoices. */
  acceptedBankAccountIds?: string[];
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

export type AttachmentResolveError = {
  code:
    | "attachment_too_large"
    | "attachment_invalid_mime"
    | "attachment_storage_unavailable";
  message: string;
  hint?: string;
};

/**
 * Walk a list of attachment inputs and resolve each to its final
 * `{label, url}` form. Every input is a base64 upload. URL passthrough
 * was removed. Fails fast on the first error so callers can surface
 * a clean message to Claude without a partial DB write.
 */
async function resolveAttachments(
  ctx: ScopedCtx,
  inputs: (AttachmentInput | LineItemAttachment)[] | undefined,
): Promise<
  | { ok: true; attachments: LineItemAttachment[] }
  | { ok: false; error: AttachmentResolveError }
> {
  if (!inputs || inputs.length === 0) return { ok: true, attachments: [] };

  if (inputs.length > ATTACHMENTS_PER_LINE_ITEM) {
    return {
      ok: false,
      error: {
        code: "attachment_too_large",
        message: `Up to ${ATTACHMENTS_PER_LINE_ITEM} attachments per line item.`,
      },
    };
  }

  const resolved: LineItemAttachment[] = [];
  for (const input of inputs) {
    // Already-resolved entry (duplicate_invoice hands these through with
    // the LineItemAttachment shape `{label, url}`). We trust them because
    // the url was minted by us during the original upload — no re-upload
    // needed. Distinguish from user-supplied `{attachment_url}` by which
    // field is present.
    if ("url" in input) {
      resolved.push({ label: input.label, url: input.url });
      continue;
    }
    const r = await resolveAttachment({
      businessId: ctx.businessId,
      input,
    });
    if (!r.ok) {
      return { ok: false, error: { code: r.code, message: r.message, hint: r.hint } };
    }
    resolved.push(r.attachment);
  }
  return { ok: true, attachments: resolved };
}

async function getClientScoped(ctx: ScopedCtx, clientId: string) {
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.ownerUserId, ctx.userId)));
  return row ?? null;
}

// ---------- Create ----------

export type CreateInvoiceResult =
  | { ok: true; invoice: InvoiceWithLineItems }
  | {
      ok: false;
      code:
        | "client_not_found"
        | "invalid_currency"
        | "currency_required"
        | "no_line_items"
        | "invalid_amount"
        | "onboarding_required"
        | "bank_account_required"
        | "invalid_bank_account"
        | "attachment_too_large"
        | "attachment_invalid_mime"
        | "attachment_storage_unavailable";
      message: string;
      hint?: string;
      /** Populated on bank_account_required so Claude can present the list
       *  to the user. Each entry is the same shape as list_bank_accounts. */
      bank_accounts?: Array<{
        id: string;
        label: string;
        bank_name: string | null;
        account_number: string | null;
        currency: string | null;
        is_default: boolean;
      }>;
    };

export async function createInvoice(
  ctx: ScopedCtx,
  input: CreateInvoiceInput,
): Promise<CreateInvoiceResult> {
  if (input.lineItems.length === 0) {
    return {
      ok: false,
      code: "no_line_items",
      message: "An invoice needs at least one line item.",
    };
  }

  // Gate: refuse to create invoices until the business profile is set up.
  // Anything we put on the invoice (name on PDF, address, tax ID) would be
  // placeholders otherwise. This catches the case where Claude skipped the
  // whoami/onboarding step and jumped straight to create_invoice.
  const [biz] = await db
    .select({
      name: businesses.name,
      addressLine1: businesses.addressLine1,
      country: businesses.country,
      taxId: businesses.taxId,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));
  const profileEmpty =
    !biz?.addressLine1 && !biz?.country && !biz?.taxId;
  if (profileEmpty) {
    return {
      ok: false,
      code: "onboarding_required",
      message: `Business profile for "${biz?.name ?? "this account"}" is empty. no address, no tax ID. An invoice created right now would have placeholders on it.`,
      hint: "Before creating any invoice, call update_business_profile with the user's real details: (a) business name, (b) address + country, (c) default currency, (d) tax ID if they have one. Ask the user for values you don't know. Do NOT invent them.",
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
          eq(invoices.ownerUserId, ctx.userId),
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

  // Bank-account resolution. The user might want to receive payments via
  // bank, crypto wallet, or both. We gate on bank here only when the user
  // explicitly hasn't supplied a picker AND the business has no default —
  // in that case we return a structured prompt asking Claude to ask the
  // user which account to use.
  const allAccounts = await listBankAccounts(ctx.businessId);
  let resolvedBankAccountIds: string[] | null = null;
  if (input.acceptedBankAccountIds !== undefined) {
    // Validate the caller-supplied ids belong to this business + are active.
    const ownedIds = new Set(allAccounts.map((a) => a.id));
    const unknown = input.acceptedBankAccountIds.filter((id) => !ownedIds.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: "invalid_bank_account",
        message: `Bank account id(s) not found on this business: ${unknown.join(", ")}`,
        hint: "Call list_bank_accounts to see valid ids. Removed/soft-deleted accounts also fail this check.",
      };
    }
    resolvedBankAccountIds = input.acceptedBankAccountIds;

    // Auto-set default when the merchant explicitly picks exactly one
    // account AND no default is set yet. Avoids re-prompting next time.
    if (resolvedBankAccountIds.length === 1) {
      const currentDefault = await getDefaultBankAccount(ctx.businessId);
      if (!currentDefault) {
        await setDefaultBankAccount(ctx.businessId, resolvedBankAccountIds[0]!);
      }
    }
  } else {
    // No picker supplied — fall back to the default. If there's no default
    // AND the business has multiple accounts, ask the user.
    const def = await getDefaultBankAccount(ctx.businessId);
    if (!def && allAccounts.length > 1) {
      return {
        ok: false,
        code: "bank_account_required",
        message: "This business has multiple bank accounts and no default is set. Ask the user which account(s) to put on this invoice, then retry with `accepted_bank_account_ids`.",
        hint: "Pass a list of bank_account ids — usually one — on the next create_invoice call. The first single-id pick is auto-promoted to default so this only happens once.",
        bank_accounts: allAccounts.map((a) => ({
          id: a.id,
          label: a.label,
          bank_name: a.bankName,
          account_number: a.accountNumber,
          currency: a.currency,
          is_default: a.isDefault,
        })),
      };
    }
    // Implicit pick: default account (if any). Stored as null on the row
    // (which means "use default at render time") rather than [def.id] so
    // changing the default later updates outstanding drafts in place.
    resolvedBankAccountIds = null;
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

  const currencyRaw = input.currency ?? client.defaultCurrency;
  if (!currencyRaw) {
    return {
      ok: false,
      code: "currency_required",
      message: "No currency was provided on the invoice and the client has no default_currency set.",
      hint: "Ask the user which currency this invoice should be billed in (e.g. USD, INR, EUR). Persist it on the client via update_client (default_currency) so future invoices for this client inherit it, then retry create_invoice with currency. Remind the user that USDC / wallet payments only work on USD invoices.",
    };
  }
  const currency = currencyRaw.toUpperCase();
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

  // Resolve attachments up front so any upload failure aborts before we
  // allocate an invoice number or write anything.
  const resolvedPerLine: LineItemAttachment[][] = [];
  for (const li of input.lineItems) {
    const r = await resolveAttachments(ctx, li.attachments);
    if (!r.ok) {
      return {
        ok: false,
        code: r.error.code,
        message: r.error.message,
        hint: r.error.hint,
      };
    }
    resolvedPerLine.push(r.attachments);
  }

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
    note: string | null;
    attachments: LineItemAttachment[];
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
        note: li.note?.trim() || null,
        attachments: resolvedPerLine[idx]!,
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
      ownerUserId: ctx.userId,
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
      acceptedPaymentMethods: input.acceptedPaymentMethods ?? null,
      acceptedBankAccountIds: resolvedBankAccountIds,
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
      note: l.note,
      attachments: l.attachments,
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
  ctx: ScopedCtx,
  invoiceId: string,
): Promise<InvoiceWithLineItems | null> {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.ownerUserId, ctx.userId),
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
  /** Filter to a specific business. Omit to list across every business
   *  the user owns — useful for "show me everything I billed last month". */
  businessId?: string;
  clientId?: string;
  status?: "draft" | "sent" | "paid" | "void" | "overdue";
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
};

export async function listInvoices(
  ctx: EnwiseCtx,
  opts: ListInvoicesOpts = {},
): Promise<Invoice[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const conditions = [
    eq(invoices.ownerUserId, ctx.userId),
    isNull(invoices.deletedAt),
  ];
  if (opts.businessId) conditions.push(eq(invoices.businessId, opts.businessId));
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
  ctx: ScopedCtx,
  invoiceNumber: string,
): Promise<Invoice | null> {
  // The unique index is (business_id, invoice_number), so the same
  // invoice_number can legitimately exist in two businesses owned by
  // the same user. Scope by businessId so the caller's business_id arg
  // is honored deterministically.
  const [row] = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.ownerUserId, ctx.userId),
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
  /** Move the invoice to render under a different business. Drafts only. */
  businessId?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string | null;
  terms?: string | null;
  /** Per-invoice atomic field overrides. See lib/invoices/displayResolver.ts.
   *  Pass `null` to clear all overrides on this invoice. */
  displayOverrides?: unknown;
  /** Payment-rail gate. NULL = show everything configured (default). */
  acceptedPaymentMethods?: string[] | null;
  /** Per-invoice bank-account picker (only valid on drafts, like the rest
   *  of this patch). See CreateInvoiceInput.acceptedBankAccountIds for the
   *  semantics of null vs [] vs [id, ...]. */
  acceptedBankAccountIds?: string[] | null;
};

export type MutateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code:
        | "not_found"
        | "invoice_not_draft"
        | "client_not_found"
        | "business_not_found";
      message: string;
    };

/**
 * Line-item mutations can additionally fail with attachment errors (when a
 * user-supplied image can't be uploaded). Used by addLineItem / updateLineItem.
 */
export type LineItemMutateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code:
        | "not_found"
        | "invoice_not_draft"
        | "client_not_found"
        | "attachment_too_large"
        | "attachment_invalid_mime"
        | "attachment_storage_unavailable";
      message: string;
      hint?: string;
    };

export async function updateInvoice(
  ctx: ScopedCtx,
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
  // Moving to a different business: validate ownership, then re-allocate
  // the invoice number under the destination (numbering is per-business).
  let newInvoiceNumber: string | null = null;
  if (patch.businessId && patch.businessId !== inv.businessId) {
    const [target] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(
        and(
          eq(businesses.id, patch.businessId),
          eq(businesses.ownerUserId, ctx.userId),
        ),
      );
    if (!target) {
      return {
        ok: false,
        code: "business_not_found",
        message: `No business with id ${patch.businessId} on this account.`,
      };
    }
    const allocation = await allocateInvoiceNumber({
      ...ctx,
      businessId: patch.businessId,
    });
    if (!allocation) {
      return {
        ok: false,
        code: "business_not_found",
        message: "Couldn't allocate an invoice number under the target business.",
      };
    }
    newInvoiceNumber = allocation.invoiceNumber;
  }

  const values: Partial<Invoice> = { updatedAt: new Date() };
  if (patch.clientId !== undefined) values.clientId = patch.clientId;
  if (patch.businessId !== undefined && patch.businessId !== inv.businessId) {
    values.businessId = patch.businessId;
    if (newInvoiceNumber) values.invoiceNumber = newInvoiceNumber;
  }
  if (patch.issueDate !== undefined) values.issueDate = patch.issueDate;
  if (patch.dueDate !== undefined) values.dueDate = patch.dueDate;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.terms !== undefined) values.terms = patch.terms;
  if (patch.displayOverrides !== undefined) {
    values.displayOverrides = patch.displayOverrides;
  }
  if (patch.acceptedPaymentMethods !== undefined) {
    values.acceptedPaymentMethods = patch.acceptedPaymentMethods;
  }
  if (patch.acceptedBankAccountIds !== undefined) {
    // Validate against the destination business's accounts (handles the
    // case where the invoice is being moved AND the picker is being set
    // in the same call).
    const targetBusinessId = (patch.businessId ?? inv.businessId);
    if (patch.acceptedBankAccountIds !== null && patch.acceptedBankAccountIds.length > 0) {
      const owned = await listBankAccounts(targetBusinessId);
      const ownedIds = new Set(owned.map((a) => a.id));
      const unknown = patch.acceptedBankAccountIds.filter((id) => !ownedIds.has(id));
      if (unknown.length > 0) {
        return {
          ok: false,
          code: "client_not_found",
          message: `Bank account id(s) not on this business: ${unknown.join(", ")}`,
        };
      }
      if (patch.acceptedBankAccountIds.length === 1) {
        const current = await getDefaultBankAccount(targetBusinessId);
        if (!current) {
          await setDefaultBankAccount(targetBusinessId, patch.acceptedBankAccountIds[0]!);
        }
      }
    }
    values.acceptedBankAccountIds = patch.acceptedBankAccountIds;
  }

  await db.update(invoices).set(values).where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "updated", ctx.tokenId, {
    business_changed: patch.businessId !== undefined && patch.businessId !== inv.businessId,
  });
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
  ctx: ScopedCtx,
  invoiceId: string,
  item: LineItemInput,
): Promise<LineItemMutateResult<InvoiceWithLineItems>> {
  const inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (!isEditable(inv)) {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is ${inv.status}; only drafts are editable.`,
    };
  }
  const att = await resolveAttachments(ctx, item.attachments);
  if (!att.ok) {
    return {
      ok: false,
      code: att.error.code,
      message: att.error.message,
      hint: att.error.hint,
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
    note: item.note?.trim() || null,
    attachments: att.attachments,
    ...math,
  });
  await withRecomputedTotals(inv.id);
  await writeEvent(inv.id, "updated", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

export async function updateLineItem(
  ctx: ScopedCtx,
  invoiceId: string,
  lineItemId: string,
  patch: Partial<LineItemInput>,
): Promise<LineItemMutateResult<InvoiceWithLineItems>> {
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

  let nextAttachments: LineItemAttachment[];
  if (patch.attachments !== undefined) {
    const att = await resolveAttachments(ctx, patch.attachments);
    if (!att.ok) {
      return {
        ok: false,
        code: att.error.code,
        message: att.error.message,
        hint: att.error.hint,
      };
    }
    nextAttachments = att.attachments;
  } else {
    nextAttachments = existing.attachments as LineItemAttachment[];
  }
  const next = {
    description: patch.description ?? existing.description,
    quantity: patch.quantity ?? existing.quantity,
    unitPrice: patch.unitPrice ?? existing.unitPrice,
    taxRate: patch.taxRate ?? existing.taxRate,
    productId: patch.productId !== undefined ? patch.productId ?? null : existing.productId,
    note:
      patch.note !== undefined ? (patch.note?.trim() || null) : existing.note,
    attachments: nextAttachments,
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
  ctx: ScopedCtx,
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
  ctx: ScopedCtx,
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
  if (inv.status === "paid") {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is already paid; re-finalizing would flip its status back to sent.`,
    };
  }

  // Re-send: already finalized, just bump sent_at. Snapshots are preserved.
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
  // Snapshot from the invoice's own businessId, not the caller's ctx —
  // an invoice can be moved between businesses while still in draft, and
  // finalize must capture the business it's actually rendered under at
  // send time.
  const bizRows = await db.execute(sql`
    select name, legal_name, tax_id, contact_name,
           evm_wallet_address, starknet_wallet_address, aptos_wallet_address,
           logo_url, address_line1, address_line2, city, region, postal_code, country
    from businesses where id = ${inv.businessId}
  `);
  const biz = bizRows.rows[0] as
    | {
        name: string;
        legal_name: string | null;
        tax_id: string | null;
        contact_name: string | null;
        evm_wallet_address: string | null;
        starknet_wallet_address: string | null;
        aptos_wallet_address: string | null;
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
      clientContactNameSnapshot: client.contactName,
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
      businessLegalNameSnapshot: biz.legal_name,
      businessTaxIdSnapshot: biz.tax_id,
      businessContactNameSnapshot: biz.contact_name,
      businessEvmWalletAddressSnapshot: biz.evm_wallet_address,
      businessStarknetWalletAddressSnapshot: biz.starknet_wallet_address,
      businessAptosWalletAddressSnapshot: biz.aptos_wallet_address,
      businessLogoUrlSnapshot: biz.logo_url,
      businessAddressSnapshot: {
        line1: biz.address_line1,
        line2: biz.address_line2,
        city: biz.city,
        region: biz.region,
        postal_code: biz.postal_code,
        country: biz.country,
      },
      businessBankAccountsSnapshot: await buildBankAccountsSnapshot(
        inv.businessId,
        inv.acceptedBankAccountIds ?? null,
      ),
    })
    .where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, "sent", ctx.tokenId);
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

/** Resolve which accounts to freeze on the invoice snapshot at finalize.
 *  Reads from business_bank_accounts using the same rules the share page
 *  uses to render live drafts. Returns null when no accounts apply (so the
 *  jsonb column stays null and renderers skip the bank panel). */
async function buildBankAccountsSnapshot(
  businessId: string,
  acceptedBankAccountIds: string[] | null,
): Promise<ReturnType<typeof toSnapshotShape>[] | null> {
  const resolved = await resolveInvoiceBankAccounts(
    businessId,
    acceptedBankAccountIds,
  );
  if (resolved.length === 0) return null;
  return resolved.map(toSnapshotShape);
}

// ---------- Status transitions ----------

export async function markInvoicePaid(
  ctx: ScopedCtx,
  invoiceId: string,
  opts: { amount?: string; paidAt?: string } = {},
): Promise<MutateResult<InvoiceWithLineItems>> {
  let inv = await getInvoice(ctx, invoiceId);
  if (!inv) return { ok: false, code: "not_found", message: `No invoice with id ${invoiceId}.` };
  if (inv.status === "void") {
    return {
      ok: false,
      code: "invoice_not_draft",
      message: `Invoice ${inv.invoiceNumber} is void and cannot be marked paid.`,
    };
  }
  // Drafts must be snapshotted before they can be marked paid, otherwise
  // future renders read live (mutable) business/client rows and the audit
  // trail is broken. Auto-finalize so the caller doesn't need a two-step
  // dance for "I delivered + got paid out-of-band".
  if (inv.status === "draft") {
    const finalized = await finalizeInvoice(ctx, invoiceId);
    if (!finalized.ok) return finalized;
    inv = finalized.value;
  }

  // ACCUMULATE: each call adds to amountPaid (matches the tool description's
  // "supports partial payments"). Pass no `amount` to mark fully paid by
  // applying the remaining balance.
  const remaining = addAmounts(inv.total, `-${inv.amountPaid}`);
  const delta = opts.amount ?? remaining;
  const newAmountPaid = addAmounts(inv.amountPaid, delta);
  // Status flips to paid only once the total is covered. Otherwise the
  // invoice stays "sent" with a partial amountPaid recorded.
  const fullyPaid =
    Number(addAmounts(inv.total, `-${newAmountPaid}`)) <= 0;
  const paidAt = opts.paidAt ? new Date(opts.paidAt) : new Date();
  await db
    .update(invoices)
    .set({
      status: fullyPaid ? "paid" : inv.status,
      amountPaid: newAmountPaid,
      paidAt: fullyPaid ? paidAt : inv.paidAt,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, inv.id));
  await writeEvent(inv.id, fullyPaid ? "paid" : "partial_paid", ctx.tokenId, {
    delta,
    amount_paid: newAmountPaid,
  });
  return { ok: true, value: (await getInvoice(ctx, inv.id))! };
}

// ---------- Onchain payments (no ScopedCtx) ----------
//
// recordOnchainPayment is the entry point for chain-verified payments
// (direct ERC-20 transfers from a payer's wallet to the merchant's wallet).
// The chain itself is the authority — anyone who can submit a (chainId, txHash)
// pair we've already verified gets the invoice marked paid. Idempotent on
// (chainId, txHash): re-submitting the same tx returns the existing record.

export type RecordOnchainPaymentInput = {
  invoiceId: string;
  chainId: number;
  txHash: string;
  paymentMethod: "direct_transfer" | "manual";
  payerAddress: string | null;
  amount: string;
  currency: string;
  paidAt: Date;
};

export type RecordOnchainPaymentResult = {
  alreadyRecorded: boolean;
  payment: InvoicePayment;
  invoiceStatus: "sent" | "paid";
};

export async function recordOnchainPayment(
  input: RecordOnchainPaymentInput,
): Promise<RecordOnchainPaymentResult> {
  // Single-roundtrip idempotent insert. The unique index on (chain_id, tx_hash)
  // means a concurrent second call hits the conflict path; we then re-SELECT
  // the row inserted by the winning call and report alreadyRecorded.
  const [inserted] = await db
    .insert(invoicePayments)
    .values({
      invoiceId: input.invoiceId,
      chainId: input.chainId,
      txHash: input.txHash,
      paymentMethod: input.paymentMethod,
      payerAddress: input.payerAddress,
      amount: input.amount,
      currency: input.currency,
      paidAt: input.paidAt,
    })
    .onConflictDoNothing({
      target: [invoicePayments.chainId, invoicePayments.txHash],
    })
    .returning();

  if (!inserted) {
    // Another caller won the race. Look up the row they inserted and
    // return the same shape as the steady-state idempotent retry path.
    const [existing] = await db
      .select()
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.chainId, input.chainId),
          eq(invoicePayments.txHash, input.txHash),
        ),
      );
    if (!existing) {
      throw new Error(
        "Concurrent invoice_payment insert vanished after ON CONFLICT.",
      );
    }
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, existing.invoiceId));
    return {
      alreadyRecorded: true,
      payment: existing,
      invoiceStatus: inv?.status === "paid" ? "paid" : "sent",
    };
  }

  const [inv] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId));
  if (!inv) throw new Error(`Invoice ${input.invoiceId} missing.`);

  const newAmountPaid = addAmounts(inv.amountPaid, input.amount);
  const fullyPaid = Number(addAmounts(inv.total, `-${newAmountPaid}`)) <= 0;

  await db
    .update(invoices)
    .set({
      status: fullyPaid ? "paid" : inv.status,
      amountPaid: newAmountPaid,
      paidAt: fullyPaid ? input.paidAt : inv.paidAt,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, inv.id));

  await db.insert(invoiceEvents).values({
    invoiceId: inv.id,
    eventType: fullyPaid ? "paid" : "partial_paid",
    actor: "chain",
    metadata: {
      payment_id: inserted.id,
      chain_id: input.chainId,
      tx_hash: input.txHash,
      method: input.paymentMethod,
      amount: input.amount,
    },
  });

  return {
    alreadyRecorded: false,
    payment: inserted,
    invoiceStatus: fullyPaid ? "paid" : "sent",
  };
}

/**
 * Undo a first-time finalize. Used by sendInvoiceByEmail when Resend rejects
 * the message so the invoice doesn't get stuck in a "sent but not actually
 * sent" limbo. Only reverts rows that this process flipped within the
 * current call. callers must know `wasDraft` beforehand.
 */
export async function revertFinalizeInvoice(
  ctx: ScopedCtx,
  invoiceId: string,
): Promise<void> {
  await db
    .update(invoices)
    .set({
      status: "draft",
      sentAt: null,
      clientNameSnapshot: null,
      clientContactNameSnapshot: null,
      clientEmailSnapshot: null,
      clientAddressSnapshot: null,
      businessNameSnapshot: null,
      businessLegalNameSnapshot: null,
      businessTaxIdSnapshot: null,
      businessContactNameSnapshot: null,
      businessEvmWalletAddressSnapshot: null,
      businessStarknetWalletAddressSnapshot: null,
      businessAptosWalletAddressSnapshot: null,
      businessAddressSnapshot: null,
      businessLogoUrlSnapshot: null,
      businessBankAccountsSnapshot: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.ownerUserId, ctx.userId)),
    );
}

export async function voidInvoice(
  ctx: ScopedCtx,
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
  ctx: ScopedCtx,
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
  ctx: ScopedCtx,
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
  ctx: ScopedCtx,
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
      note: l.note,
      attachments: l.attachments as LineItemAttachment[],
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
  const nonUsd = inv.currency.toUpperCase() !== "USD";
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    status: inv.status,
    client_id: inv.clientId,
    issue_date: inv.issueDate,
    due_date: inv.dueDate,
    currency: inv.currency,
    ...(nonUsd && {
      payment_rails_note: `Invoice is in ${inv.currency.toUpperCase()}, not USD. USDC / wallet payments are only enabled on USD invoices. The share page will show bank transfer details only. Surface this to the user so they can decide whether to re-issue in USD if they want crypto payment.`,
    }),
    subtotal: inv.subtotal,
    tax_total: inv.taxTotal,
    total: inv.total,
    amount_paid: inv.amountPaid,
    outstanding: addAmounts(inv.total, `-${inv.amountPaid}`),
    notes: inv.notes,
    terms: inv.terms,
    // Full URL. never expose the bare slug. Models will guess the
    // domain ("envoice.app" vs "enwise.app") if they see only a slug
    // without a domain in context.
    share_url: invoiceShareUrl(inv.shareSlug),
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
      note: l.note,
      attachments: l.attachments,
    })),
  };
}

export function formatInvoiceSummaryForMcp(inv: Invoice) {
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    status: inv.status,
    business_id: inv.businessId,
    client_id: inv.clientId,
    issue_date: inv.issueDate,
    due_date: inv.dueDate,
    currency: inv.currency,
    total: inv.total,
    amount_paid: inv.amountPaid,
    outstanding: addAmounts(inv.total, `-${inv.amountPaid}`),
    // Full URL. never expose the bare slug. Models will guess the
    // domain if they see only a slug without a domain in context.
    share_url: invoiceShareUrl(inv.shareSlug),
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
