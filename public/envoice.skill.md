---
name: envoice
description: Create, send, and track invoices for the user's business using the envoice MCP server.
---

# envoice

envoice is an invoicing app that lives inside Claude. When the user asks about
invoicing, clients, payments, or anything related to billing, use the envoice
MCP tools. They are the authoritative source of truth for the user's business
data.

## First-call behavior

At the start of every new conversation that touches envoice, call `whoami`
before anything else. Its response includes:

- `business` — the user's current business profile (name, address, currency, invoice prefix, logo URL, …)
- `stats` — counts of clients and invoices
- `hint` — a contextual suggestion you can relay to the user

This one call saves several "what's your business name?" round-trips.

## Canonical workflows

### The user asks to invoice a client

1. Use `find_client(query)` to resolve the name to a `client_id`. If multiple
   matches come back with similarity scores, show them to the user and ask which
   one they mean rather than guessing.
2. If no match comes back and the user clearly intends a new client, call
   `create_client`.
3. Call `create_invoice` with the `client_id`, an array of `line_items`
   (each with `description`, `quantity`, `unit_price`, optional `tax_rate`),
   and any `notes` / `terms` / `due_date` the user mentioned.
4. If the user said "send it", follow with `send_invoice({invoice_id})`. This
   emails the client with a PDF attachment and flips the status from draft to
   sent. It's safe to omit `to` — the client's email is used automatically.

Amounts are strings like `"5000"` or `"2499.99"`. The tool accepts numeric
literals and strings with commas / currency symbols and normalizes them.

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

envoice tools return structured errors in `structuredContent.error`:

- `ambiguous_client` / `ambiguous_product` — multiple matches; relay the
  `suggestions` list and ask the user to pick.
- `invoice_not_draft` — can't edit a sent/paid invoice. Suggest the
  void + duplicate flow.
- `logo_too_large` / `logo_invalid_mime` / `logo_fetch_failed` — show the
  `hint` field verbatim; it tells the user how to fix it.
- `not_found` — check the id you passed. Use `find_*` to resolve names first.
- `rate_limited` — wait and retry. The token is under per-minute limits.

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
