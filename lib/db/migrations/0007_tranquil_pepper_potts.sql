-- Resources go from per-business to per-user (account-level) ownership.
-- Strategy: add nullable owner_user_id, backfill via JOIN, then NOT NULL.

-- 1) Drop FKs/indexes that reference business_id where ownership semantic moves.
ALTER TABLE "clients" DROP CONSTRAINT "clients_business_id_businesses_id_fk";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_business_id_businesses_id_fk";--> statement-breakpoint
DROP INDEX "clients_business_idx";--> statement-breakpoint
DROP INDEX "clients_business_email_idx";--> statement-breakpoint
DROP INDEX "invoices_business_status_date_idx";--> statement-breakpoint
DROP INDEX "invoices_business_client_date_idx";--> statement-breakpoint
DROP INDEX "products_business_idx";--> statement-breakpoint
DROP INDEX "products_business_sku_idx";--> statement-breakpoint
DROP INDEX "invoices_idempotency_idx";--> statement-breakpoint

-- 2) businessId becomes nullable on clients/products (now a hint, not the
-- primary owner).
ALTER TABLE "clients" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint

-- 3) Add owner_user_id columns as NULLABLE so we can backfill before
-- enforcing NOT NULL.
ALTER TABLE "clients" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint

-- 4) Backfill from businesses.owner_user_id.
UPDATE "clients" c
   SET "owner_user_id" = b."owner_user_id"
  FROM "businesses" b
 WHERE c."business_id" = b."id";--> statement-breakpoint

UPDATE "invoices" i
   SET "owner_user_id" = b."owner_user_id"
  FROM "businesses" b
 WHERE i."business_id" = b."id";--> statement-breakpoint

UPDATE "products" p
   SET "owner_user_id" = b."owner_user_id"
  FROM "businesses" b
 WHERE p."business_id" = b."id";--> statement-breakpoint

UPDATE "recurring_invoice_templates" r
   SET "owner_user_id" = b."owner_user_id"
  FROM "businesses" b
 WHERE r."business_id" = b."id";--> statement-breakpoint

-- 5) Enforce NOT NULL now that every row has a value.
ALTER TABLE "clients" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint

-- 6) Re-add FKs.
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 7) Owner-scoped indexes.
CREATE INDEX "clients_owner_idx" ON "clients" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_owner_email_idx" ON "clients" USING btree ("owner_user_id",lower("email")) WHERE "clients"."email" is not null;--> statement-breakpoint
CREATE INDEX "invoices_owner_idx" ON "invoices" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "invoices_owner_status_date_idx" ON "invoices" USING btree ("owner_user_id","status","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_owner_client_date_idx" ON "invoices" USING btree ("owner_user_id","client_id","issue_date");--> statement-breakpoint
CREATE INDEX "products_owner_idx" ON "products" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_owner_sku_idx" ON "products" USING btree ("owner_user_id","sku") WHERE "products"."sku" is not null;--> statement-breakpoint
CREATE INDEX "recurring_owner_idx" ON "recurring_invoice_templates" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_idempotency_idx" ON "invoices" USING btree ("owner_user_id","client_request_id") WHERE "invoices"."client_request_id" is not null;
