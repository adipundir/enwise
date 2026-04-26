import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyticsTools } from "@/lib/mcp/tools/analytics";
import { registerBusinessTools } from "@/lib/mcp/tools/business";
import { registerClientTools } from "@/lib/mcp/tools/clients";
import { registerInvoiceTools } from "@/lib/mcp/tools/invoices";
import { registerProductTools } from "@/lib/mcp/tools/products";
import { registerRecurringTools } from "@/lib/mcp/tools/recurring";
import { registerWhoami } from "@/lib/mcp/tools/whoami";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "enwise",
      version: "0.1.0",
    },
    {
      instructions:
        `enwise is an MCP server for running an invoicing business. Every operation. business profile, clients, products, invoices, analytics. is exposed as a tool.

One user can own many businesses (e.g., "Acme LLC" and "Side Project Ltd"). Each business has its own clients, invoices, numbering, and branding. Plan (Free / Pro) is account-level. Pro unlocks its features across every business the user owns.

Rules, in order of priority:

1. Call \`whoami\` first, every conversation. Its response returns the user (with plan), every business the token can act on (with client/invoice counts), and a \`hint\` describing what to do next. Do not skip this.

2. Pick the right business before acting.
   - If the user owns one business, tools fall back to it silently.
   - If the user owns multiple, every mutation / read tool accepts a \`business_id\` parameter. ASK the user which business this action is under before calling. do NOT guess. When Claude invokes a tool without \`business_id\` against a multi-business account, the server refuses with \`multiple_businesses\` and returns the list of options.
   - If the user says "create a new business", call \`create_business\`. Ask for the name first; address/tax ID/currency can be filled in later via \`update_business_profile\`.

3. Never invent data. Business names, client names, emails, addresses, line items, quantities, amounts, tax rates, due dates. every single value must come from the user. If the user says "demo it", "just make something up", "create a sample invoice", or similar, refuse politely and ask for real details. Hallucinated data pollutes their real database and is almost always wrong.

4. Onboard before operating. If the chosen business has an empty profile (no address, no tax ID) or no clients, do NOT jump into creating invoices. Ask the user for:
   - Address / country
   - Default currency (if not USD)
   - Tax ID (if they have one)
   Save with \`update_business_profile\`. Only after onboarding should you create clients or invoices under that business.

5. Ask before assuming. If the user asks to invoice a client but doesn't give you the client's email, address, or line item details, ASK. Don't guess. Don't fill in placeholders.

6. Resolve before acting. When the user refers to a client or product by name, call \`find_client\` / \`find_products\` first. Pass \`business_id\` when the user owns multiple. Never pass a name to a tool that expects an id, and never invent an id.`,
    },
  );

  registerWhoami(server);
  registerBusinessTools(server);
  registerClientTools(server);
  registerProductTools(server);
  registerInvoiceTools(server);
  registerAnalyticsTools(server);
  registerRecurringTools(server);

  return server;
}
