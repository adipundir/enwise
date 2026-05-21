import { z } from "zod";
import {
  archiveClient,
  createClient,
  findClients,
  formatClientForMcp,
  getClient,
  listClients,
  updateClient,
  type ClientCreate,
  type ClientPatch,
} from "@/lib/clients";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const clientIdSchema = z.string().uuid();
const uuid = z.string().uuid();

const createSchema = {
  business_id: uuid.optional(),
  name: z.string().min(1).max(200),
  contact_name: z.string().max(200).nullish(),
  wallet_address: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(32).nullish(),
  address_line1: z.string().max(200).nullish(),
  address_line2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  postal_code: z.string().max(20).nullish(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "2-letter ISO-3166 code like 'US' or 'GB'")
    .transform((s) => s.toUpperCase())
    .nullish(),
  tax_id: z.string().max(64).nullish(),
  notes: z.string().max(2000).nullish(),
  default_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD'")
    .transform((s) => s.toUpperCase())
    .nullish(),
  client_request_id: z.string().max(64).optional(),
};

const updateSchema = {
  business_id: uuid.optional(),
  client_id: clientIdSchema,
  name: z.string().min(1).max(200).optional(),
  contact_name: z.string().max(200).nullish(),
  wallet_address: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(32).nullish(),
  address_line1: z.string().max(200).nullish(),
  address_line2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  postal_code: z.string().max(20).nullish(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "2-letter ISO-3166 code like 'US' or 'GB'")
    .transform((s) => s.toUpperCase())
    .nullish(),
  tax_id: z.string().max(64).nullish(),
  notes: z.string().max(2000).nullish(),
  default_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD'")
    .transform((s) => s.toUpperCase())
    .nullish(),
};

function toClientCreate(input: z.infer<z.ZodObject<typeof createSchema>>): ClientCreate {
  return {
    name: input.name,
    contactName: input.contact_name ?? null,
    walletAddress: input.wallet_address ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    addressLine1: input.address_line1 ?? null,
    addressLine2: input.address_line2 ?? null,
    city: input.city ?? null,
    region: input.region ?? null,
    postalCode: input.postal_code ?? null,
    country: input.country ?? null,
    taxId: input.tax_id ?? null,
    notes: input.notes ?? null,
    defaultCurrency: input.default_currency ?? null,
  };
}

function toClientPatch(input: z.infer<z.ZodObject<typeof updateSchema>>): ClientPatch {
  const patch: ClientPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.contact_name !== undefined) patch.contactName = input.contact_name ?? null;
  if (input.wallet_address !== undefined) patch.walletAddress = input.wallet_address ?? null;
  if (input.email !== undefined) patch.email = input.email ?? null;
  if (input.phone !== undefined) patch.phone = input.phone ?? null;
  if (input.address_line1 !== undefined) patch.addressLine1 = input.address_line1 ?? null;
  if (input.address_line2 !== undefined) patch.addressLine2 = input.address_line2 ?? null;
  if (input.city !== undefined) patch.city = input.city ?? null;
  if (input.region !== undefined) patch.region = input.region ?? null;
  if (input.postal_code !== undefined) patch.postalCode = input.postal_code ?? null;
  if (input.country !== undefined) patch.country = input.country ?? null;
  if (input.tax_id !== undefined) patch.taxId = input.tax_id ?? null;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  if (input.default_currency !== undefined)
    patch.defaultCurrency = input.default_currency ?? null;
  return patch;
}

