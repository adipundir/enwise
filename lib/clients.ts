import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clients, type Client } from "@/lib/db/schema";
import type { EnwiseCtx } from "@/lib/mcp/context";

const DEFAULT_FIND_LIMIT = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export type ClientCreate = {
  name: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxId?: string | null;
  notes?: string | null;
  defaultCurrency?: string | null;
};

export type ClientPatch = Partial<ClientCreate>;

export async function createClient(
  ctx: EnwiseCtx,
  input: ClientCreate,
): Promise<Client> {
  const [row] = await db
    .insert(clients)
    .values({ businessId: ctx.businessId, ...input })
    .returning();
  return row!;
}

export async function updateClient(
  ctx: EnwiseCtx,
  clientId: string,
  patch: ClientPatch,
): Promise<Client | null> {
  if (Object.keys(patch).length === 0) {
    return getClient(ctx, clientId);
  }
  const [row] = await db
    .update(clients)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(clients.id, clientId), eq(clients.businessId, ctx.businessId)),
    )
    .returning();
  return row ?? null;
}

export async function getClient(
  ctx: EnwiseCtx,
  clientId: string,
): Promise<Client | null> {
  const [row] = await db
    .select()
    .from(clients)
    .where(
      and(eq(clients.id, clientId), eq(clients.businessId, ctx.businessId)),
    );
  return row ?? null;
}

export async function listClients(
  ctx: EnwiseCtx,
  opts: { limit?: number; includeArchived?: boolean } = {},
): Promise<Client[]> {
  const limit = clamp(opts.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const conditions = [eq(clients.businessId, ctx.businessId)];
  if (!opts.includeArchived) conditions.push(isNull(clients.archivedAt));
  return db
    .select()
    .from(clients)
    .where(and(...conditions))
    .orderBy(asc(clients.name))
    .limit(limit);
}

export async function archiveClient(
  ctx: EnwiseCtx,
  clientId: string,
): Promise<Client | null> {
  const [row] = await db
    .update(clients)
    .set({ archivedAt: new Date() })
    .where(
      and(eq(clients.id, clientId), eq(clients.businessId, ctx.businessId)),
    )
    .returning();
  return row ?? null;
}

export type ClientMatch = {
  id: string;
  name: string;
  email: string | null;
  archived: boolean;
  score: number;
};

/**
 * Fuzzy search. Uses pg_trgm similarity on the generated name_normalized
 * column (indexed with gin_trgm_ops), with an ILIKE fallback for short/partial
 * queries that slip under the trigram threshold, plus an email substring
 * match. Excludes archived clients unless `includeArchived` is true.
 */
export async function findClients(
  ctx: EnwiseCtx,
  opts: { query: string; limit?: number; includeArchived?: boolean },
): Promise<ClientMatch[]> {
  const query = opts.query.trim();
  if (query.length === 0) return [];
  const limit = clamp(opts.limit ?? DEFAULT_FIND_LIMIT, 1, 25);
  const normQuery = sql`lower(immutable_unaccent(${query}))`;
  const archivedClause = opts.includeArchived
    ? sql`true`
    : sql`${clients.archivedAt} is null`;

  const result = await db.execute(sql`
    select
      ${clients.id}                 as id,
      ${clients.name}               as name,
      ${clients.email}              as email,
      ${clients.archivedAt}         as archived_at,
      greatest(
        similarity(${clients.nameNormalized}, ${normQuery}),
        case
          when ${clients.nameNormalized} ilike '%' || ${normQuery} || '%' then 0.55
          when lower(${clients.email}) ilike '%' || lower(${query}) || '%' then 0.65
          else 0
        end
      )::float as score
    from ${clients}
    where ${clients.businessId} = ${ctx.businessId}
      and ${archivedClause}
      and (
        ${clients.nameNormalized} % ${normQuery}
        or ${clients.nameNormalized} ilike '%' || ${normQuery} || '%'
        or lower(${clients.email}) ilike '%' || lower(${query}) || '%'
      )
    order by score desc, ${clients.name} asc
    limit ${limit}
  `);

  return result.rows.map((r) => {
    const row = r as {
      id: string;
      name: string;
      email: string | null;
      archived_at: string | null;
      score: number | string;
    };
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      archived: row.archived_at !== null,
      score: Number(row.score) || 0,
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function formatClientForMcp(row: Client) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address_line1: row.addressLine1,
    address_line2: row.addressLine2,
    city: row.city,
    region: row.region,
    postal_code: row.postalCode,
    country: row.country,
    tax_id: row.taxId,
    notes: row.notes,
    default_currency: row.defaultCurrency,
    archived: row.archivedAt !== null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
