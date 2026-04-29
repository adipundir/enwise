ALTER TABLE "clients" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "client_contact_name_snapshot" text;