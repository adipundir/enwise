ALTER TABLE "users" DROP COLUMN "plan";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "stripe_subscription_id";--> statement-breakpoint
DROP TYPE "public"."business_plan";