export function registerClientTools(server: McpServer) {
  server.registerTool(
    "create_client",
    {
      title: "Create client",
      description:
        "Add a new client using details the user has explicitly given you. NEVER invent a client name, email, address, tax ID, or wallet address. If the user hasn't told you these, ASK in ONE batched message (name + email + full address as a single freeform paste + currency + tax ID if applicable) — do not drip-feed questions and do not ask the user to type address parts separately. YOU split their pasted address into `address_line1` / `city` / `region` / `postal_code` / `country` (ISO-3166 alpha-2) before calling this tool. Save what the user gave you, move on with what they didn't — re-ask only if `name` (the one required field) is missing. For optional fields (email, address, currency, tax_id, phone), do NOT re-ask; if one turns out to be necessary later (e.g. no email but the user wants to email the invoice), ask THEN. Currency lives on the client only — there is no business-level fallback. If the user didn't name a currency at create time, leave it null; create_invoice will return `currency_required` later if needed, and you can ask + update_client then. `name` is the legal entity (the company billed); `contact_name` is the optional human at that company who'll receive the email — used as the email greeting (\"Hi Aditya,\"). For sole proprietors / freelancers, `contact_name` can equal `name`. `wallet_address` is the client's onchain identity (raw 0x… or ENS name like `acme.eth`) — surfaced on the invoice when present. Pass `business_id` when the user owns multiple businesses. Returns the created client including its id. If the response includes `payment_rails_note` (set when default_currency isn't USD), relay it to the user — USDC / wallet payments only work on USD invoices, so a non-USD client default means every invoice for them will be bank-rails-only. The user should hear this once at client creation. Remember the id for follow-up tool calls in this session.",
      inputSchema: createSchema,
    },
    async (args, extra) => {
      const parsed = z.object(createSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const row = await createClient(scope.scoped, toClientCreate(parsed.data));
      return toolOk(formatClientForMcp(row));
    },
  );

  server.registerTool(
    "update_client",
    {
      title: "Update client",
      description:
        "Partially update a client. Pass the fields you want to change; omit others. Pass null to clear a nullable field. Pass `business_id` if the user owns multiple businesses. Call find_client first if you only have a name.",
      inputSchema: updateSchema,
    },
    async (args, extra) => {
      const parsed = z.object(updateSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const { client_id, business_id: _bid, ...rest } = parsed.data;
      const updated = await updateClient(scope.scoped, client_id, toClientPatch({ ...rest, client_id } as never));
      if (!updated) {
        return toolError("not_found", `No client with id ${client_id}.`);
      }
      return toolOk(formatClientForMcp(updated));
    },
  );

  server.registerTool(
    "get_client",
    {
      title: "Get client",
      description:
        "Fetch a client by id. Pass `business_id` when the user owns multiple businesses. Use find_client to resolve a name first.",
      inputSchema: { business_id: uuid.optional(), client_id: clientIdSchema },
    },
    async (args, extra) => {
      const parsed = z
        .object({ business_id: uuid.optional(), client_id: clientIdSchema })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const row = await getClient(scope.scoped, parsed.data.client_id);
      if (!row) {
        return toolError("not_found", `No client with id ${parsed.data.client_id}.`);
      }
      return toolOk(formatClientForMcp(row));
    },
  );

  server.registerTool(
    "find_client",
    {
      title: "Find client (fuzzy)",
      description:
        "Search clients by name or email within a business. Returns up to `limit` matches ranked by similarity score. Pass `business_id` when the user owns multiple businesses. Use this whenever the user refers to a client by name. If multiple matches are returned, ask the user which one they meant.",
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
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const matches = await findClients(scope.scoped, {
        query: parsed.data.query,
        limit: parsed.data.limit,
        includeArchived: parsed.data.include_archived,
      });
      if (matches.length === 0) {
        return toolError(
          "not_found",
          `No clients match "${parsed.data.query}".`,
          {
            hint:
              "Try a shorter substring, check spelling, or call `list_clients` to see everyone. If the client doesn't exist yet, `create_client` to add them.",
          },
        );
      }
      return toolOk({ query: parsed.data.query, matches });
    },
  );

  server.registerTool(
    "list_clients",
    {
      title: "List clients",
      description:
        "List clients for a business, alphabetical by name. Archived clients are excluded by default. Pass `business_id` when the user owns multiple businesses.",
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
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const rows = await listClients(scope.scoped, {
        limit: parsed.data.limit,
        includeArchived: parsed.data.include_archived,
      });
      return toolOk({ clients: rows.map(formatClientForMcp) });
    },
  );

  server.registerTool(
    "archive_client",
    {
      title: "Archive client",
      description:
        "Archive a client. They stop showing in list_clients and find_client (unless include_archived is set). Existing invoices are untouched. Soft action. restore by calling update_client. Pass `business_id` when the user owns multiple businesses.",
      inputSchema: { business_id: uuid.optional(), client_id: clientIdSchema },
    },
    async (args, extra) => {
      const parsed = z
        .object({ business_id: uuid.optional(), client_id: clientIdSchema })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const row = await archiveClient(scope.scoped, parsed.data.client_id);
      if (!row) {
        return toolError("not_found", `No client with id ${parsed.data.client_id}.`);
      }
      return toolOk(formatClientForMcp(row));
    },
  );
}
