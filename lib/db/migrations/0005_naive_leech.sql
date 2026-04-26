CREATE TYPE "public"."business_plan" AS ENUM('free', 'pro');--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "plan" "business_plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;