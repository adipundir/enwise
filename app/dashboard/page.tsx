import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, invoices } from "@/lib/db/schema";
import { auth } from "@/auth";
import { invoiceShareUrl } from "@/lib/invoices";
import { formatMoney, addAmounts } from "@/lib/money";
import { createToken, getActiveToken } from "@/lib/tokens";
import { KeyAndConnectSection } from "./KeyAndConnectSection";

export default async function DashboardHome() {
  const session = await auth();
  const user = session?.user as
    | { id?: string; defaultBusinessId?: string | null }
    | undefined;
  const businessId = user?.defaultBusinessId;

  const [business] = businessId
    ? await db.select().from(businesses).where(eq(businesses.id, businessId))
    : [];

  // One key per user. Mint on first visit and reveal the raw once. After
  // that the raw is unrecoverable; the user must rotate to mint a new one.
  let bootstrapRawToken: string | null = null;
  let currentPrefix: string | null = null;
  if (businessId && user?.id) {
    const active = await getActiveToken(businessId);
    if (!active) {
      const created = await createToken({
        businessId,
        createdByUserId: user.id,
        name: "Default",
      });
      bootstrapRawToken = created.raw;
      currentPrefix = created.token.tokenPrefix;
    } else {
      currentPrefix = active.tokenPrefix;
    }
  }

  const [clientCount, allInvoices, recentInvoices] = businessId
    ? await Promise.all([
        db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.businessId, businessId), isNull(clients.archivedAt))),
        db
          .select({
            status: invoices.status,
            total: invoices.total,
            amountPaid: invoices.amountPaid,
            currency: invoices.currency,
          })
          .from(invoices)
          .where(and(eq(invoices.businessId, businessId), isNull(invoices.deletedAt))),
        db
          .select()
          .from(invoices)
          .where(and(eq(invoices.businessId, businessId), isNull(invoices.deletedAt)))
          .orderBy(desc(invoices.createdAt))
          .limit(5),
      ])
    : [[], [], []];

  const outstandingByCurrency = aggregateOutstanding(allInvoices);
  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000";
  const mcpUrl = `${baseUrl}/api/mcp`;

  return (
    <div className="space-y-12">
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Overview
        </div>
        <h1 className="display text-3xl leading-tight sm:text-4xl text-zinc-100">
          Welcome
          {session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Business profile:{" "}
          <span className="text-zinc-200">
            {business?.name ?? "(setting up…)"}
          </span>
          . Everything else happens in Claude once your key is plugged in.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-px bg-zinc-900 sm:grid-cols-4">
        <Stat label="Clients" value={String(clientCount.length)} />
        <Stat label="Invoices" value={String(allInvoices.length)} />
        <Stat
          label="Outstanding"
          value={
            outstandingByCurrency.length === 0
              ? "—"
              : outstandingByCurrency
                  .map((b) => formatMoney(b.outstanding, b.currency))
                  .join(" · ")
          }
          small={outstandingByCurrency.length > 1}
        />
        <Stat
          label="Default currency"
          value={business?.defaultCurrency ?? "—"}
        />
      </section>

      <KeyAndConnectSection
        initialRawToken={bootstrapRawToken}
        currentPrefix={currentPrefix}
        mcpUrl={mcpUrl}
      />

      {recentInvoices.length > 0 ? (
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-base font-semibold tracking-tight text-zinc-100">
              Recent invoices
            </h2>
            <span className="text-xs text-zinc-600">
              {recentInvoices.length} of {allInvoices.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-900">
            {recentInvoices.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center gap-4 border-b border-zinc-900 bg-[#0a0a0a] px-5 py-4 last:border-b-0"
              >
                <div className="font-mono text-sm text-zinc-100 min-w-[90px]">
                  {inv.invoiceNumber}
                </div>
                <StatusChip status={inv.status} />
                <div className="flex-1 text-sm text-zinc-300">
                  {formatMoney(inv.total, inv.currency)}
                </div>
                <div className="text-xs text-zinc-500">Due {inv.dueDate}</div>
                <Link
                  href={invoiceShareUrl(inv.shareSlug)}
                  target="_blank"
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                >
                  Share link →
                </Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function aggregateOutstanding(
  invs: Array<{
    status: "draft" | "sent" | "paid" | "void";
    total: string;
    amountPaid: string;
    currency: string;
  }>,
): Array<{ currency: string; outstanding: string }> {
  const byCurrency = new Map<string, string>();
  for (const inv of invs) {
    if (inv.status !== "sent") continue;
    const open = addAmounts(inv.total, `-${inv.amountPaid}`);
    const current = byCurrency.get(inv.currency) ?? "0";
    byCurrency.set(inv.currency, addAmounts(current, open));
  }
  return Array.from(byCurrency, ([currency, outstanding]) => ({
    currency,
    outstanding,
  })).filter((b) => Number(b.outstanding) !== 0);
}

function Stat({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="bg-[#0a0a0a] px-5 py-6">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-2 font-semibold text-zinc-100 tracking-tight ${small ? "text-base" : "text-2xl"}`}
      >
        {value}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "border-zinc-700 text-zinc-400",
    sent: "border-blue-900/60 text-blue-300",
    paid: "border-emerald-900/60 text-emerald-300",
    void: "border-zinc-800 text-zinc-500",
  };
  return (
    <span
      className={`rounded-full border bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-widest ${styles[status] ?? "border-zinc-700 text-zinc-400"}`}
    >
      {status}
    </span>
  );
}
