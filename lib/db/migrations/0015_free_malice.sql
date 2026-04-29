ALTER TABLE "clients" DROP CONSTRAINT "clients_business_id_businesses_id_fk";
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_business_id_businesses_id_fk";
--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "business_id";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "business_id";