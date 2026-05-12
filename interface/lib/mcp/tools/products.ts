import { z } from "zod";
import {
  archiveProduct,
  createProduct,
  findProducts,
  formatProductForMcp,
  getProduct,
  listProducts,
  updateProduct,
  type ProductCreate,
  type ProductPatch,
} from "@/lib/products";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const productIdSchema = z.string().uuid();
const uuid = z.string().uuid();

// Accept amounts as strings or numbers. Claude sometimes sends "5000.00" and
// sometimes sends 5000. Coerce to a canonical `numeric(14,2)` string.
const amountSchema = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "Amount must be a number (e.g. 5000 or 2499.99).",
      });
      return z.NEVER;
    }
    const [intPart, decPart = ""] = raw.split(".");
    const dec = (decPart + "00").slice(0, 2);
    return `${intPart}.${dec}`;
  });

const taxRateSchema = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[,\s%]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Tax rate must be a decimal fraction (e.g. 0.08 for 8%) or a plain number (e.g. 0.21).",
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (n > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "Tax rate must be a fraction < 1. Got " +
          raw +
          ". did you pass a percentage by mistake (e.g. 8 instead of 0.08)?",
      });
      return z.NEVER;
    }
    // Store 4 decimals of precision.
    return n.toFixed(4);
  });

const createSchema = {
  business_id: uuid.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  unit_price: amountSchema,
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD'")
    .transform((s) => s.toUpperCase()),
  default_tax_rate: taxRateSchema.nullish(),
  sku: z.string().max(80).nullish(),
  client_request_id: z.string().max(64).optional(),
};

const updateSchema = {
  business_id: uuid.optional(),
  product_id: productIdSchema,
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  unit_price: amountSchema.optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD'")
    .transform((s) => s.toUpperCase())
    .optional(),
  default_tax_rate: taxRateSchema.nullish(),
  sku: z.string().max(80).nullish(),
};

function toProductCreate(input: z.infer<z.ZodObject<typeof createSchema>>): ProductCreate {
  return {
    name: input.name,
    description: input.description ?? null,
    unitPrice: input.unit_price,
    currency: input.currency,
    defaultTaxRate: input.default_tax_rate ?? null,
    sku: input.sku ?? null,
  };
}

function toProductPatch(input: z.infer<z.ZodObject<typeof updateSchema>>): ProductPatch {
  const patch: ProductPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.unit_price !== undefined) patch.unitPrice = input.unit_price;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.default_tax_rate !== undefined) patch.defaultTaxRate = input.default_tax_rate ?? null;
  if (input.sku !== undefined) patch.sku = input.sku ?? null;
  return patch;
}

export function registerProductTools(server: McpServer) {
  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Add a reusable product or service to the catalog (e.g. 'Logo design. $2000 USD'). Later, invoice line items can reference it by product_id so the user doesn't need to re-type price/description each time.",
      inputSchema: createSchema,
    },
    async (args, extra) => {
      const parsed = z.object(createSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const row = await createProduct(ctx, toProductCreate(parsed.data));
      return toolOk(formatProductForMcp(row));
    },
  );

  server.registerTool(
    "update_product",
    {
      title: "Update product",
      description:
        "Partial update of a catalog product (name, description, unit_price, default_tax_rate, default_currency, sku). Only the fields you pass are changed; omitted fields stay as they are. Pass `null` to clear a nullable field. Products are account-level (shared across every business the user owns), so updating a product affects future invoices across all businesses — but already-snapshotted line items are unchanged.",
      inputSchema: updateSchema,
    },
    async (args, extra) => {
      const parsed = z.object(updateSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const { product_id, ...rest } = parsed.data;
      const updated = await updateProduct(ctx, product_id, toProductPatch(rest as never));
      if (!updated) {
        return toolError("not_found", `No product with id ${product_id}.`);
      }
      return toolOk(formatProductForMcp(updated));
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description:
        "Fetch a single catalog product by id. Returns name, description, unit_price, default_tax_rate, default_currency, sku, and archived state. Use this when you have a product_id and need full details; for searching by name use find_product.",
      inputSchema: {
    business_id: uuid.optional(), product_id: productIdSchema },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), product_id: productIdSchema }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const row = await getProduct(ctx, parsed.data.product_id);
      if (!row) {
        return toolError("not_found", `No product with id ${parsed.data.product_id}.`);
      }
      return toolOk(formatProductForMcp(row));
    },
  );

  server.registerTool(
    "find_product",
    {
      title: "Find product (fuzzy)",
      description:
        "Search catalog products by name (fuzzy) or exact SKU. Use this when the user says 'invoice Acme for logo design'. find 'logo design' first, then use the returned product_id in create_invoice line items.",
      inputSchema: {
        business_id: uuid.optional(),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(25).optional(),
        include_archived: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          business_id: uuid.optional(),
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(25).optional(),
          include_archived: z.boolean().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, parsed.data.business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const matches = await findProducts(ctx, {
        query: parsed.data.query,
        limit: parsed.data.limit,
        includeArchived: parsed.data.include_archived,
      });
      if (matches.length === 0) {
        return toolError(
          "not_found",
          `No products match "${parsed.data.query}".`,
          {
            hint:
              "Try a shorter query, check spelling, or call `list_products` for the full catalog. Use `create_product` to add a new item.",
          },
        );
      }
      return toolOk({ query: parsed.data.query, matches });
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List catalog products, alphabetical by name. Archived products are excluded by default.",
      inputSchema: {
        business_id: uuid.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        include_archived: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          business_id: uuid.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          include_archived: z.boolean().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, parsed.data.business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const rows = await listProducts(ctx, {
        limit: parsed.data.limit,
        includeArchived: parsed.data.include_archived,
      });
      return toolOk({ products: rows.map(formatProductForMcp) });
    },
  );

  server.registerTool(
    "archive_product",
    {
      title: "Archive product",
      description:
        "Archive a product. It stops appearing in list/find unless include_archived is true. Existing line items that reference it are untouched (line items snapshot description and price at invoice time).",
      inputSchema: {
    business_id: uuid.optional(), product_id: productIdSchema },
    },
    async (args, extra) => {
      const parsed = z.object({
      business_id: uuid.optional(), product_id: productIdSchema }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const __u = ctxFromAuthInfo(extra.authInfo);
      const __s = await scopeFromCtx(__u, (parsed.data as { business_id?: string }).business_id);
      if (!__s.ok) return __s.error;
      const ctx = __s.scoped;
      const row = await archiveProduct(ctx, parsed.data.product_id);
      if (!row) {
        return toolError("not_found", `No product with id ${parsed.data.product_id}.`);
      }
      return toolOk(formatProductForMcp(row));
    },
  );
}
