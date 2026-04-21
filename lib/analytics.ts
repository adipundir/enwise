import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { EnvoiceCtx } from "@/lib/mcp/context";

export type CurrencyBucket = {
  currency: string;
  total_billed: string;
  total_paid: string;
  outstanding: string;
  invoice_count: number;
};

export interface ClientSummary {
  client_id: string;
  client_name: string;
  by_currency: CurrencyBucket[];
  invoice_count: number;
  last_invoice_date: string | null;
}

export async function getClientSummary(
  ctx: EnvoiceCtx,
  clientId: string,
): Promise<ClientSummary | null> {
  const metaRes = await db.execute(sql`
    select c.id as id, c.name as name,
           count(i.id) filter (where i.deleted_at is null) as invoice_count,
           max(i.issue_date) filter (where i.deleted_at is null) as last_date
    from clients c
    left join invoices i on i.client_id = c.id and i.business_id = ${ctx.businessId}
    where c.business_id = ${ctx.businessId}
      and c.id = ${clientId}
    group by c.id, c.name
  `);
  const meta = metaRes.rows[0] as
    | { id: string; name: string; invoice_count: number | string; last_date: string | null }
    | undefined;
  if (!meta) return null;

  const agg = await db.execute(sql`
    select
      currency,
      coalesce(sum(total) filter (where status <> 'void'), 0)::numeric(14,2)::text                                as total_billed,
      coalesce(sum(amount_paid) filter (where status <> 'void'), 0)::numeric(14,2)::text                         as total_paid,
      coalesce(sum(total - amount_paid) filter (where status = 'sent'), 0)::numeric(14,2)::text                  as outstanding,
      count(*) filter (where status <> 'void')::int                                                              as invoice_count
    from invoices
    where business_id = ${ctx.businessId}
      and client_id = ${clientId}
      and deleted_at is null
    group by currency
    order by currency
  `);

  return {
    client_id: meta.id,
    client_name: meta.name,
    by_currency: agg.rows.map((r) => {
      const row = r as unknown as CurrencyBucket;
      return {
        currency: row.currency,
        total_billed: String(row.total_billed),
        total_paid: String(row.total_paid),
        outstanding: String(row.outstanding),
        invoice_count: Number(row.invoice_count),
      };
    }),
    invoice_count: Number(meta.invoice_count),
    last_invoice_date: meta.last_date,
  };
}

export type RevenuePeriod = "month" | "quarter" | "year";

export interface RevenueBucket {
  period_start: string; // YYYY-MM-DD
  currency: string;
  total_billed: string;
  total_paid: string;
  invoice_count: number;
}

export interface RevenueSummary {
  period: RevenuePeriod;
  buckets: RevenueBucket[];
  top_clients: Array<{
    client_id: string;
    client_name: string;
    currency: string;
    total_billed: string;
    invoice_count: number;
  }>;
}

const PERIOD_CONFIG: Record<
  RevenuePeriod,
  { truncUnit: string; historyUnit: string; count: number }
> = {
  month: { truncUnit: "month", historyUnit: "months", count: 12 },
  quarter: { truncUnit: "quarter", historyUnit: "months", count: 12 },
  year: { truncUnit: "year", historyUnit: "years", count: 5 },
};

