ALTER TABLE "users" ADD COLUMN "plan" "business_plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "plan";--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "stripe_subscription_id";