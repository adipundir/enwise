-- Multi-bank-account support.
-- Migrates the seven bank_* fields on `businesses` into a new
-- business_bank_accounts table (one row per existing business that had any
-- bank data). Adds invoice columns for per-invoice account selection +
-- the array snapshot that replaces the old single-object snapshot.

-- 1. Create the new table.
CREATE TABLE "business_bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL,
  "label" text NOT NULL,
  "account_holder" text,
  "bank_name" text,
  "account_number" text,
  "ifsc" text,
  "swift" text,
  "iban" text,
  "branch_address" text,
  "currency" char(3),
  "is_default" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_bank_accounts_business_fk"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE cascade
);
--> statement-breakpoint

CREATE INDEX "business_bank_accounts_business_idx"
  ON "business_bank_accounts" ("business_id");
--> statement-breakpoint

-- At most one active default per business.
CREATE UNIQUE INDEX "business_bank_accounts_one_default_idx"
  ON "business_bank_accounts" ("business_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;
--> statement-breakpoint

-- 2. Backfill: one default account per business that had any bank field set.
INSERT INTO "business_bank_accounts"
  ("business_id", "label", "account_holder", "bank_name", "account_number",
   "ifsc", "swift", "iban", "branch_address", "is_default")
SELECT
  "id",
  'Primary',
  "bank_account_holder",
  "bank_name",
  "bank_account_number",
  "bank_ifsc",
  "bank_swift",
  "bank_iban",
  "bank_branch_address",
  true
FROM "businesses"
WHERE "bank_account_holder" IS NOT NULL
   OR "bank_name" IS NOT NULL
   OR "bank_account_number" IS NOT NULL
   OR "bank_ifsc" IS NOT NULL
   OR "bank_swift" IS NOT NULL
   OR "bank_iban" IS NOT NULL
   OR "bank_branch_address" IS NOT NULL;
--> statement-breakpoint

-- 3. New invoice columns.
ALTER TABLE "invoices" ADD COLUMN "business_bank_accounts_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "accepted_bank_account_ids" uuid[];
--> statement-breakpoint

-- 4. Migrate existing per-invoice snapshots from single object → single-element array.
UPDATE "invoices"
  SET "business_bank_accounts_snapshot" =
    jsonb_build_array(
      jsonb_set(
        "business_bank_details_snapshot",
        '{label}',
        '"Primary"',
        true
      )
    )
WHERE "business_bank_details_snapshot" IS NOT NULL;
--> statement-breakpoint

-- 5. Drop the now-redundant single-object snapshot column.
ALTER TABLE "invoices" DROP COLUMN "business_bank_details_snapshot";
--> statement-breakpoint

-- 6. Drop the seven bank_* columns from businesses (data preserved above).
ALTER TABLE "businesses" DROP COLUMN "bank_account_holder";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_name";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_account_number";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_ifsc";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_swift";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_iban";
--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "bank_branch_address";
