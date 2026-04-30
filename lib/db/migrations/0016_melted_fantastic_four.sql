CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"payment_method" text NOT NULL,
	"payer_address" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "railgun_zk_address" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "railgun_viewing_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "railgun_chain_id" integer;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "railgun_setup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_tx_idx" ON "invoice_payments" USING btree ("chain_id","tx_hash");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("invoice_id");