export async function getRevenueSummary(
  ctx: EnvoiceCtx,
  opts: { period: RevenuePeriod } = { period: "month" },
): Promise<RevenueSummary> {
  const cfg = PERIOD_CONFIG[opts.period];
  const truncUnit = sql.raw(`'${cfg.truncUnit}'`);
  const historyInterval = sql.raw(
    `'${cfg.count} ${cfg.historyUnit}'`,
  );

  const buckets = await db.execute(sql`
    select
      to_char(date_trunc(${truncUnit}, issue_date)::date, 'YYYY-MM-DD')                as period_start,
      currency,
      coalesce(sum(total) filter (where status <> 'void'), 0)::numeric(14,2)::text     as total_billed,
      coalesce(sum(amount_paid) filter (where status <> 'void'), 0)::numeric(14,2)::text as total_paid,
      count(*) filter (where status <> 'void')::int                                    as invoice_count
    from invoices
    where business_id = ${ctx.businessId}
      and deleted_at is null
      and issue_date >= date_trunc(${truncUnit}, (current_date - interval ${historyInterval}))
    group by 1, currency
    order by 1 desc, currency asc
  `);

  const topClients = await db.execute(sql`
    select
      i.client_id                                                                      as client_id,
      coalesce(i.client_name_snapshot, c.name)                                         as client_name,
      i.currency                                                                       as currency,
      sum(i.total) filter (where i.status <> 'void')::numeric(14,2)::text              as total_billed,
      count(*) filter (where i.status <> 'void')::int                                  as invoice_count
    from invoices i
    left join clients c on c.id = i.client_id
    where i.business_id = ${ctx.businessId}
      and i.deleted_at is null
      and i.issue_date >= date_trunc(${truncUnit}, (current_date - interval ${historyInterval}))
    group by i.client_id, client_name, i.currency
    having sum(i.total) filter (where i.status <> 'void') is not null
    order by sum(i.total) filter (where i.status <> 'void') desc
    limit 5
  `);

  return {
    period: opts.period,
    buckets: buckets.rows.map((r) => {
      const row = r as unknown as RevenueBucket;
      return {
        period_start: String(row.period_start),
        currency: row.currency,
        total_billed: String(row.total_billed),
        total_paid: String(row.total_paid),
        invoice_count: Number(row.invoice_count),
      };
    }),
    top_clients: topClients.rows.map((r) => {
      const row = r as {
        client_id: string;
        client_name: string;
        currency: string;
        total_billed: string;
        invoice_count: number;
      };
      return {
        client_id: row.client_id,
        client_name: row.client_name,
        currency: row.currency,
        total_billed: String(row.total_billed),
        invoice_count: Number(row.invoice_count),
      };
    }),
  };
}

export interface OutstandingInvoice {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string | null;
  currency: string;
  total: string;
  amount_paid: string;
  outstanding: string;
  issue_date: string;
  due_date: string;
  days_overdue: number;
}

export async function getOutstandingInvoices(
  ctx: EnvoiceCtx,
  opts: { clientId?: string; overdueOnly?: boolean; limit?: number } = {},
): Promise<OutstandingInvoice[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  const clientClause = opts.clientId
    ? sql`and i.client_id = ${opts.clientId}`
    : sql``;
  const overdueClause = opts.overdueOnly
    ? sql`and i.due_date < current_date`
    : sql``;

  const res = await db.execute(sql`
    select
      i.id                                               as id,
      i.invoice_number                                   as invoice_number,
      i.client_id                                        as client_id,
      coalesce(i.client_name_snapshot, c.name)           as client_name,
      i.currency                                         as currency,
      i.total::text                                      as total,
      i.amount_paid::text                                as amount_paid,
      (i.total - i.amount_paid)::text                    as outstanding,
      i.issue_date::text                                 as issue_date,
      i.due_date::text                                   as due_date,
      greatest(0, (current_date - i.due_date))::int      as days_overdue
    from invoices i
    left join clients c on c.id = i.client_id
    where i.business_id = ${ctx.businessId}
      and i.deleted_at is null
      and i.status = 'sent'
      ${clientClause}
      ${overdueClause}
    order by i.due_date asc, i.invoice_number asc
    limit ${limit}
  `);

  return res.rows.map((r) => {
    const row = r as unknown as OutstandingInvoice;
    return {
      id: row.id,
      invoice_number: row.invoice_number,
      client_id: row.client_id,
      client_name: row.client_name,
      currency: row.currency,
      total: String(row.total),
      amount_paid: String(row.amount_paid),
      outstanding: String(row.outstanding),
      issue_date: String(row.issue_date),
      due_date: String(row.due_date),
      days_overdue: Number(row.days_overdue),
    };
  });
}
