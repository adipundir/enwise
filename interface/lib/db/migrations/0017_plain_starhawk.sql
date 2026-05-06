ALTER TABLE "businesses" ADD COLUMN "private_settlement_wallet" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "private_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_recipient_ct" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_note_id" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_chain_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_shield_tx_hash" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_unshield_tx_hash" text;