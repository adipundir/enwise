---
name: enwise
description: Create, send, and track invoices for the user's business using the enwise MCP server.
---

# enwise

enwise is an invoicing app that lives inside Claude. When the user asks about
invoicing, clients, payments, or anything related to billing, use the enwise
MCP tools. They are the authoritative source of truth for the user's business
data.

## First-call behavior

At the start of every new conversation that touches enwise, call `whoami`
before anything else. Its response includes:

- `user`. the authenticated user (name, email)
- `businesses`. every business this user owns, with plan + counts + profile-complete flag
- `default_business_id`. the user's chosen default (may be null)
- `hint`. a **directive** describing what to do next. Follow it.

## Multi-business

A user can own many businesses (e.g., "Acme LLC" and "Side Project Ltd"). Every tool that creates or reads business-scoped data takes an optional `business_id`. Rules:

- If the user owns **one** business, tools fall back to it silently. You can omit `business_id`.
- If the user owns **multiple**, ASK which business before calling any tool that creates or modifies data. Don't guess. If you call without `business_id` on a multi-business account, the server refuses with `multiple_businesses` and returns the list.
- If the user says "create a new business", call `create_business({name, default_currency?})`. Name is required; everything else can be filled in later via `update_business_profile`.

## Never invent data

Business name, client names, emails, addresses, line items, quantities, amounts,
tax rates, due dates. every value must come from the user. If the user says
"demo it", "just make something up", or "create a sample invoice", refuse
politely and ask for real details. Hallucinated data pollutes a real database
and is almost always wrong.

## Onboarding

If `whoami` shows the profile is empty (no address, no tax ID) or there are no
clients, **do not jump into creating invoices**. Ask the user for:

1. Business name (is the current one correct?)
2. Address + country
3. Default currency (USD if unspecified)
4. Tax ID if they have one

Save with `update_business_profile`. Only after onboarding should you create
clients or invoices.

## Canonical workflows

### The user asks to invoice a client

1. Use `find_client(query)` to resolve the name to a `client_id`. If multiple
   matches come back with similarity scores, show them to the user and ask which
   one they mean rather than guessing.
2. If no match comes back and the user clearly intends a new client, call
   `create_client`.
3. Call `create_invoice` with the `client_id`, an array of `line_items`
   (each with `description`, `quantity`, `unit_price`, optional `tax_rate`,
   optional per-item `note`, optional `attachments`), and any `notes` /
   `terms` / `due_date` the user mentioned.
4. If the user said "send it", follow with `send_invoice({invoice_id})`. This
   emails the client a link to the hosted invoice page (with a Download PDF
   button) and flips the status from draft to sent. No attachment is sent ,
   modern email clients auto-preview PDFs and make the email feel cluttered.
   It's safe to omit `to`. the client's email is used automatically.
5. If the user wants to mark an invoice as sent WITHOUT emailing (e.g. they
   delivered it out-of-band), call `finalize_invoice({invoice_id})`.

Amounts are strings like `"5000"` or `"2499.99"`. The tool accepts numeric
literals and strings with commas / currency symbols and normalizes them.

## Writing style. each field has its own lane

- `line_items[].description` → product or service name only (e.g. `"MacBook Pro 14" M5 Pro (24GB/1TB)"`, `"Claude Max subscription"`). No `"Reimbursement:"` prefix, no reference numbers, no dates, no conversion math.
- `line_items[].note` → context the recipient can't see from the attachment. Billing periods, FX rates, conversion math. **Do NOT include `"Source: Invoice X"` or filenames in the note when you've attached the source PDF. the attachment label is the citation. Repeating it is noise.** Keep notes terse, single-line when possible.
- `notes` (invoice-level) → context for the WHOLE invoice. payment instructions, thank-yous, reimbursement framing when the entire invoice is one thing.
- `line_items[].attachments` → the actual receipt/PDF/screenshot. The label is the source citation. name them naturally (`Apple receipt`, `Hotel folio`). Don't retype their contents into the description or note.

Rule of thumb: context about ONE line item that isn't visible from the attachment → `line_items[].note`. Context about the whole invoice → `notes`. Currency conversions → put the rate + amount in the note (or in the invoice-level note if the whole invoice uses one FX rate).

## Attachments

Each line item can carry supporting files. Pass as base64 only:

- `{ file_base64: "…", mime_type: "image/png" | "image/jpeg" | "image/webp" | "application/pdf", filename?: "receipt.pdf", label?: "Hotel receipt" }`

8 MB per file, 10 files per line item. They're uploaded to our own storage so the invoice stays self-contained. no URL passthrough (matches how Stripe, QuickBooks, and Xero handle invoice evidence). Attachments render on both the PDF and the public invoice page.

### The user asks about money owed or earned

- "How much has <client> paid me this year?" → `get_client_summary({client_id})`
- "What's outstanding?" → `get_outstanding_invoices({overdue_only: true})`
- "Revenue this month/quarter/year?" → `get_revenue_summary({period: "month"|"quarter"|"year"})`

All of these return totals grouped by currency. Never sum across currencies.

### The user wants to set up shop

If `whoami` shows empty client/invoice counts, the user probably just
connected. Offer to help fill in the business profile:

- "Do you want me to fill in your business address and tax ID?" →
  `update_business_profile({...})`
- Logo: accept a public URL and pass it as `logo: { image_url: "https://…" }`.
  For base64 uploads pass `logo: { image_base64, mime_type: "image/png" }`.

### The user wants recurring invoices

- "Invoice <client> $X every month" → `create_recurring_invoice` with
  `interval: "monthly"`, `start_date` in YYYY-MM-DD, `auto_send: true` if they
  want emails sent automatically on each run.
- To test immediately without waiting for the cron: `run_recurring_invoice_now`.

### The user wants to void, duplicate, or correct an invoice

- Draft invoices are fully editable. Use `update_invoice` or the
  `add_line_item` / `update_line_item` / `remove_line_item` helpers.
- Sent / paid invoices are frozen. To make changes, call `void_invoice`
  followed by `duplicate_invoice` to create a fresh draft with the same line
  items.

## Error handling

enwise tools return structured errors in `structuredContent.error`:

- `ambiguous_client` / `ambiguous_product`. multiple matches; relay the
  `suggestions` list and ask the user to pick.
- `invoice_not_draft`. can't edit a sent/paid invoice. Suggest the
  void + duplicate flow.
- `logo_too_large` / `logo_invalid_mime` / `logo_fetch_failed`. show the
  `hint` field verbatim; it tells the user how to fix it.
- `not_found`. check the id you passed. Use `find_*` to resolve names first.

Each error includes a `hint` string. Relay the hint to the user, don't
rephrase it.

## Style

- Always confirm the invoice number and total when you create an invoice so
  the user has a trail.
- When quoting totals, always include the currency.
- Don't echo raw UUIDs to the user; use the invoice number, client name,
  or product name instead.
- Prefer calling `find_client` once and reusing the id over passing names
  through repeated tool calls.
