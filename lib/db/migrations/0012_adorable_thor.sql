ALTER TABLE "businesses" ADD COLUMN "bank_account_holder" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bank_swift" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bank_iban" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "business_bank_details_snapshot" jsonb;