ALTER TABLE "businesses" DROP COLUMN "private_settlement_wallet";--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "private_enabled_at";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_enabled";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_recipient_ct";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_note_id";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_chain_id";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_shield_tx_hash";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "private_unshield_tx_hash";