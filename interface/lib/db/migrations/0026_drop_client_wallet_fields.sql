-- Drop client wallet fields. The client's onchain identity wasn't
-- functional anywhere — it only rendered as decoration on the PDF
-- and share page, and could not gate or route any payment. The
-- merchant's wallet is what matters for USDC inflows; the client
-- side is noise.
--
-- Two columns go:
--   clients.wallet_address                  — live field on the client row
--   invoices.client_wallet_address_snapshot — frozen at finalize
--
-- Code-deploy order rule applies: new code stopped reading both
-- columns before this migration runs.

ALTER TABLE "clients" DROP COLUMN IF EXISTS "wallet_address";
--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "client_wallet_address_snapshot";
