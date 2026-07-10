-- Add beneficiary_address and upi_id to business_bank_accounts.
--
-- beneficiary_address: the account holder's street address. US/EU sending
-- banks require a beneficiary address on wire forms (OFAC screening) —
-- branch_address only covers the receiving bank's own address, which most
-- sending banks auto-fill from the SWIFT/routing lookup anyway.
--
-- upi_id: India UPI virtual payment address (VPA, e.g. "name@okhdfcbank")
-- so INR accounts can surface an instant-payment rail alongside IFSC.
--
-- Both columns are nullable and additive — existing rows are unaffected.
-- Run BEFORE deploying the code: drizzle select() enumerates every mapped
-- column, so new code against an unmigrated DB fails on bank account reads.
-- (Old code against a migrated DB is fine — it ignores extra columns.)

ALTER TABLE "business_bank_accounts" ADD COLUMN IF NOT EXISTS "beneficiary_address" text;
--> statement-breakpoint
ALTER TABLE "business_bank_accounts" ADD COLUMN IF NOT EXISTS "upi_id" text;
