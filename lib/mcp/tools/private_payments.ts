import { z } from "zod";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import { setupPrivatePayments } from "@/lib/railgun/onboard";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const setupInput = {
  business_id: z.string().uuid().optional(),
  /**
   * Mnemonic-once safety latch. Forces the caller (Claude) to acknowledge
   * that the 12-word recovery phrase is shown exactly once and we never
   * persist it. Without this we'd risk users skimming past the warning and
   * losing spending power on their shielded balance.
   */
  acknowledge_one_time_phrase: z.literal(true, {
    message:
      "Pass `acknowledge_one_time_phrase: true` to confirm the user understands the recovery phrase is shown ONCE and must be saved offline.",
  }),
};

export function registerPrivatePaymentTools(server: McpServer) {
  server.registerTool(
    "setup_private_payments",
    {
      title: "Enable RAILGUN private payments for this business",
      description:
        "One-time setup that mints a RAILGUN shielded wallet on Ethereum mainnet for the business. After this, the invoice share page will show a 'Pay privately' button on USD invoices, letting clients pay USDC into a shielded balance only the business can see.\n\n" +
          "Returns a 12-word BIP-39 recovery phrase (`mnemonic`) that grants spending power over the shielded balance. CRITICAL: it is shown EXACTLY ONCE and we do NOT persist it. Relay it verbatim to the user with a clear instruction to write it down offline (paper, password manager) before continuing. Loss of the mnemonic = loss of all funds in the shielded wallet.\n\n" +
          "The `zk_address` (0zk1q…) returned can be safely shared and is what gets printed on invoices. It's immutable once set; re-running this tool returns the existing address without minting a new wallet.\n\n" +
          "Required: pass `acknowledge_one_time_phrase: true` to confirm to the user that the phrase must be saved before moving on.",
      inputSchema: setupInput,
    },
    async (args, extra) => {
      const parsed = z.object(setupInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;

      const result = await setupPrivatePayments(scope.scoped);
      if (!result.ok) {
        return toolError("internal_error", result.message, {
          hint: result.hint,
        });
      }
      if (result.alreadySetUp) {
        return toolOk({
          already_set_up: true,
          zk_address: result.zkAddress,
          chain_id: result.chainId,
          message:
            "Private payments are already enabled for this business. The recovery phrase was returned at first setup and is not retrievable.",
        });
      }
      return toolOk({
        already_set_up: false,
        zk_address: result.zkAddress,
        chain_id: result.chainId,
        mnemonic: result.mnemonic,
        warning:
          "This 12-word phrase is shown ONCE. Write it down offline (paper or password manager) before continuing. Losing it means losing access to any USDC paid into the shielded wallet.",
      });
    },
  );
}
