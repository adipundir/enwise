import { z } from "zod";
import {
  addBankAccount,
  formatBankAccountForMcp,
  listBankAccounts,
  removeBankAccount,
  setDefaultBankAccount,
  updateBankAccount,
  type BankAccountPatch,
} from "@/lib/bankAccounts";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const uuid = z.string().uuid();

const fieldSchemas = {
  label: z.string().min(1).max(64),
  account_holder: z.string().max(200).nullish(),
  bank_name: z.string().max(200).nullish(),
  account_number: z.string().max(64).nullish(),
  ifsc: z.string().max(32).nullish(),
  swift: z.string().max(32).nullish(),
  iban: z.string().max(64).nullish(),
  ach_routing: z.string().max(32).nullish(),
  fedwire_routing: z.string().max(32).nullish(),
  branch_address: z.string().max(300).nullish(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "3-letter ISO 4217 code like 'USD' or 'EUR'")
    .transform((s) => s.toUpperCase())
    .nullish(),
} as const;

const addInput = {
  business_id: uuid.optional(),
  ...fieldSchemas,
  /** Set this account as the merchant's new default. If they don't have any
   *  accounts yet, the first one added becomes default automatically. */
  set_default: z.boolean().optional(),
} as const;

const updateInput = {
  business_id: uuid.optional(),
  bank_account_id: uuid,
  label: fieldSchemas.label.optional(),
  account_holder: fieldSchemas.account_holder,
  bank_name: fieldSchemas.bank_name,
  account_number: fieldSchemas.account_number,
  ifsc: fieldSchemas.ifsc,
  swift: fieldSchemas.swift,
  iban: fieldSchemas.iban,
  ach_routing: fieldSchemas.ach_routing,
  fedwire_routing: fieldSchemas.fedwire_routing,
  branch_address: fieldSchemas.branch_address,
  currency: fieldSchemas.currency,
} as const;

const idOnlyInput = {
  business_id: uuid.optional(),
  bank_account_id: uuid,
} as const;

const listInput = {
  business_id: uuid.optional(),
} as const;

