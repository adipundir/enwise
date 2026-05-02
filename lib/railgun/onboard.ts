import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import type { ScopedCtx } from "@/lib/mcp/context";
import { encryptRawToken } from "@/lib/tokens";
import { activeRailgunNetwork } from "@/lib/railgun/config";
import { generateRailgunWallet } from "@/lib/railgun/wallet";

/**
 * One-time RAILGUN setup for a business. Mints a fresh shielded wallet, hands
 * the mnemonic back to the caller (returned to the user once), and persists
 * the public 0zk address + encrypted viewing key on the business row.
 *
 * Immutable once set — re-running is a no-op that returns
 * `{ alreadySetUp: true, zkAddress }`. Re-issuing would rewrite the address
 * printed on the next invoice and silently misdirect funds. If the user truly
 * wants a new wallet, that's a separate (manual) reset operation we haven't
 * built.
 */

export type SetupPrivatePaymentsResult =
  | {
      ok: true;
      alreadySetUp: false;
      zkAddress: string;
      mnemonic: string;
      chainId: number;
    }
  | {
      ok: true;
      alreadySetUp: true;
      zkAddress: string;
      chainId: number;
    }
  | {
      ok: false;
      code: "encryption_unavailable";
      message: string;
      hint: string;
    };

export async function setupPrivatePayments(
  ctx: ScopedCtx,
): Promise<SetupPrivatePaymentsResult> {
  const [biz] = await db
    .select({
      railgunZkAddress: businesses.railgunZkAddress,
      railgunChainId: businesses.railgunChainId,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));

  const cfg = activeRailgunNetwork();

  if (biz?.railgunZkAddress) {
    return {
      ok: true,
      alreadySetUp: true,
      zkAddress: biz.railgunZkAddress,
      chainId: biz.railgunChainId ?? cfg.chainId,
    };
  }

  // Refuse to mint a wallet if we can't encrypt the viewing key. Storing it
  // in plaintext would leak the entire payment ledger to anyone with DB read
  // access.
  const wallet = await generateRailgunWallet();
  const encrypted = encryptRawToken(wallet.viewingPrivateKeyHex);
  if (!encrypted) {
    return {
      ok: false,
      code: "encryption_unavailable",
      message:
        "TOKEN_ENC_KEY env var is not configured; refusing to store the RAILGUN viewing key in plaintext.",
      hint: "Set TOKEN_ENC_KEY to a base64-encoded 32-byte key on the server (e.g. `openssl rand -base64 32`) and retry.",
    };
  }

  await db
    .update(businesses)
    .set({
      railgunZkAddress: wallet.zkAddress,
      railgunViewingKeyEncrypted: encrypted,
      railgunChainId: cfg.chainId,
      railgunSetupAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, ctx.businessId));

  return {
    ok: true,
    alreadySetUp: false,
    zkAddress: wallet.zkAddress,
    mnemonic: wallet.mnemonic,
    chainId: cfg.chainId,
  };
}
