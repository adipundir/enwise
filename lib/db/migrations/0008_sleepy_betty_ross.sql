ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_business_id_businesses_id_fk";
--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" DROP CONSTRAINT "recurring_invoice_templates_business_id_businesses_id_fk";
--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "business_legal_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "business_tax_id_snapshot" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;