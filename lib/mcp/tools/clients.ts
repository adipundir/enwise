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
import { ctxFromAuthInfo } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const clientIdSchema = z.string().uuid();

const createSchema = {
  name: z.string().min(1).max(200),
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
  client_id: clientIdSchema,
  name: z.string().min(1).max(200).optional(),
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
        "Add a new client to the user's business. Name is required; everything else is optional. Returns the created client including its id — remember the id for follow-up tool calls in this session.",
      inputSchema: createSchema,
    },
    async (args, extra) => {
      const parsed = z.object(createSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const row = await createClient(ctx, toClientCreate(parsed.data));
      return toolOk(formatClientForMcp(row));
    },
  );

  server.registerTool(
    "update_client",
    {
      title: "Update client",
      description:
        "Partially update a client. Pass the fields you want to change; omit others. Pass null to clear a nullable field. Call find_client first if you only have a name.",
      inputSchema: updateSchema,
    },
    async (args, extra) => {
      const parsed = z.object(updateSchema).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const { client_id, ...rest } = parsed.data;
      const updated = await updateClient(ctx, client_id, toClientPatch(rest as never));
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
      description: "Fetch a client by id. Use find_client to resolve a name first.",
      inputSchema: { client_id: clientIdSchema },
    },
    async (args, extra) => {
      const parsed = z.object({ client_id: clientIdSchema }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const row = await getClient(ctx, parsed.data.client_id);
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
        "Search clients by name or email. Returns up to `limit` matches ranked by similarity score (higher = closer match). Use this whenever the user refers to a client by name ('send invoice to Acme') — resolve the name to an id before calling invoice tools. If multiple matches are returned, ask the user which one they meant.",
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(25).optional(),
        include_archived: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(25).optional(),
          include_archived: z.boolean().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const matches = await findClients(ctx, {
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
        "List clients, alphabetical by name. Archived clients are excluded by default.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        include_archived: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const parsed = z
        .object({
          limit: z.number().int().min(1).max(200).optional(),
          include_archived: z.boolean().optional(),
        })
        .safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const rows = await listClients(ctx, {
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
        "Archive a client. They stop showing in list_clients and find_client (unless include_archived is set). Existing invoices are untouched. This is a soft action — archived clients can be restored by calling update_client.",
      inputSchema: { client_id: clientIdSchema },
    },
    async (args, extra) => {
      const parsed = z.object({ client_id: clientIdSchema }).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const row = await archiveClient(ctx, parsed.data.client_id);
      if (!row) {
        return toolError("not_found", `No client with id ${parsed.data.client_id}.`);
      }
      return toolOk(formatClientForMcp(row));
    },
  );
}
