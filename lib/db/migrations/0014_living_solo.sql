ALTER TABLE "businesses" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "wallet_address" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "wallet_address" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "client_wallet_address_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "business_contact_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "business_wallet_address_snapshot" text;