import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWhoami } from "@/lib/mcp/tools/whoami";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "envoice",
      version: "0.1.0",
    },
    {
      instructions:
        "envoice is an MCP server for running an invoicing business. Every operation — business profile, clients, products, invoices, analytics — is available as a tool. Call `whoami` at the start of a conversation to load the user's business profile into context before doing anything else.",
    },
  );

  registerWhoami(server);

  return server;
}
