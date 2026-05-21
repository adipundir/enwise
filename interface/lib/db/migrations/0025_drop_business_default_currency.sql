-- Drop businesses.default_currency. Currency is now a client-only
-- concept (clients.default_currency) plus per-invoice override.
--
-- Code-deploy order rule applies: this column must be dropped AFTER
-- the new code is live, because the previous code path had
-- `business.default_currency` as the final fallback in invoice
-- creation. The new code rejects create_invoice with
-- `currency_required` instead, so the column is unused on the
-- application side before this migration runs.

ALTER TABLE "businesses" DROP COLUMN IF EXISTS "default_currency";
