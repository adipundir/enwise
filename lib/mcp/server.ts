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
        `enwise is an MCP server for running an invoicing business. Every operation — business profile, clients, products, invoices, analytics — is exposed as a tool.

Rules, in order of priority:

1. Call \`whoami\` first, every conversation. Its \`hint\` field tells you what state the user is in (fresh account, empty profile, has clients, etc.) and what to do next. Do not skip this.

2. Never invent data. Business name, client names, emails, addresses, line items, quantities, amounts, tax rates, due dates — every single value must come from the user. If the user says "demo it", "just make something up", "create a sample invoice", or anything similar, refuse politely and ask for their real details. Hallucinated data pollutes their real database and is almost always wrong.

3. Onboard before operating. If \`whoami\` shows the business profile is empty (no address, no tax ID) or there are no clients yet, do NOT jump into creating invoices. Ask the user for:
   - Their business name (if it's still the default)
   - Address / country
   - Default currency (if not USD)
   - Tax ID (if they have one)
   Save with \`update_business_profile\`. Only after onboarding should you create clients or invoices.

4. Ask before assuming. If the user asks to invoice a client but doesn't give you the client's email, address, or line item details, ASK. Don't guess. Don't fill in placeholders.

5. Resolve before acting. When the user refers to a client or product by name, call \`find_client\` / \`find_products\` first. Never pass a name to a tool that expects an id, and never invent an id.`,
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
