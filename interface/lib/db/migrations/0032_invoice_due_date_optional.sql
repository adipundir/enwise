-- Due date becomes optional. Merchants can now create or update an invoice
-- with no due date at all (create_invoice / update_invoice accept
-- due_date: null). Existing rows are unaffected; NULL just means "no due
-- date" going forward, resolved live everywhere due_date is displayed or
-- used for overdue calculations.
ALTER TABLE "invoices" ALTER COLUMN "due_date" DROP NOT NULL;
