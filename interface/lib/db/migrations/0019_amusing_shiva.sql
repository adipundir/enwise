ALTER TABLE "invoices" ADD COLUMN "display_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "accepted_payment_methods" text[];