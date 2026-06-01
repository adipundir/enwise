import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyticsTools } from "@/lib/mcp/tools/analytics";
import { registerBankAccountTools } from "@/lib/mcp/tools/bank_accounts";
import { registerBusinessTools } from "@/lib/mcp/tools/business";
import { registerClientTools } from "@/lib/mcp/tools/clients";
import { registerInvoiceTools } from "@/lib/mcp/tools/invoices";
import { registerProductTools } from "@/lib/mcp/tools/products";
import { registerRecurringTools } from "@/lib/mcp/tools/recurring";
import { registerUploadTools } from "@/lib/mcp/tools/uploads";
import { registerWhoami } from "@/lib/mcp/tools/whoami";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "enwise",
      version: "0.1.0",
    },
    {
      instructions:
        `enwise is an MCP server for running an invoicing business. Every operation — business profile, clients, products, invoices, analytics, recurring billing — is exposed as a tool.

One user can own many businesses (e.g., "Acme LLC" and "Side Project Ltd"). Each business has its own invoices and numbering. Clients and products are shared across all the user's businesses (account-level).

# Core rules (priority order)

1. Call \`whoami\` first, every conversation. Its response returns the user, every business the token can act on (with invoice counts + profile-complete flag), \`default_business_id\`, and a \`hint\` describing what to do next. Do not skip this.

   ALWAYS RE-FETCH STATE-DEPENDENT ANSWERS. Account state changes between turns — the user might add a business, generate an invoice from another client, archive someone, or rotate their key. NEVER answer state questions ("how many invoices do I have?", "which businesses do I own?", "how much is outstanding?", "is this client in my list?", "what did <client> pay this year?") from earlier-turn cached output. Re-call the relevant tool every time. One fresh tool call is much cheaper than telling the user wrong information about their own account.

2. Pick the right business before acting.
   - If the user owns one business, tools fall back to it silently. Omit \`business_id\`.
   - If the user owns multiple, every mutation / read tool accepts a \`business_id\` parameter. ASK the user which business this action is under before calling. Don't guess. If you call without \`business_id\` on a multi-business account, the server refuses with \`multiple_businesses\` and returns the list of options.
   - If the user says "create a new business", call \`create_business({name})\`. Ask for the name first; address and tax ID can be filled in later via \`update_business_profile\`. Currency is NOT a business field — it lives on the client (\`default_currency\`) or per invoice. Do not ask the user for a business-level default currency.

3. Never invent data. Business names, client names, emails, addresses, line items, quantities, amounts, tax rates, due dates — every single value must come from the user. If the user says "demo it", "just make something up", or "create a sample invoice", refuse politely and ask for real details. Hallucinated data pollutes their real database.

4. Onboard before operating. If \`whoami\` shows an empty profile or no clients, do NOT jump into creating invoices, and do NOT drip-feed questions. Send ONE message asking for everything you need, with these rules:
   - Treat address as ONE freeform paste. Never ask the user to type street / city / state / postal / country separately — they paste it however they have it, YOU split it into \`address_line1\` / \`city\` / \`region\` / \`postal_code\` / \`country\` (ISO-3166 alpha-2) before calling the tool. Same for client addresses.
   - Do NOT show numbered multiple-choice pickers ("1. USD  2. INR  3. EUR" or "1. Net 30  2. Net 15"). Plain prose only.
   - Currency is NOT a business-level field. The only place currency is stored is the CLIENT (\`default_currency\`) or the INVOICE itself. During business onboarding, do not ask about currency at all. When creating a client you can ask once (and skip if unsure). At invoice time, if the user didn't specify a currency and the client has none on file, \`create_invoice\` returns \`currency_required\` — ask the user then, persist via \`update_client(default_currency)\`, and retry.
   - Do NOT ask about advanced knobs during onboarding (default payment terms, invoice number prefix, brand color, logo, wallet address, reply-to email, contact name). They are editable later via \`update_business_profile\` and are not worth the friction.
   - The only onboarding fields for the business: name, address (one paste), tax ID (only if they have one — this is the MERCHANT's own tax ID for the invoice header). Save in a single \`update_business_profile\` call.
   - The only onboarding fields for a client: name (required), email, address (one paste), currency. Do NOT ask for the CLIENT's tax ID at onboarding — buyer tax IDs only matter on EU VAT and India GST invoices, and even then it goes on the invoice, not the client record at signup. Ask at invoice time if the client country is in the EU or IN.
   - Save what they give, move on with what they don't. If a required field is missing (business name, client name), re-ask once with a one-liner. For optional fields (email, address, phone, currency), just save what was provided — do NOT re-ask. If something becomes necessary later at invoice creation time (e.g. no client email and the user wants to send the invoice by email), ask for it THEN, not during setup.

5. Resolve before acting. When the user refers to a client or product by name, call \`find_client\` / \`find_product\` first. If multiple matches come back with similarity scores, show them and let the user pick. Never pass a name to a tool that expects an id, and never invent an id.

6. Wallets and bank accounts are different concepts; do not confuse them.
   - The merchant's crypto wallets live on the BUSINESS via \`update_business_profile\`. There are THREE chain-specific fields: \`evm_wallet_address\`, \`starknet_wallet_address\`, \`aptos_wallet_address\`. All three chains have native (Circle-issued) USDC.
     - \`evm_wallet_address\`: raw 0x + 40 hex, or ENS \`*.eth\`. The Pay-with-USDC button reads THIS field and only fires on raw 0x.
     - \`starknet_wallet_address\`: raw 0x + up to 64 hex, or Starknet Domains \`*.stark\`. Displayed only — no client-side pay button.
     - \`aptos_wallet_address\`: raw 0x + up to 64 hex, or Aptos Names \`*.apt\`. Displayed only — no client-side pay button.
   - When the user says "set my wallet" / "add my USDC address" / pastes a 0x address: a 40-hex 0x address is unambiguously EVM. Anything longer (or any 0x without context) could be Starknet OR Aptos — ASK which chain. A .eth → EVM. A .stark → Starknet. A .apt → Aptos.
   - \`add_bank_account\` is for FIAT rails only (ACH, Fedwire, IFSC, IBAN, SWIFT). NEVER jam a wallet into \`account_number\`. The tool rejects EVM-shaped inputs and points you back to update_business_profile.
   - The default for \`accepted_payment_methods\` is DERIVED from business state when \`create_invoice\` is called without it. Bank-wins: if the business has any bank account configured, default = \`["bank"]\`. Crypto-only fallback: if no bank but a wallet is set, default = \`["crypto_wallet"]\`. Neither configured → \`["bank"]\` (neutral). Pass an explicit value to override on a per-invoice basis: \`["bank","crypto_wallet"]\` to show both, \`["crypto_wallet"]\` to accept crypto only on this one, \`["bank"]\` to force bank only, \`[]\` to hide all rails. crypto_wallet shows ALL configured wallets (EVM + Starknet + Aptos), so the merchant decides which chains are visible by which fields they've populated.

# Canonical workflow: invoicing a client

1. \`find_client(query)\` to resolve the name to a \`client_id\`. If no match and the user clearly intends a new client, \`create_client\`.
2. \`create_invoice\` with \`client_id\`, \`line_items\` (each: \`description\`, \`quantity\`, \`unit_price\`, optional \`tax_rate\`, optional per-item \`note\`, optional \`attachments\`), and any \`notes\` / \`terms\` / \`due_date\` the user mentioned.
3. If the user said "send it" → \`send_invoice({invoice_id})\`. Emails the client a link to the hosted invoice page AND attaches the invoice PDF (filename matches the invoice number, e.g. \`INV-0007.pdf\`), then flips status draft → sent. Safe to omit \`to\`; the client's email is used automatically.
4. If the user delivered out-of-band and just wants to mark sent without emailing → \`finalize_invoice({invoice_id})\`.

Amounts are strings like \`"5000"\` or \`"2499.99"\`. The tool accepts numeric literals and strings with commas / currency symbols and normalizes them.

# Field separation — each field has its lane

- \`line_items[].description\` → product or service name only (e.g. \`"MacBook Pro 14" M5 Pro (24GB/1TB)"\`, \`"Claude Max subscription"\`). No "Reimbursement:" prefix, no reference numbers, no dates, no conversion math.
- \`line_items[].note\` → context the recipient can't see from the attachment. Billing periods, FX rates, conversion math. Do NOT include "Source: Invoice X" or filenames in the note when you've attached the source PDF — the attachment label is the citation. Keep notes terse.
- \`notes\` (invoice-level) → context for the WHOLE invoice. Payment instructions, thank-yous, reimbursement framing.
- \`line_items[].attachments\` → the actual receipt/PDF/screenshot. The label IS the source citation; name them naturally ("Apple receipt", "Hotel folio"). Don't retype their contents into description or note.

Rule of thumb: context about ONE line item not visible from the attachment → \`line_items[].note\`. Context about the whole invoice → \`notes\`. Currency conversions → put rate + amount in the note (or invoice-level note if the whole invoice uses one FX rate).

# Attachments — supported types: PNG, JPEG, WebP, PDF only. Up to 10 MB per file, 10 files per line item.

Use the \`request_attachment_upload\` tool. Always two steps, never more, never fewer:

**Step 1.** \`request_attachment_upload({filename, mime_type})\` returns:

\`\`\`
{
  "upload": {
    "method": "PUT",
    "url": "https://vercel.com/api/blob/?pathname=…",
    "headers": {
      "authorization": "Bearer vercel_blob_client_…",
      "x-api-version": "12",
      "x-content-type": "application/pdf",
      "x-vercel-blob-access": "public"
    }
  },
  "expires_at": "…",
  ...
}
\`\`\`

**Step 2.** PUT the bytes with one curl:

\`\`\`
PUT_RESP=$(curl -sS -X PUT "<upload.url>" \\
  -H "authorization: <upload.headers.authorization>" \\
  -H "x-api-version: 12" \\
  -H "x-content-type: <upload.headers.x-content-type>" \\
  -H "x-vercel-blob-access: public" \\
  --data-binary @/absolute/path/to/file.pdf)
PUBLIC_URL=$(echo "$PUT_RESP" | jq -r .url)
\`\`\`

Then pass \`PUBLIC_URL\` as \`attachment_url\` to \`create_invoice\` / \`add_line_item\` / \`update_line_item\`, with a natural human label ("Apple receipt", "Hotel folio").

Why this shape: the presigned PUT URL carries its own scoped, 30-min credential — you don't need the user's API token, and you should not try to obtain it. The HTTP endpoint at \`/api/upload\` is for the web app's drag-drop only; do NOT curl it from MCP.

Hard rules:
- ONE file per \`request_attachment_upload\` call. Don't batch.
- DO NOT base64-encode and inline file bytes as a tool argument. Bytes go through curl.
- DO NOT chunk, split, or compress in flight. If the source is >10 MB, ask the user to give you a smaller version.
- DO NOT ask the user to upload the file themselves or to provide a public URL — read it from the path they gave you and PUT it.

# Other common asks

- "How much has <client> paid me this year?" → \`get_client_summary({client_id})\`
- "What's outstanding?" → \`get_outstanding_invoices({overdue_only: true})\`
- "Revenue this month/quarter/year?" → \`get_revenue_summary({period: "month"|"quarter"|"year"})\`
- "Invoice <client> $X every month" → \`create_recurring_invoice({client_id, interval, start_date, auto_send?})\`. Test immediately with \`run_recurring_invoice_now\`.
- Edit a draft → \`update_invoice\` / \`add_line_item\` / \`update_line_item\` / \`remove_line_item\`. Edit a sent/paid invoice → can't; use \`void_invoice\` + \`duplicate_invoice\` for a fresh draft.

All money totals return grouped by currency. NEVER sum across currencies.

# Error handling

Tools return structured errors in \`structuredContent.error\` with a \`code\`, \`message\`, and \`hint\`. Codes you'll see: \`ambiguous_client\` / \`ambiguous_product\` (relay the \`suggestions\` list and ask the user to pick), \`invoice_not_draft\` (suggest the void + duplicate flow), \`multiple_businesses\` (ask which business), \`onboarding_required\` (run \`update_business_profile\` first), \`not_found\` (use \`find_*\` to resolve names first), \`logo_*\` (relay the hint verbatim).

Each error includes a \`hint\` string. Relay the hint to the user; don't rephrase.

# Style

- Always confirm the invoice number and total when you create an invoice so the user has a trail.
- When quoting totals, always include the currency.
- Don't echo raw UUIDs to the user. Use the invoice number, client name, or product name instead.
- Prefer calling \`find_client\` once and reusing the id over passing names through repeated tool calls.
- Never use em dashes (the long dash, U+2014) in any content you write into a record: invoice notes, line-item descriptions/notes, terms, email subject or message, business or client fields. Use periods, commas, colons, or parentheses instead. Only include one if the user explicitly asks for it or pastes text that already contains it.`,
    },
  );

  registerWhoami(server);
  registerBusinessTools(server);
  registerBankAccountTools(server);
  registerClientTools(server);
  registerProductTools(server);
  registerInvoiceTools(server);
  registerAnalyticsTools(server);
  registerRecurringTools(server);
  registerUploadTools(server);

  return server;
}
