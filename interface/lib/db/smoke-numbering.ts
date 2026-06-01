/**
 * Smoke test for custom / reusable invoice numbers.
 *
 * - Inserts a throwaway user + business + client
 * - Drives createInvoice / updateInvoice / deleteInvoice directly through every
 *   numbering path: auto allocation, claiming a specific number, reusing a
 *   freed number, filling a gap, jumping ahead, taken-number rejection,
 *   invalid input, and renumber-on-update
 * - Deletes the throwaway records (cascades to business + invoices)
 *
 * Usage: npm run smoke:numbering
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { businesses, clients, users } from "./schema";
import { createInvoice, updateInvoice, deleteInvoice } from "@/lib/invoices";
import type { ScopedCtx } from "@/lib/mcp/context";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}  ${detail}`);
  }
}

async function main() {
  const stamp = Date.now();
  const [user] = await db
    .insert(users)
    .values({ email: `numsmoke+${stamp}@enwise.test`, name: "Num Smoke" })
    .returning();
  if (!user) throw new Error("failed to insert user");
  const [biz] = await db
    .insert(businesses)
    .values({
      ownerUserId: user.id,
      name: "Num Smoke Co",
      slug: `numsmoke-${stamp}`,
      addressLine1: "1 Test St",
      country: "us",
    })
    .returning();
  if (!biz) throw new Error("failed to insert business");
  const [client] = await db
    .insert(clients)
    .values({ ownerUserId: user.id, name: "Test Client", defaultCurrency: "USD" })
    .returning();
  if (!client) throw new Error("failed to insert client");

  const ctx: ScopedCtx = {
    userId: user.id,
    tokenId: "smoke-token-0000",
    businessId: biz.id,
  };
  const lineItems = [
    { description: "Service", quantity: "1", unitPrice: "100", taxRate: "0" },
  ];
  const mk = (invoiceNumber?: string) =>
    createInvoice(ctx, {
      clientId: client.id,
      currency: "USD",
      lineItems,
      ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
    });

  try {
    const a = await mk();
    check("auto #1 = INV-0001", a.ok && a.invoice.invoiceNumber === "INV-0001", a.ok ? a.invoice.invoiceNumber : a.code);
    const b = await mk();
    check("auto #2 = INV-0002", b.ok && b.invoice.invoiceNumber === "INV-0002", b.ok ? b.invoice.invoiceNumber : b.code);
    const c = await mk();
    check("auto #3 = INV-0003", c.ok && c.invoice.invoiceNumber === "INV-0003", c.ok ? c.invoice.invoiceNumber : c.code);

    const dup = await mk("0003");
    check("claim taken 0003 -> duplicate_invoice_number", !dup.ok && dup.code === "duplicate_invoice_number", JSON.stringify(dup));
    // No gaps yet (1,2,3 sequential), so available_numbers is correctly empty.
    check("duplicate error carries available_numbers array", !dup.ok && Array.isArray(dup.available_numbers), !dup.ok ? JSON.stringify(dup) : "");

    if (b.ok) {
      const del = await deleteInvoice(ctx, b.invoice.id);
      check("delete INV-0002 frees it", del.ok && del.value.invoice_number === "INV-0002", JSON.stringify(del));
    }
    // Now there's a gap at 0002. A taken-number error should suggest it.
    const dupGap = await mk("3");
    check("duplicate error suggests the freed gap INV-0002", !dupGap.ok && dupGap.code === "duplicate_invoice_number" && (dupGap.available_numbers ?? []).includes("INV-0002"), !dupGap.ok ? JSON.stringify(dupGap.available_numbers) : "");

    const reuse = await mk("2");
    check("reuse freed 0002 via bare digits", reuse.ok && reuse.invoice.invoiceNumber === "INV-0002", reuse.ok ? reuse.invoice.invoiceNumber : reuse.code);

    const jump = await mk("0010");
    check("jump ahead to 0010", jump.ok && jump.invoice.invoiceNumber === "INV-0010", jump.ok ? jump.invoice.invoiceNumber : jump.code);
    const afterJump = await mk();
    check("auto after jump = INV-0011", afterJump.ok && afterJump.invoice.invoiceNumber === "INV-0011", afterJump.ok ? afterJump.invoice.invoiceNumber : afterJump.code);

    const full = await mk("INV-0050");
    check("full-form INV-0050 accepted", full.ok && full.invoice.invoiceNumber === "INV-0050", full.ok ? full.invoice.invoiceNumber : full.code);

    const bad = await mk("abc");
    check("invalid 'abc' -> invalid_invoice_number", !bad.ok && bad.code === "invalid_invoice_number", JSON.stringify(bad));
    const zero = await mk("0");
    check("range '0' -> invalid_invoice_number", !zero.ok && zero.code === "invalid_invoice_number", JSON.stringify(zero));

    // Used so far: 1, 3, 2, 10, 11, 50. Free gaps below 50 include 5.
    if (afterJump.ok) {
      const ren = await updateInvoice(ctx, afterJump.invoice.id, { invoiceNumber: "5" });
      check("renumber INV-0011 -> free 0005", ren.ok && ren.value.invoiceNumber === "INV-0005", ren.ok ? ren.value.invoiceNumber : ren.code);
    }
    if (c.ok) {
      const renDup = await updateInvoice(ctx, c.invoice.id, { invoiceNumber: "1" });
      check("renumber to taken 0001 -> duplicate", !renDup.ok && renDup.code === "duplicate_invoice_number", JSON.stringify(renDup));
    }
    if (a.ok) {
      const same = await updateInvoice(ctx, a.invoice.id, { invoiceNumber: "INV-0001" });
      check("renumber to same number is a no-op ok", same.ok && same.value.invoiceNumber === "INV-0001", same.ok ? same.value.invoiceNumber : same.code);
    }
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    console.log("cleaned up throwaway user/business/invoices");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
