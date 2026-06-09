-- Multi-chain payment acceptance. The payer now chooses which EVM chain to
-- pay an invoice on (Base, Arbitrum, ...), and the merchant chooses which
-- chains they accept. The same evm_wallet_address receives on every chain, so
-- no new wallet columns are needed — just the accepted-chain sets.
--
-- New columns (both nullable integer[]):
--   businesses.accepted_chain_ids — the default set the business accepts on.
--     NULL = fall back to [payment_chain_id ?? platform default].
--   invoices.accepted_chain_ids   — per-invoice override. NULL = use the
--     business set. Read live (not snapshotted), mirroring payment_chain_id.
--
-- Additive and nullable: existing single-chain merchants are unaffected (a
-- NULL set resolves to their current payment_chain_id). No backfill needed.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "accepted_chain_ids" integer[];
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "accepted_chain_ids" integer[];
