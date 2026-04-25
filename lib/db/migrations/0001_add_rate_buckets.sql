CREATE TABLE "rate_buckets" (
	"token_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_buckets_token_id_window_start_pk" PRIMARY KEY("token_id","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_buckets_window_idx" ON "rate_buckets" USING btree ("window_start");