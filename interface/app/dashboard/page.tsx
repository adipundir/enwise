import Link from "next/link";
import { cookies } from "next/headers";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, invoices } from "@/lib/db/schema";
import { auth } from "@/auth";
import { invoiceShareUrl } from "@/lib/invoices";
import { formatMoney, addAmounts } from "@/lib/money";
import {
  createToken,
  getActiveToken,
  isEncryptionConfigured,
  revokeToken,
} from "@/lib/tokens";
import { SetupSection } from "./SetupSection";
import { OutstandingStat, OUTSTANDING_HIDDEN_COOKIE } from "./OutstandingStat";
import { CopyLinkButton } from "./CopyLinkButton";

// Stats depend on fresh DB state that changes via MCP tool calls outside
// of this route's request context. Force dynamic so every page hit
// re-queries rather than serving a cached render.
export const dynamic = "force-dynamic";

const RECENT_PAGE_SIZE = 20;

export default async function DashboardHome({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await auth();
  const cookieStore = await cookies();
  const outstandingHidden =
    cookieStore.get(OUTSTANDING_HIDDEN_COOKIE)?.value === "1";

  const sp = await searchParams;
  const requestedPage = Math.max(1, Number(sp.page) || 1);
  const user = session?.user as
    | { id?: string; defaultBusinessId?: string | null }
    | undefined;
  const userId = user?.id;

  // createToken runs in auth.ts on signup, so any user reaching this page
  // should already have an encrypted token. The lazy create below stays as
  // a defensive fallback for two cases:
  //   - No active token at all (signup hook misfired).
  //   - An active token exists but its ciphertext is null, so getActiveToken
  //     can't return a displayable raw value. This happens for tokens minted
  //     before TOKEN_ENC_KEY was configured (or while it was misconfigured).
  //     Those users can never copy their key, so mint a fresh encrypted one
  //     and revoke the stale row. Guard the re-mint on isEncryptionConfigured:
  //     if the key is still absent the new token would also be undisplayable,
  //     and we'd churn a fresh token on every dashboard load.
  let bootstrapRawToken: string | null = null;
  if (userId) {
    const active = await getActiveToken(userId);
    const needsRotate =
      !active || (active.rawToken === null && isEncryptionConfigured());
    if (needsRotate) {
      if (active) {
        await revokeToken({ userId, tokenId: active.tokenId });
      }
      const created = await createToken({
        createdByUserId: userId,
        name: "Default",
      });
      bootstrapRawToken = created.raw;
    } else {
      bootstrapRawToken = active.rawToken;
    }
  }

  // All businesses this user owns. The dashboard only renders the name
  // and uses the row count for the Businesses stat; avoid pulling the
  // whole row (address columns, logo URL, wallet address, etc.).
  const allBusinesses = userId
    ? await db
        .select({ id: businesses.id, name: businesses.name })
        .from(businesses)
        .where(eq(businesses.ownerUserId, userId))
        .orderBy(asc(businesses.createdAt))
    : [];
  const [clientCount, allInvoices, recentInvoices] = userId
    ? await Promise.all([
        db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.ownerUserId, userId), isNull(clients.archivedAt))),
        db
          .select({
            status: invoices.status,
            total: invoices.total,
            amountPaid: invoices.amountPaid,
            currency: invoices.currency,
          })
          .from(invoices)
          .where(and(eq(invoices.ownerUserId, userId), isNull(invoices.deletedAt))),
        // Recent invoices: explicit projection — the dashboard row only
        // renders these eight fields. `select()` would pull every column
        // including the bank-account snapshot jsonb (potentially several
        // KB per row) on every dashboard load.
        db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            status: invoices.status,
            total: invoices.total,
            currency: invoices.currency,
            shareSlug: invoices.shareSlug,
            clientNameSnapshot: invoices.clientNameSnapshot,
            businessId: invoices.businessId,
          })
          .from(invoices)
          .where(and(eq(invoices.ownerUserId, userId), isNull(invoices.deletedAt)))
          .orderBy(desc(invoices.createdAt))
          .limit(RECENT_PAGE_SIZE)
          .offset((requestedPage - 1) * RECENT_PAGE_SIZE),
      ])
    : [[], [], []];

  const totalActive = allInvoices.length;
  const totalPages = Math.max(1, Math.ceil(totalActive / RECENT_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rangeStart = totalActive === 0 ? 0 : (page - 1) * RECENT_PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * RECENT_PAGE_SIZE, totalActive);

  const outstandingByCurrency = aggregateOutstanding(allInvoices);
  const businessNameById = new Map(allBusinesses.map((b) => [b.id, b.name]));
  const showBusinessLabel = allBusinesses.length > 1;
  // Group recent invoices by business so multi-business owners see clean
  // per-entity stacks instead of an interleaved list. First-occurrence
  // wins for group order, preserving the underlying createdAt sort.
  const recentByBusiness: Array<{
    businessId: string;
    name: string;
    invoices: typeof recentInvoices;
  }> = [];
  if (showBusinessLabel) {
    const groupIndex = new Map<string, number>();
    for (const inv of recentInvoices) {
      const idx = groupIndex.get(inv.businessId);
      if (idx === undefined) {
        groupIndex.set(inv.businessId, recentByBusiness.length);
        recentByBusiness.push({
          businessId: inv.businessId,
          name: businessNameById.get(inv.businessId) ?? "—",
          invoices: [inv],
        });
      } else {
        recentByBusiness[idx]!.invoices.push(inv);
      }
    }
  }
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
          {allBusinesses.length === 0
            ? <>No business yet. Plug your key into Claude and ask it to <span className="text-zinc-200">create a business</span> — then you can start billing.</>
            : allBusinesses.length === 1
              ? <>Business: <span className="text-zinc-200">{allBusinesses[0]!.name}</span>. Everything else happens in Claude once your key is plugged in.</>
              : <>Billing from <span className="text-zinc-200">{allBusinesses.length} businesses</span>. Claude asks which one to use per invoice. Everything happens inside Claude once your key is plugged in.</>}
        </p>
      </section>

      <section className="grid grid-cols-2 gap-px bg-zinc-900 sm:grid-cols-4">
        <Stat label="Clients" value={String(clientCount.length)} />
        <Stat label="Invoices" value={String(allInvoices.length)} />
        <OutstandingStat
          value={
            outstandingByCurrency.length === 0
              ? "—"
              : outstandingByCurrency
                  .map((b) => formatMoney(b.outstanding, b.currency))
                  .join(" · ")
          }
          small={outstandingByCurrency.length > 1}
          initialHidden={outstandingHidden}
        />
        <Stat
          label="Businesses"
          value={String(allBusinesses.length)}
        />
      </section>

      <SetupSection
        initialRawToken={bootstrapRawToken}
        mcpUrl={mcpUrl}
        hasInvoices={allInvoices.length > 0}
      />

      {recentInvoices.length > 0 ? (
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-base font-semibold tracking-tight text-zinc-100">
              Recent invoices
            </h2>
            <span className="text-xs text-zinc-600">
              {rangeStart}–{rangeEnd} of {totalActive}
            </span>
          </div>
          {showBusinessLabel ? (
            <div className="space-y-6">
              {recentByBusiness.map((group) => (
                <div key={group.businessId}>
                  <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
                    {group.name}
                  </div>
                  <div className="overflow-hidden rounded-xl border border-zinc-900">
                    {group.invoices.map((inv) => (
                      <InvoiceRow key={inv.id} inv={inv} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-900">
              {recentInvoices.map((inv) => (
                <InvoiceRow key={inv.id} inv={inv} />
              ))}
            </div>
          )}
          {totalPages > 1 ? (
            <Pagination page={page} totalPages={totalPages} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "draft" | "sent" | "paid" | "void";
}) {
  const map = {
    draft: "border-amber-700/60 text-amber-400",
    sent: "border-sky-700/60 text-sky-400",
    paid: "border-emerald-700/60 text-emerald-400",
    void: "border-zinc-700 text-zinc-400",
  } as const;
  const label = { draft: "Draft", sent: "Sent", paid: "Paid", void: "Void" }[status];
  return (
    <span
      className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${map[status]}`}
    >
      {label}
    </span>
  );
}

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const prevHref =
    page <= 2 ? "/dashboard" : `/dashboard?page=${page - 1}`;
  const nextHref = `/dashboard?page=${page + 1}`;
  const atFirst = page <= 1;
  const atLast = page >= totalPages;
  const linkClass =
    "rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100";
  const disabledClass =
    "rounded-md border border-zinc-900 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-700 cursor-not-allowed";
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
      {atFirst ? (
        <span className={disabledClass}>← Previous</span>
      ) : (
        <Link href={prevHref} className={linkClass}>← Previous</Link>
      )}
      <span>
        Page {page} of {totalPages}
      </span>
      {atLast ? (
        <span className={disabledClass}>Next →</span>
      ) : (
        <Link href={nextHref} className={linkClass}>Next →</Link>
      )}
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

function InvoiceRow({
  inv,
}: {
  inv: {
    id: string;
    invoiceNumber: string;
    status: "draft" | "sent" | "paid" | "void";
    total: string;
    currency: string;
    shareSlug: string;
    clientNameSnapshot: string | null;
  };
}) {
  return (
    <div
      className={`flex flex-col gap-3 border-b border-zinc-900 bg-[#0a0a0a] px-4 py-4 last:border-b-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4 sm:px-5 ${inv.status === "void" ? "opacity-40" : ""}`}
    >
      <div className="font-mono text-sm text-zinc-100">{inv.invoiceNumber}</div>
      <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-300">
        <span>{formatMoney(inv.total, inv.currency)}</span>
        <StatusBadge status={inv.status} />
      </div>
      <div className="flex items-center gap-3">
        {inv.clientNameSnapshot ? (
          <span
            title={inv.clientNameSnapshot}
            className="max-w-[10rem] truncate text-xs text-zinc-500"
          >
            {inv.clientNameSnapshot}
          </span>
        ) : null}
        <CopyLinkButton url={invoiceShareUrl(inv.shareSlug)} />
        <Link
          href={invoiceShareUrl(inv.shareSlug)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-center text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
        >
          View invoice ↗
        </Link>
      </div>
    </div>
  );
}

