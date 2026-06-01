import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, invoices } from "@/lib/db/schema";
import type { ScopedCtx } from "@/lib/mcp/context";

/** Zero-pad width for the numeric part of an invoice number. */
const PAD = 4;

export interface AllocatedNumber {
  invoiceNumber: string;
  businessSnapshot: {
    name: string;
    slug: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    logoUrl: string | null;
    taxId: string | null;
    legalName: string | null;
  };
}

/** Format a numeric value into a full invoice number, e.g. (INV-, 13) -> "INV-0013". */
export function formatInvoiceNumber(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(PAD, "0")}`;
}

/**
 * Parse a user/Claude-supplied desired invoice number against a business's
 * prefix. Accepts either the bare digits ("2", "0002") or the full form
 * ("INV-0002"). Returns the integer value, or a typed failure.
 */
export function parseDesiredInvoiceNumber(
  raw: string,
  prefix: string,
):
  | { ok: true; n: number }
  | { ok: false; reason: "format" | "range" } {
  const input = raw.trim();
  let digits: string | null = null;
  if (/^\d+$/.test(input)) {
    digits = input;
  } else if (prefix && input.startsWith(prefix) && /^\d+$/.test(input.slice(prefix.length))) {
    digits = input.slice(prefix.length);
  }
  if (digits === null) return { ok: false, reason: "format" };
  const n = parseInt(digits, 10);
  // 1..1_000_000 keeps the allocated counter sane; padStart handles any width.
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return { ok: false, reason: "range" };
  return { ok: true, n };
}

type AllocationRow = {
  prefix: string;
  allocated: number;
  name: string;
  slug: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  logo_url: string | null;
  tax_id: string | null;
  legal_name: string | null;
};

function rowToAllocated(row: AllocationRow): AllocatedNumber {
  return {
    invoiceNumber: formatInvoiceNumber(row.prefix, row.allocated),
    businessSnapshot: {
      name: row.name,
      slug: row.slug,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
      logoUrl: row.logo_url,
      taxId: row.tax_id,
      legalName: row.legal_name,
    },
  };
}

const RETURNING_SNAPSHOT = sql`
  invoice_number_prefix           as prefix,
  name                            as name,
  slug                            as slug,
  address_line1                   as address_line1,
  address_line2                   as address_line2,
  city                            as city,
  region                          as region,
  postal_code                     as postal_code,
  country                         as country,
  logo_url                        as logo_url,
  tax_id                          as tax_id,
  legal_name                      as legal_name
`;

/**
 * Atomically bump businesses.invoice_number_next and format the next
 * invoice number. Safe under concurrency. the row lock on the business
 * serializes concurrent allocations so each gets a distinct integer.
 *
 * Also returns the business snapshot fields needed to freeze on the invoice
 * row at creation time, so the caller doesn't have to re-fetch.
 */
export async function allocateInvoiceNumber(
  ctx: ScopedCtx,
): Promise<AllocatedNumber | null> {
  const result = await db.execute(sql`
    update businesses
    set invoice_number_next = invoice_number_next + 1,
        updated_at = now()
    where id = ${ctx.businessId}
    returning
      invoice_number_next - 1         as allocated,
      ${RETURNING_SNAPSHOT}
  `);
  const row = result.rows[0] as AllocationRow | undefined;
  if (!row) return null;
  return rowToAllocated(row);
}

/**
 * Claim a SPECIFIC invoice number for the scoped business, if it's available.
 *
 * "Available" = no other invoice in this business already uses that number.
 * Deleting an invoice (hard delete) frees its number, so a previously used
 * number becomes claimable again. Numbers above the current counter are also
 * claimable; when that happens the counter jumps past them so future auto
 * allocations don't collide.
 *
 * The whole check-and-claim is a single conditional UPDATE so it's atomic
 * against concurrent allocations. The (business_id, invoice_number) unique
 * index is the final backstop at insert time.
 *
 * `excludeInvoiceId` lets update_invoice renumber an invoice to a value while
 * ignoring that same invoice's current number.
 */
export async function claimInvoiceNumber(
  ctx: ScopedCtx,
  desired: number,
  opts: { excludeInvoiceId?: string } = {},
): Promise<
  | { ok: true; value: AllocatedNumber }
  | { ok: false; reason: "taken" | "business_missing" }
> {
  const exclude = opts.excludeInvoiceId ?? null;
  const result = await db.execute(sql`
    update businesses b
    set invoice_number_next = greatest(b.invoice_number_next, ${desired}::int + 1),
        updated_at = now()
    where b.id = ${ctx.businessId}
      and not exists (
        select 1 from invoices i
        where i.business_id = b.id
          and i.invoice_number = b.invoice_number_prefix || lpad(${desired}::text, ${PAD}, '0')
          and (${exclude}::uuid is null or i.id <> ${exclude}::uuid)
      )
    returning
      ${desired}::int                 as allocated,
      ${RETURNING_SNAPSHOT}
  `);
  const row = result.rows[0] as AllocationRow | undefined;
  if (!row) {
    const [biz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId));
    return { ok: false, reason: biz ? "taken" : "business_missing" };
  }
  return { ok: true, value: rowToAllocated(row) };
}

/**
 * Suggest invoice numbers that are currently free, for error messages when a
 * requested number is taken. Returns the next auto number plus any gaps below
 * the counter (e.g. holes left by deleted/voided invoices).
 */
export async function suggestAvailableNumbers(
  ctx: ScopedCtx,
  limit = 8,
): Promise<{ nextAuto: string; available: string[] }> {
  const [biz] = await db
    .select({
      prefix: businesses.invoiceNumberPrefix,
      next: businesses.invoiceNumberNext,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));
  if (!biz) return { nextAuto: "", available: [] };

  const rows = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.businessId, ctx.businessId));
  const used = new Set<number>();
  for (const r of rows) {
    const numStr = r.invoiceNumber.startsWith(biz.prefix)
      ? r.invoiceNumber.slice(biz.prefix.length)
      : r.invoiceNumber;
    const n = parseInt(numStr, 10);
    if (!Number.isNaN(n)) used.add(n);
  }

  const available: string[] = [];
  for (let n = 1; n < biz.next && available.length < limit; n++) {
    if (!used.has(n)) available.push(formatInvoiceNumber(biz.prefix, n));
  }
  return { nextAuto: formatInvoiceNumber(biz.prefix, biz.next), available };
}
