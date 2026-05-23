-- Track which email the invoice was actually delivered to, so void_invoice
-- can notify that address (not necessarily the client's primary email if
-- the merchant overrode `to` at send time). Populated by sendInvoiceByEmail
-- after a successful Resend send; null on never-sent invoices.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sent_to_email" text;
