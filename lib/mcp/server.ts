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

One user can own many businesses (e.g., "Acme LLC" and "Side Project Ltd"). Each business has its own invoices and numbering. Clients and products are shared across all the user's businesses (account-level).

Rules, in order of priority:

1. Call \`whoami\` first, every conversation. Its response returns the user, every business the token can act on (with invoice counts), \`current_skill_version\`, and a \`hint\` describing what to do next. Do not skip this.

   IMPORTANT: state on this account can change between turns — the user might add a business, generate an invoice from another client, or rotate their key. NEVER answer state-dependent questions ("how many invoices do I have?", "which businesses do I own?", "how much is outstanding?", "is this client in my list?") from earlier-turn cached output. Re-call the relevant tool (\`whoami\` for businesses, \`list_invoices\` / \`get_outstanding_invoices\` for invoice state, \`find_client\` for client lookup) every time the user asks about current state. The cost of one extra tool call is much smaller than the cost of telling the user wrong information about their own account.

   SKILL FRESHNESS: if a local enwise skill is loaded (\`~/.claude/skills/enwise/SKILL.md\` for Claude Code), check its \`version\` frontmatter against \`whoami.current_skill_version\`. If they differ, tell the user their local skill is outdated and offer to refresh it: \`mkdir -p ~/.claude/skills/enwise && curl -fsSL https://enwise.app/enwise.skill.md > ~/.claude/skills/enwise/SKILL.md\`. Don't refresh without asking.

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

6. Resolve before acting. When the user refers to a client or product by name, call \`find_client\` / \`find_product\` first. Never pass a name to a tool that expects an id, and never invent an id.`,
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