export function registerBankAccountTools(server: McpServer) {
  server.registerTool(
    "list_bank_accounts",
    {
      title: "List bank accounts for a business",
      description:
        "Return every active bank account configured on a business. Default account is first in the list, others by creation order. Each entry includes id, label, account_holder, bank_name, account_number, ifsc, swift, iban, ach_routing, fedwire_routing, branch_address, currency, is_default. Use this BEFORE add_bank_account to avoid creating duplicates, and BEFORE create_invoice when the user hasn't picked which account to use. Pass `business_id` if the user owns multiple businesses.",
      inputSchema: listInput,
    },
    async (args, extra) => {
      const parsed = z.object(listInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;
      const rows = await listBankAccounts(scope.scoped.businessId);
      return toolOk({ bank_accounts: rows.map(formatBankAccountForMcp) });
    },
  );

  server.registerTool(
    "add_bank_account",
    {
      title: "Add a bank account",
      description:
        "Create a new bank payout account for a business. A merchant can have multiple accounts (e.g. USD primary + INR HDFC + EUR Wise) and pick which one(s) to show on each invoice. `label` is a short human name the merchant uses to disambiguate ('USD primary', 'INR HDFC'). Fill the fields appropriate for the receiving rail: IFSC for India, SWIFT for international wires into the account, IBAN for Europe, ach_routing for US domestic ACH transfers, fedwire_routing for US domestic wires (often a different 9-digit number than ACH at the same bank — set both if the bank provides them). `branch_address` is required by most US/EU sending banks. Pass `set_default: true` to make this the merchant's default account for new invoices — if no accounts exist yet, the first one added becomes default automatically.",
      inputSchema: addInput,
    },
    async (args, extra) => {
      const parsed = z.object(addInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, input.business_id);
      if (!scope.ok) return scope.error;
      const row = await addBankAccount(scope.scoped.businessId, {
        label: input.label,
        accountHolder: input.account_holder ?? null,
        bankName: input.bank_name ?? null,
        accountNumber: input.account_number ?? null,
        ifsc: input.ifsc ?? null,
        swift: input.swift ?? null,
        iban: input.iban ?? null,
        achRouting: input.ach_routing ?? null,
        fedwireRouting: input.fedwire_routing ?? null,
        branchAddress: input.branch_address ?? null,
        currency: input.currency ?? null,
        setDefault: input.set_default,
      });
      return toolOk(formatBankAccountForMcp(row));
    },
  );

  server.registerTool(
    "update_bank_account",
    {
      title: "Update a bank account",
      description:
        "Modify any subset of fields on an existing bank account (label, holder, bank name, account number, IFSC, SWIFT, IBAN, ach_routing, fedwire_routing, branch address, currency). Omitted fields are unchanged; pass null to clear a nullable field. To change which account is the default, use `set_default_bank_account` instead. Soft-deleted accounts can't be updated — use add_bank_account to add a new one.",
      inputSchema: updateInput,
    },
    async (args, extra) => {
      const parsed = z.object(updateInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, input.business_id);
      if (!scope.ok) return scope.error;
      const patch: BankAccountPatch = {};
      if (input.label !== undefined) patch.label = input.label;
      if (input.account_holder !== undefined) patch.accountHolder = input.account_holder ?? null;
      if (input.bank_name !== undefined) patch.bankName = input.bank_name ?? null;
      if (input.account_number !== undefined) patch.accountNumber = input.account_number ?? null;
      if (input.ifsc !== undefined) patch.ifsc = input.ifsc ?? null;
      if (input.swift !== undefined) patch.swift = input.swift ?? null;
      if (input.iban !== undefined) patch.iban = input.iban ?? null;
      if (input.ach_routing !== undefined) patch.achRouting = input.ach_routing ?? null;
      if (input.fedwire_routing !== undefined) patch.fedwireRouting = input.fedwire_routing ?? null;
      if (input.branch_address !== undefined) patch.branchAddress = input.branch_address ?? null;
      if (input.currency !== undefined) patch.currency = input.currency ?? null;
      const updated = await updateBankAccount(
        scope.scoped.businessId,
        input.bank_account_id,
        patch,
      );
      if (!updated) {
        return toolError(
          "not_found",
          "Bank account not found (or not owned by this business).",
        );
      }
      return toolOk(formatBankAccountForMcp(updated));
    },
  );

  server.registerTool(
    "remove_bank_account",
    {
      title: "Remove a bank account",
      description:
        "Soft-delete a bank account. Already-sent invoices that snapshot this account keep their data (the snapshot is frozen). If the deleted account was the merchant's default, the oldest remaining account is automatically promoted. The merchant can still have zero accounts left — new invoices will then have no bank rail (crypto wallet rail still works if configured).",
      inputSchema: idOnlyInput,
    },
    async (args, extra) => {
      const parsed = z.object(idOnlyInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, input.business_id);
      if (!scope.ok) return scope.error;
      const removed = await removeBankAccount(
        scope.scoped.businessId,
        input.bank_account_id,
      );
      if (!removed) {
        return toolError("not_found", "Bank account not found.");
      }
      return toolOk(formatBankAccountForMcp(removed));
    },
  );

  server.registerTool(
    "set_default_bank_account",
    {
      title: "Set the default bank account",
      description:
        "Mark one bank account as the merchant's default — new invoices auto-select this account (unless the user passes `accepted_bank_account_ids` on create_invoice / update_invoice to override). Only one default per business is allowed; this tool clears any previous default in the same transaction.",
      inputSchema: idOnlyInput,
    },
    async (args, extra) => {
      const parsed = z.object(idOnlyInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const input = parsed.data;
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, input.business_id);
      if (!scope.ok) return scope.error;
      const updated = await setDefaultBankAccount(
        scope.scoped.businessId,
        input.bank_account_id,
      );
      if (!updated) {
        return toolError("not_found", "Bank account not found.");
      }
      return toolOk(formatBankAccountForMcp(updated));
    },
  );
}
