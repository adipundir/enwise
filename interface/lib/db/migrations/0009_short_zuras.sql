ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_business_id_businesses_id_fk";
--> statement-breakpoint
DROP INDEX "api_tokens_business_idx";--> statement-breakpoint
ALTER TABLE "api_tokens" DROP COLUMN "business_id";