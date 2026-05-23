/**
 * Per-invoice display resolution.
 *
 * Resolution order for any business/client field shown on the share page or
 * PDF (highest precedence first):
 *
 *   1. invoice.displayOverrides[scope][key]   — if the key is present (even
 *                                               with a null value), it wins.
 *                                               null = explicitly hide.
 *   2. invoice.<thing>Snapshot                — frozen at finalize time.
 *   3. live business / client row             — drafts before finalize.
 *
 * Per-invoice payment method gating is independent: acceptedPaymentMethods
 * IS NULL means "show whatever is configured" (legacy behavior); a non-null
 * array means "only show these rails".
 */
import type { Invoice } from "@/lib/db/schema";

type AddressFields = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

type BankFields = {
  account_holder?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  swift?: string | null;
  iban?: string | null;
  ach_routing?: string | null;
  fedwire_routing?: string | null;
  branch_address?: string | null;
};

export type DisplayOverrides = {
  business?: {
    name?: string | null;
    legal_name?: string | null;
    tax_id?: string | null;
    contact_name?: string | null;
    evm_wallet_address?: string | null;
    starknet_wallet_address?: string | null;
    aptos_wallet_address?: string | null;
    logo_url?: string | null;
    address?: AddressFields | null;
    bank_details?: BankFields | null;
  };
  client?: {
    name?: string | null;
    contact_name?: string | null;
    email?: string | null;
    address?: AddressFields | null;
  };
};

export const PAYMENT_METHODS = ["bank", "crypto_wallet", "private_pay"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(s: string): s is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(s);
}

/**
 * Returns true iff a given rail should be displayed for this invoice. NULL
 * acceptedPaymentMethods means "no gate set, show everything" (legacy).
 */
export function paymentMethodEnabled(
  invoice: Pick<Invoice, "acceptedPaymentMethods">,
  method: PaymentMethod,
): boolean {
  const list = invoice.acceptedPaymentMethods;
  if (list == null) return true;
  return list.includes(method);
}

/**
 * Pick override > snapshot > live. `hasOverrideKey` distinguishes "key absent"
 * (fall through) from "key present with null value" (explicitly hide).
 */
export function pickField<T>(
  overrideContainer: Record<string, unknown> | undefined,
  key: string,
  snapshotValue: T | null | undefined,
  liveValue: T | null | undefined,
): T | null {
  if (overrideContainer && key in overrideContainer) {
    return (overrideContainer[key] as T | null) ?? null;
  }
  if (snapshotValue !== null && snapshotValue !== undefined) return snapshotValue;
  return liveValue ?? null;
}
