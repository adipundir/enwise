import "server-only";
import { and, eq, isNull } from "drizzle-orm";
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
 *
 * Race-free: the persist step uses a conditional UPDATE
 * (WHERE railgun_zk_address IS NULL) so two concurrent setups for the same
 * business can't both win. The losing call discards its mnemonic, re-reads
 * the row, and returns alreadySetUp with the winning address.
 */

export type ResetPrivatePaymentsResult =
  | {
      ok: true;
      wasSetUp: true;
      previousZkAddress: string;
      previousChainId: number | null;
    }
  | {
      ok: true;
      wasSetUp: false;
    };

/**
 * Forget the RAILGUN wallet on a business — NULL out address, viewing key,
 * chain id, setup timestamp. After this, setupPrivatePayments will mint a
 * fresh wallet on the next call.
 *
 * Why this exists: a wallet's railgun_chain_id is locked at setup time. If
 * someone set up while RAILGUN_NETWORK=mainnet and later flips it to
 * sepolia (or vice versa), the share-page Pay button silently disappears
 * because the chain check fails. Reset + re-setup is the only way to
 * re-anchor to the current chain.
 *
 * What it costs:
 * - Future invoices stop printing the old 0zk address (good — no more
 *   payments going to a wallet we'll lose track of).
 * - Already-sent invoices that already printed the old address are no
 *   longer auto-verifiable here — we threw away the viewing key. The user
 *   can still see those funds via Railway Wallet using the original
 *   mnemonic, but our server stops marking those invoices paid.
 * - The mnemonic itself is unaffected (it was never on our server). Funds
 *   shielded to the old address remain spendable by anyone who holds it.
 */
export async function resetPrivatePayments(
  ctx: ScopedCtx,
): Promise<ResetPrivatePaymentsResult> {
  console.log(
    `[railgun] reset_start business=${ctx.businessId} user=${ctx.userId}`,
  );
  const [biz] = await db
    .select({
      railgunZkAddress: businesses.railgunZkAddress,
      railgunChainId: businesses.railgunChainId,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));

  if (!biz?.railgunZkAddress) {
    console.log(`[railgun] reset_noop business=${ctx.businessId}`);
    return { ok: true, wasSetUp: false };
  }

  await db
    .update(businesses)
    .set({
      railgunZkAddress: null,
      railgunViewingKeyEncrypted: null,
      railgunChainId: null,
      railgunSetupAt: null,
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, ctx.businessId));

  console.log(
    `[railgun] reset_ok business=${ctx.businessId} prev_addr=${biz.railgunZkAddress.slice(0, 12)}…${biz.railgunZkAddress.slice(-6)} prev_chain=${biz.railgunChainId}`,
  );
  return {
    ok: true,
    wasSetUp: true,
    previousZkAddress: biz.railgunZkAddress,
    previousChainId: biz.railgunChainId ?? null,
  };
}

export type SetupPrivatePaymentsResult =
  | {
      ok: true;
      alreadySetUp: false;
      zkAddress: string;
      mnemonic: string;
      shareableViewingKey: string | null;
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
  console.log(
    `[railgun] setup_start business=${ctx.businessId} user=${ctx.userId}`,
  );
  const [biz] = await db
    .select({
      railgunZkAddress: businesses.railgunZkAddress,
      railgunChainId: businesses.railgunChainId,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId));

  const cfg = activeRailgunNetwork();

  if (biz?.railgunZkAddress) {
    console.log(
      `[railgun] setup_already business=${ctx.businessId} addr=${biz.railgunZkAddress.slice(0, 12)}…${biz.railgunZkAddress.slice(-6)} chain=${biz.railgunChainId}`,
    );
    return {
      ok: true,
      alreadySetUp: true,
      zkAddress: biz.railgunZkAddress,
      chainId: biz.railgunChainId ?? cfg.chainId,
    };
  }

  const wallet = await generateRailgunWallet();
  const encrypted = encryptRawToken(wallet.viewingPrivateKeyHex);
  if (!encrypted) {
    console.error(
      `[railgun] setup_failed_no_token_enc_key business=${ctx.businessId}`,
    );
    return {
      ok: false,
      code: "encryption_unavailable",
      message:
        "TOKEN_ENC_KEY env var is not configured; refusing to store the RAILGUN viewing key in plaintext.",
      hint: "Set TOKEN_ENC_KEY to a base64-encoded 32-byte key on the server (e.g. `openssl rand -base64 32`) and retry.",
    };
  }

  const updated = await db
    .update(businesses)
    .set({
      railgunZkAddress: wallet.zkAddress,
      railgunViewingKeyEncrypted: encrypted,
      railgunChainId: cfg.chainId,
      railgunSetupAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(businesses.id, ctx.businessId),
        isNull(businesses.railgunZkAddress),
      ),
    )
    .returning({ id: businesses.id });

  if (updated.length === 0) {
    console.warn(
      `[railgun] setup_race_lost business=${ctx.businessId} — mnemonic discarded, re-reading winner`,
    );
    const [winner] = await db
      .select({
        railgunZkAddress: businesses.railgunZkAddress,
        railgunChainId: businesses.railgunChainId,
      })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId));
    if (winner?.railgunZkAddress) {
      console.log(
        `[railgun] setup_race_returning_winner business=${ctx.businessId} addr=${winner.railgunZkAddress.slice(0, 12)}…${winner.railgunZkAddress.slice(-6)}`,
      );
      return {
        ok: true,
        alreadySetUp: true,
        zkAddress: winner.railgunZkAddress,
        chainId: winner.railgunChainId ?? cfg.chainId,
      };
    }
    console.error(
      `[railgun] setup_business_vanished business=${ctx.businessId}`,
    );
    return {
      ok: false,
      code: "encryption_unavailable",
      message: "Business row vanished mid-setup; no wallet was persisted.",
      hint: "Re-run setup_private_payments after confirming the business still exists.",
    };
  }

  console.log(
    `[railgun] setup_persisted business=${ctx.businessId} addr=${wallet.zkAddress.slice(0, 12)}…${wallet.zkAddress.slice(-6)} chain=${cfg.chainId} — RETURNING MNEMONIC TO CALLER`,
  );

  return {
    ok: true,
    alreadySetUp: false,
    zkAddress: wallet.zkAddress,
    mnemonic: wallet.mnemonic,
    shareableViewingKey: wallet.shareableViewingKey,
    chainId: cfg.chainId,
  };
}
