-- Multi-chain wallets on businesses, plus matching invoice snapshots.
-- The previous single wallet_address column was de-facto EVM-only and
-- became a bottleneck once Starknet and Aptos USDC support entered scope.
-- All three chains have native (Circle-issued) USDC.
--
-- New columns per business:
--   evm_wallet_address      — raw 0x + 40 hex, or *.eth ENS
--   starknet_wallet_address — raw 0x + up to 64 hex, or *.stark
--   aptos_wallet_address    — raw 0x + up to 64 hex, or *.apt
--
-- Same three on invoices as immutable snapshots captured at finalize.
--
-- Data migration: every existing wallet_address value is, by virtue of the
-- 0027 CHECK constraint, either a valid EVM 0x address or a *.eth ENS. So
-- old wallet_address → new evm_wallet_address is a safe straight copy.
-- Same for invoices.business_wallet_address_snapshot.
--
-- Constraints drop / re-add at the end so existing rows aren't blocked
-- during the data migration.

-- 1. Add new columns nullable, no constraints yet.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "evm_wallet_address" text;
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "starknet_wallet_address" text;
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "aptos_wallet_address" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "business_evm_wallet_address_snapshot" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "business_starknet_wallet_address_snapshot" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "business_aptos_wallet_address_snapshot" text;
--> statement-breakpoint

-- 2. Copy old data into the new EVM column. Existing wallet_address values
--    are all EVM-format (enforced by 0027), so this is a 1:1 copy.
UPDATE "businesses"
  SET "evm_wallet_address" = "wallet_address"
  WHERE "wallet_address" IS NOT NULL;
--> statement-breakpoint
UPDATE "invoices"
  SET "business_evm_wallet_address_snapshot" = "business_wallet_address_snapshot"
  WHERE "business_wallet_address_snapshot" IS NOT NULL;
--> statement-breakpoint

-- 3. Drop the old single-wallet CHECK constraint and the old column.
ALTER TABLE "businesses" DROP CONSTRAINT IF EXISTS "businesses_wallet_shape_chk";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN IF EXISTS "wallet_address";
--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "business_wallet_address_snapshot";
--> statement-breakpoint

-- 4. Add per-chain CHECK constraints. EVM matches 40-hex 0x or *.eth.
--    Starknet / Aptos match 1..64-hex 0x or chain-specific name suffix.
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_evm_wallet_shape_chk"
  CHECK (
    evm_wallet_address IS NULL
    OR evm_wallet_address = ''
    OR evm_wallet_address ~ '^0x[a-fA-F0-9]{40}$'
    OR evm_wallet_address ~* '^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$'
  );
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_starknet_wallet_shape_chk"
  CHECK (
    starknet_wallet_address IS NULL
    OR starknet_wallet_address = ''
    OR starknet_wallet_address ~ '^0x[0-9a-fA-F]{1,64}$'
    OR starknet_wallet_address ~* '^[a-z0-9-]+(\.[a-z0-9-]+)*\.stark$'
  );
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_aptos_wallet_shape_chk"
  CHECK (
    aptos_wallet_address IS NULL
    OR aptos_wallet_address = ''
    OR aptos_wallet_address ~ '^0x[0-9a-fA-F]{1,64}$'
    OR aptos_wallet_address ~* '^[a-z0-9-]+(\.[a-z0-9-]+)*\.apt$'
  );
