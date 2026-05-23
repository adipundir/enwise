-- Defense-in-depth constraints so wallets and bank accounts can never
-- get swapped at the DB level, even by a raw SQL caller that bypasses
-- the app and the library layer.
--
-- (1) businesses.wallet_address must be a raw EVM address (0x + 40 hex)
--     or a plausible ENS name (labels separated by dots, ending in .eth).
--     Anything else is rejected — bank account numbers, IBANs, free text.
--
-- (2) business_bank_accounts.account_number must NOT be an EVM address.
--     Wallets belong on businesses.wallet_address, not stuffed into a
--     bank row that then renders as "Account number: 0x…" on invoices.

ALTER TABLE "businesses" DROP CONSTRAINT IF EXISTS "businesses_wallet_shape_chk";
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_wallet_shape_chk"
  CHECK (
    wallet_address IS NULL
    OR wallet_address = ''
    OR wallet_address ~ '^0x[a-fA-F0-9]{40}$'
    OR wallet_address ~* '^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$'
  );
--> statement-breakpoint
ALTER TABLE "business_bank_accounts" DROP CONSTRAINT IF EXISTS "bank_accounts_account_number_not_wallet_chk";
--> statement-breakpoint
ALTER TABLE "business_bank_accounts" ADD CONSTRAINT "bank_accounts_account_number_not_wallet_chk"
  CHECK (
    account_number IS NULL
    OR account_number !~ '^0x[a-fA-F0-9]{40}$'
  );
