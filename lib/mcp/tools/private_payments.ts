import { z } from "zod";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import { setupPrivatePayments } from "@/lib/railgun/onboard";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const setupInput = {
  business_id: z.string().uuid().optional(),
};

export function registerPrivatePaymentTools(server: McpServer) {
  server.registerTool(
    "setup_private_payments",
    {
      title: "Enable RAILGUN private payments for a business",
      description:
        "Mints a fresh shielded RAILGUN wallet for a business. After this, USD invoices issued by the business show a 'Pay privately' button on the share page that lets clients pay USDC into a shielded balance only the business can see.\n\n" +
          "## What this returns\n\n" +
          "On first call: `{already_set_up: false, zk_address, mnemonic, chain_id}`. The 12-word `mnemonic` is the RECOVERY PHRASE — it is the only way to spend the shielded balance, and it is generated fresh on the server and **never persisted**. Once this tool returns, that mnemonic exists in exactly one place: this conversation.\n\n" +
          "On re-run: `{already_set_up: true, zk_address, chain_id}` — no mnemonic. Wallet creation is one-shot per business.\n\n" +
          "## How to deliver the mnemonic to the user (NON-NEGOTIABLE)\n\n" +
          "When `already_set_up` is `false`, you MUST present the mnemonic to the user immediately, in this exact shape:\n\n" +
          "1. A short, urgent sentence framing the stakes. Something like:\n" +
          "   > **Save these 12 words now. They are your private spending key. We do not store them. If you lose them, any USDC paid into your shielded address is gone forever.**\n" +
          "2. The mnemonic verbatim, in a fenced code block so it copy-pastes cleanly:\n" +
          "   ```\n" +
          "   word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12\n" +
          "   ```\n" +
          "3. Explicit storage guidance: write them on paper, save them in a password manager (1Password, Bitwarden), or both. Do NOT screenshot, paste into chat tools, email, or store in plaintext on disk.\n" +
          "4. The 0zk address (`zk_address`) below the mnemonic, also in a code block, with one line saying \"This is the public address that goes on your invoices — safe to share.\"\n" +
          "5. **Tell the user how they'll spend the shielded balance**: \"To spend the USDC paid into your shielded address (unshield to a regular wallet, send privately, swap inside the privacy pool), import these 12 words into [Railway Wallet](https://railway.xyz/) — RAILGUN's official client. enwise itself is receive-only; spending happens in Railway Wallet.\"\n\n" +
          "Do NOT summarise the mnemonic. Do NOT say things like \"I've generated your recovery phrase\" without showing it. Do NOT split the words across multiple bullets or paragraphs — they have to be readable as one block. This is the only time the user will see them; if you bury, paraphrase, or omit, you lose the user's funds.\n\n" +
          "## When to call this\n\n" +
          "Only when the user explicitly asks to enable private/RAILGUN/shielded payments for a specific business. Do not call proactively as part of general onboarding. Confirm the business name before firing — re-running on the wrong business does nothing harmful (the second call returns `already_set_up: false` for it, but mints a real wallet that is hard to undo if unwanted).\n\n" +
          "## Failure modes you may see\n\n" +
          "- `internal_error` with `code: encryption_unavailable` — server's `TOKEN_ENC_KEY` env var is missing. Surface the hint verbatim; you cannot fix this from chat.\n" +
          "- `multiple_businesses` — pass `business_id` explicitly.\n",
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
            "Private payments are already enabled for this business. The recovery phrase was returned at first setup and cannot be retrieved — if the user lost it, they will need to reset (which is currently a manual operation we have not built).",
        });
      }
      return toolOk({
        already_set_up: false,
        zk_address: result.zkAddress,
        chain_id: result.chainId,
        mnemonic: result.mnemonic,
        shareable_viewing_key: result.shareableViewingKey,
        critical_instruction:
          "DELIVER THE MNEMONIC TO THE USER NOW, VERBATIM, IN A CODE BLOCK, WITH THE WARNING. See the tool description for the exact format. This is the only time it will exist; if you do not show it now, it is lost.",
        viewing_key_note:
          "`shareable_viewing_key` is the same string Railway Wallet shows under 'viewing key'. The user can paste it into another RAILGUN-compatible client to add a read-only view of this wallet (see all incoming/outgoing private payments without spending power). Mention it as a secondary, optional output AFTER the mnemonic — most users won't need it. The mnemonic is the only thing that's strictly mandatory to save.",
      });
    },
  );
}
