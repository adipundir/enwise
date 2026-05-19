import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  businessBankAccounts,
  type BusinessBankAccount,
  type NewBusinessBankAccount,
} from "@/lib/db/schema";

export type BankAccountInput = {
  label: string;
  accountHolder?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  swift?: string | null;
  iban?: string | null;
  branchAddress?: string | null;
  currency?: string | null;
  /** If true OR if no default exists yet, this account becomes the default. */
  setDefault?: boolean;
};

export type BankAccountPatch = Partial<{
  label: string;
  accountHolder: string | null;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  branchAddress: string | null;
  currency: string | null;
}>;

/** List all non-deleted bank accounts for a business, default first. */
export async function listBankAccounts(
  businessId: string,
): Promise<BusinessBankAccount[]> {
  return db
    .select()
    .from(businessBankAccounts)
    .where(
      and(
        eq(businessBankAccounts.businessId, businessId),
        isNull(businessBankAccounts.deletedAt),
      ),
    )
    .orderBy(desc(businessBankAccounts.isDefault), asc(businessBankAccounts.createdAt));
}

/** Subset of listBankAccounts restricted to specific ids (used for invoice
 *  picker resolution). Preserves caller-provided order. Filters out
 *  ids belonging to other businesses + deleted ids. */
export async function getBankAccountsByIds(
  businessId: string,
  ids: string[],
): Promise<BusinessBankAccount[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(businessBankAccounts)
    .where(
      and(
        eq(businessBankAccounts.businessId, businessId),
        inArray(businessBankAccounts.id, ids),
        isNull(businessBankAccounts.deletedAt),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return ids.map((id) => byId.get(id)).filter((r): r is BusinessBankAccount => !!r);
}

export async function getDefaultBankAccount(
  businessId: string,
): Promise<BusinessBankAccount | null> {
  const [row] = await db
    .select()
    .from(businessBankAccounts)
    .where(
      and(
        eq(businessBankAccounts.businessId, businessId),
        eq(businessBankAccounts.isDefault, true),
        isNull(businessBankAccounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function addBankAccount(
  businessId: string,
  input: BankAccountInput,
): Promise<BusinessBankAccount> {
  const existing = await listBankAccounts(businessId);
  const wantsDefault = input.setDefault === true || existing.length === 0;
  if (wantsDefault) {
    await clearDefaultBankAccount(businessId);
  }
  const row: NewBusinessBankAccount = {
    businessId,
    label: input.label,
    accountHolder: input.accountHolder ?? null,
    bankName: input.bankName ?? null,
    accountNumber: input.accountNumber ?? null,
    ifsc: input.ifsc ?? null,
    swift: input.swift ?? null,
    iban: input.iban ?? null,
    branchAddress: input.branchAddress ?? null,
    currency: input.currency ?? null,
    isDefault: wantsDefault,
  };
  const [inserted] = await db.insert(businessBankAccounts).values(row).returning();
  if (!inserted) throw new Error("Failed to insert bank account");
  return inserted;
}

export async function updateBankAccount(
  businessId: string,
  bankAccountId: string,
  patch: BankAccountPatch,
): Promise<BusinessBankAccount | null> {
  if (Object.keys(patch).length === 0) {
    const [row] = await db
      .select()
      .from(businessBankAccounts)
      .where(
        and(
          eq(businessBankAccounts.id, bankAccountId),
          eq(businessBankAccounts.businessId, businessId),
          isNull(businessBankAccounts.deletedAt),
        ),
      );
    return row ?? null;
  }
  const [updated] = await db
    .update(businessBankAccounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(businessBankAccounts.id, bankAccountId),
        eq(businessBankAccounts.businessId, businessId),
        isNull(businessBankAccounts.deletedAt),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Soft-delete. If the deleted account was the default and other accounts
 *  remain, the oldest remaining account is promoted to default. */
export async function removeBankAccount(
  businessId: string,
  bankAccountId: string,
): Promise<BusinessBankAccount | null> {
  const [target] = await db
    .select()
    .from(businessBankAccounts)
    .where(
      and(
        eq(businessBankAccounts.id, bankAccountId),
        eq(businessBankAccounts.businessId, businessId),
        isNull(businessBankAccounts.deletedAt),
      ),
    );
  if (!target) return null;

  const [deleted] = await db
    .update(businessBankAccounts)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(eq(businessBankAccounts.id, bankAccountId))
    .returning();

  if (target.isDefault) {
    // Promote oldest remaining account if any.
    const remaining = await listBankAccounts(businessId);
    if (remaining.length > 0) {
      await db
        .update(businessBankAccounts)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(businessBankAccounts.id, remaining[0]!.id));
    }
  }

  return deleted ?? null;
}

/** Promote one account to default, clearing the previous default first. */
export async function setDefaultBankAccount(
  businessId: string,
  bankAccountId: string,
): Promise<BusinessBankAccount | null> {
  const [target] = await db
    .select()
    .from(businessBankAccounts)
    .where(
      and(
        eq(businessBankAccounts.id, bankAccountId),
        eq(businessBankAccounts.businessId, businessId),
        isNull(businessBankAccounts.deletedAt),
      ),
    );
  if (!target) return null;
  if (target.isDefault) return target;
  await clearDefaultBankAccount(businessId);
  const [updated] = await db
    .update(businessBankAccounts)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(businessBankAccounts.id, bankAccountId))
    .returning();
  return updated ?? null;
}

async function clearDefaultBankAccount(businessId: string): Promise<void> {
  await db
    .update(businessBankAccounts)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(businessBankAccounts.businessId, businessId),
        eq(businessBankAccounts.isDefault, true),
      ),
    );
}

/** Resolve which accounts to render on an invoice. Order:
 *   1. If `acceptedBankAccountIds` is null/undefined → default account (or all if no default)
 *   2. If [] → empty (caller treats as "hide bank panel")
 *   3. Otherwise → exactly those accounts, deleted ones filtered out, in given order
 */
export async function resolveInvoiceBankAccounts(
  businessId: string,
  acceptedBankAccountIds: string[] | null | undefined,
): Promise<BusinessBankAccount[]> {
  if (acceptedBankAccountIds === null || acceptedBankAccountIds === undefined) {
    const def = await getDefaultBankAccount(businessId);
    if (def) return [def];
    return listBankAccounts(businessId);
  }
  if (acceptedBankAccountIds.length === 0) return [];
  return getBankAccountsByIds(businessId, acceptedBankAccountIds);
}

/** Project a BusinessBankAccount to the JSON shape used in snapshots
 *  (snake_case keys to match the migration's data format). */
export function toSnapshotShape(row: BusinessBankAccount): {
  id: string;
  label: string;
  account_holder: string | null;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  branch_address: string | null;
  currency: string | null;
} {
  return {
    id: row.id,
    label: row.label,
    account_holder: row.accountHolder,
    bank_name: row.bankName,
    account_number: row.accountNumber,
    ifsc: row.ifsc,
    swift: row.swift,
    iban: row.iban,
    branch_address: row.branchAddress,
    currency: row.currency,
  };
}

/** MCP-shape projection (omits internal id when listing). */
export function formatBankAccountForMcp(row: BusinessBankAccount) {
  return {
    id: row.id,
    label: row.label,
    account_holder: row.accountHolder,
    bank_name: row.bankName,
    account_number: row.accountNumber,
    ifsc: row.ifsc,
    swift: row.swift,
    iban: row.iban,
    branch_address: row.branchAddress,
    currency: row.currency,
    is_default: row.isDefault,
  };
}
