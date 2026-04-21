import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, type Product } from "@/lib/db/schema";
import type { EnvoiceCtx } from "@/lib/mcp/context";

const DEFAULT_FIND_LIMIT = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export type ProductCreate = {
  name: string;
  description?: string | null;
  unitPrice: string;
  currency: string;
  defaultTaxRate?: string | null;
  sku?: string | null;
};

export type ProductPatch = Partial<ProductCreate>;

export async function createProduct(
  ctx: EnvoiceCtx,
  input: ProductCreate,
): Promise<Product> {
  const [row] = await db
    .insert(products)
    .values({ businessId: ctx.businessId, ...input })
    .returning();
  return row!;
}

export async function updateProduct(
  ctx: EnvoiceCtx,
  productId: string,
  patch: ProductPatch,
): Promise<Product | null> {
  if (Object.keys(patch).length === 0) {
    return getProduct(ctx, productId);
  }
  const [row] = await db
    .update(products)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(products.id, productId), eq(products.businessId, ctx.businessId)),
    )
    .returning();
  return row ?? null;
}

export async function getProduct(
  ctx: EnvoiceCtx,
  productId: string,
): Promise<Product | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(
      and(eq(products.id, productId), eq(products.businessId, ctx.businessId)),
    );
  return row ?? null;
}

export async function listProducts(
  ctx: EnvoiceCtx,
  opts: { limit?: number; includeArchived?: boolean } = {},
): Promise<Product[]> {
  const limit = clamp(opts.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const conditions = [eq(products.businessId, ctx.businessId)];
  if (!opts.includeArchived) conditions.push(isNull(products.archivedAt));
  return db
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(asc(products.name))
    .limit(limit);
}

export async function archiveProduct(
  ctx: EnvoiceCtx,
  productId: string,
): Promise<Product | null> {
  const [row] = await db
    .update(products)
    .set({ archivedAt: new Date() })
    .where(
      and(eq(products.id, productId), eq(products.businessId, ctx.businessId)),
    )
    .returning();
  return row ?? null;
}

export type ProductMatch = {
  id: string;
  name: string;
  sku: string | null;
  unit_price: string;
  currency: string;
  archived: boolean;
  score: number;
};

export async function findProducts(
  ctx: EnvoiceCtx,
  opts: { query: string; limit?: number; includeArchived?: boolean },
): Promise<ProductMatch[]> {
  const query = opts.query.trim();
  if (query.length === 0) return [];
  const limit = clamp(opts.limit ?? DEFAULT_FIND_LIMIT, 1, 25);
  const normQuery = sql`lower(immutable_unaccent(${query}))`;
  const archivedClause = opts.includeArchived
    ? sql`true`
    : sql`${products.archivedAt} is null`;

  const result = await db.execute(sql`
    select
      ${products.id}            as id,
      ${products.name}          as name,
      ${products.sku}           as sku,
      ${products.unitPrice}     as unit_price,
      ${products.currency}      as currency,
      ${products.archivedAt}    as archived_at,
      greatest(
        similarity(${products.nameNormalized}, ${normQuery}),
        case
          when ${products.nameNormalized} ilike '%' || ${normQuery} || '%' then 0.55
          when lower(${products.sku}) = lower(${query}) then 0.95
          else 0
        end
      )::float as score
    from ${products}
    where ${products.businessId} = ${ctx.businessId}
      and ${archivedClause}
      and (
        ${products.nameNormalized} % ${normQuery}
        or ${products.nameNormalized} ilike '%' || ${normQuery} || '%'
        or lower(${products.sku}) = lower(${query})
      )
    order by score desc, ${products.name} asc
    limit ${limit}
  `);

  return result.rows.map((r) => {
    const row = r as {
      id: string;
      name: string;
      sku: string | null;
      unit_price: string;
      currency: string;
      archived_at: string | null;
      score: number | string;
    };
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      unit_price: String(row.unit_price),
      currency: row.currency,
      archived: row.archived_at !== null,
      score: Number(row.score) || 0,
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function formatProductForMcp(row: Product) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    unit_price: String(row.unitPrice),
    currency: row.currency,
    default_tax_rate: row.defaultTaxRate !== null ? String(row.defaultTaxRate) : null,
    sku: row.sku,
    archived: row.archivedAt !== null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
