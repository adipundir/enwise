-- Add dedicated columns for US ACH and Fedwire routing numbers on
-- business_bank_accounts. These were previously squeezed into the
-- `swift` field which made invoices misleading (a US ACH routing
-- rendered as "SWIFT: 026073150").
--
-- Both columns are nullable — existing rows are unaffected and
-- merchants opt in per account.
--
-- Safe to run before or after the code deploy: the columns are
-- additive, the new code tolerates them being absent (cast as null),
-- and the old code ignores extra columns.

ALTER TABLE "business_bank_accounts" ADD COLUMN IF NOT EXISTS "ach_routing" text;
--> statement-breakpoint
ALTER TABLE "business_bank_accounts" ADD COLUMN IF NOT EXISTS "fedwire_routing" text;
