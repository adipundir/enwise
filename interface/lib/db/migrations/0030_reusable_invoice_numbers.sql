-- Make the per-business invoice-number uniqueness partial so a soft-deleted
-- invoice no longer reserves its number. Hard delete is the norm now, but
-- legacy soft-deleted rows were still occupying the unique slot (and being
-- counted by the availability check), which "burned" their numbers: they
-- showed as gaps in list_invoices but couldn't be reused. With the partial
-- index, only live (deleted_at IS NULL) invoices reserve a number.
DROP INDEX "invoices_business_number_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_business_number_idx" ON "invoices" USING btree ("business_id","invoice_number") WHERE "invoices"."deleted_at" is null;
