import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { ctxFromAuthInfo, scopeFromCtx } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import {
  buildSettlementMessage,
  newNonce,
  PROOF_TTL_MIN,
  verifySettlement,
} from "@/lib/private/wallet-proof";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const setupInput = {
  business_id: z.string().uuid().optional(),
  settlement_wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40-hex-char address"),
};

const resetInput = {
  business_id: z.string().uuid().optional(),
};

const requestProofInput = {
  business_id: z.string().uuid().optional(),
  candidate: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40-hex-char address"),
};

const confirmProofInput = {
  business_id: z.string().uuid().optional(),
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "must be a 0x-prefixed hex signature"),
};

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

export function registerPrivatePaymentTools(server: McpServer) {
  // ───── Step 1: request a signed proof ───────────────────────────────────
  server.registerTool(
    "request_settlement_wallet_proof",
    {
      title: "Step 1 of secure binding: get the message the user must sign",
      description:
        "Recommended flow for setting an settlement wallet. Returns a canonical message the user signs with the wallet they're claiming, plus a one-click signing URL. After signing, call `confirm_settlement_wallet`.\n\n" +
        "## Why this is preferred over `setup_private_payments`\n\n" +
        "`setup_private_payments` trusts whatever 0x address the user types. A typo or social-engineering attack would route real USDC to a wrong address, permanently. This proof flow makes the user sign with the wallet's private key — proves control before binding.\n\n" +
        "## How to relay the result to the user\n\n" +
        "Show **both** options. Most non-technical users prefer Option A (link); crypto-natives often prefer Option B (paste).\n\n" +
        "**Option A — one-click web flow:**\n" +
        "Send the user the `signing_url`. They open it on the device that has their wallet (phone or PC). The page connects to MetaMask / Rabby / Coinbase Wallet / etc. via window.ethereum, prompts them to sign, and persists automatically. Then come back to chat and tell me \"done\".\n\n" +
        "**Option B — manual paste flow:**\n" +
        "Show the `message` verbatim. Tell them to:\n" +
        "  1. Open MetaMask (or any wallet) → Account menu → Sign Message / Personal Sign (NOT a transaction — costs no gas).\n" +
        "  2. Paste the message.\n" +
        "  3. Sign with the wallet they want to bind.\n" +
        "  4. Copy the resulting hex signature back to me.\n" +
        "Then I'll call `confirm_settlement_wallet({ message, signature })`.\n\n" +
        `Both options expire after ${PROOF_TTL_MIN} minutes; if it lapses, request a new proof.\n\n` +
        "## Returns\n\n" +
        "`{message, signing_url, candidate, expires_at}`.",
      inputSchema: requestProofInput,
    },
    async (args, extra) => {
      const parsed = z.object(requestProofInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;

      const candidate = parsed.data.candidate.toLowerCase() as `0x${string}`;
      const issuedAt = new Date();
      const nonce = newNonce();
      const message = buildSettlementMessage({
        candidate,
        businessId: scope.scoped.businessId,
        issuedAt,
        nonce,
      });

      const expiresAt = new Date(issuedAt.getTime() + PROOF_TTL_MIN * 60_000);
      const url = new URL("/sign-settlement", publicBaseUrl());
      url.searchParams.set("m", Buffer.from(message, "utf8").toString("base64url"));

      return toolOk({
        candidate,
        message,
        signing_url: url.toString(),
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
    },
  );

  // ───── Step 2: confirm signed proof and persist ─────────────────────────
  server.registerTool(
    "confirm_settlement_wallet",
    {
      title: "Step 2 of secure binding: verify signature and persist",
      description:
        "Verifies a signature produced from the message returned by `request_settlement_wallet_proof`, then writes `private_settlement_wallet` if valid. Stateless verification — the message itself contains the candidate, business_id, issued_at, and nonce; the signature must recover to the candidate, and the message must be within the freshness window.\n\n" +
        "## Failure modes\n\n" +
        "- `bad_message` — message format unrecognized; user probably didn't paste the canonical message verbatim.\n" +
        "- `expired` — proof older than 15 min; call `request_settlement_wallet_proof` again.\n" +
        "- `bad_signature` — signature recovery failed; user signed a different message or pasted an incomplete sig.\n" +
        "- `mismatch` — signature recovers to a different address than the candidate; user signed with the wrong wallet.\n" +
        "- `wrong_business` — message's business_id doesn't match the active business; pass `business_id` explicitly or re-issue.\n" +
        "- `stale_proof` — proof issued before the current settlement timestamp; replay defense, request a fresh proof.\n",
      inputSchema: confirmProofInput,
    },
    async (args, extra) => {
      const parsed = z.object(confirmProofInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;

      const result = await verifySettlement(
        parsed.data.message,
        parsed.data.signature as `0x${string}`,
      );
      if (!result.ok) {
        return toolError(result.code, result.error);
      }
      const { challenge } = result;

      if (challenge.businessId !== scope.scoped.businessId) {
        return toolError(
          "wrong_business",
          `Message is bound to business ${challenge.businessId} but the active business is ${scope.scoped.businessId}.`,
        );
      }

      // Replay defense: don't allow an older signed message to overwrite a
      // newer setting.
      const [current] = await db
        .select({ enabledAt: businesses.privateEnabledAt })
        .from(businesses)
        .where(eq(businesses.id, scope.scoped.businessId));
      if (current?.enabledAt && challenge.issuedAt < current.enabledAt) {
        return toolError(
          "stale_proof",
          "Proof issued before the current settlement was set; request a fresh proof.",
        );
      }

      const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID ?? 84532);
      const now = new Date();
      await db
        .update(businesses)
        .set({
          privateSettlementWallet: challenge.candidate,
          privateEnabledAt: now,
        })
        .where(eq(businesses.id, scope.scoped.businessId));

      return toolOk({
        settlement_wallet: challenge.candidate,
        chain_id: chainId,
        enabled_at: now.toISOString(),
        verified: true,
        message:
          "Settlement wallet ownership proven and persisted. Future invoices for this business will include an encrypted recipient handle.",
      });
    },
  );

  // ───── Direct (unverified) setup — kept for convenience ─────────────────
  server.registerTool(
    "setup_private_payments",
    {
      title: "Enable private payments (UNVERIFIED — prefer the proof flow)",
      description:
        "Sets the settlement wallet directly without proving ownership. **Prefer `request_settlement_wallet_proof` + `confirm_settlement_wallet` whenever possible** — that flow makes the user sign with their wallet, proving they control the address. This tool just trusts what you pass.\n\n" +
        "## When to use the unverified path anyway\n\n" +
        "- The user is in a development/testing context and explicitly opts out of signing.\n" +
        "- The user repeatedly asks for the fast path despite the safety hint.\n" +
        "- The user pastes an address copied from their own wallet UI moments ago and confirms verbally.\n\n" +
        "Always tell the user the safety tradeoff before calling: *typo or paste error here = permanently lost USDC*. Then ask for explicit confirmation. Otherwise, route them through the proof flow.\n\n" +
        "## Returns\n\n" +
        "`{settlement_wallet, chain_id, enabled_at}`. Future invoices for this business include an encrypted recipient handle on the share page.\n\n" +
        "## Failure modes\n\n" +
        "- `multiple_businesses` — pass `business_id` explicitly.\n" +
        "- `invalid_settlement_wallet` — must be a 0x address (40 hex chars).\n",
      inputSchema: setupInput,
    },
    async (args, extra) => {
      const parsed = z.object(setupInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;

      const settlementWallet = parsed.data.settlement_wallet.toLowerCase();
      const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID ?? 84532);
      const now = new Date();

      await db
        .update(businesses)
        .set({
          privateSettlementWallet: settlementWallet,
          privateEnabledAt: now,
        })
        .where(eq(businesses.id, scope.scoped.businessId));

      return toolOk({
        settlement_wallet: settlementWallet,
        chain_id: chainId,
        enabled_at: now.toISOString(),
        verified: false,
        warning:
          "This wallet was set without an ownership proof. If the user typed a wrong address, USDC paid to invoices under this business will be unrecoverable. Consider rotating to the proof flow if this turns out wrong.",
      });
    },
  );

  server.registerTool(
    "reset_private_payments",
    {
      title: "Disable private payments for a business",
      description:
        "Clears the settlement wallet on a business. New invoices will no longer include an encrypted recipient handle. **Already-issued invoices keep working** — their ct was bound at creation time, so payers can still settle them through the EnwisePay contract.\n\n" +
        "## When to call this\n\n" +
        "When the user wants to stop offering private payments, switch chains (private payments mainnet support arrives, etc.), or change settlement wallet. To change the wallet, call this then run the proof flow with the new address.\n\n" +
        "## Returns\n\n" +
        "`{was_set_up, previous_settlement_wallet?}`.",
      inputSchema: resetInput,
    },
    async (args, extra) => {
      const parsed = z.object(resetInput).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);
      const scope = await scopeFromCtx(ctx, parsed.data.business_id);
      if (!scope.ok) return scope.error;

      const [biz] = await db
        .select({ wallet: businesses.privateSettlementWallet })
        .from(businesses)
        .where(eq(businesses.id, scope.scoped.businessId));

      if (!biz?.wallet) {
        return toolOk({
          was_set_up: false,
          message: "private payments were not enabled on this business.",
        });
      }

      await db
        .update(businesses)
        .set({ privateSettlementWallet: null, privateEnabledAt: null })
        .where(eq(businesses.id, scope.scoped.businessId));

      return toolOk({
        was_set_up: true,
        previous_settlement_wallet: biz.wallet,
        message:
          "private payments disabled. New invoices will pay via the standard rails. Existing invoices retain their encrypted recipient and remain payable.",
      });
    },
  );
}
