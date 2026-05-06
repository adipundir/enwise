/**
 * private payments sweep worker.
 *
 * For each invoice in the `shielded` state (note materialised on-chain but
 * not yet swept to merchant), do:
 *  1. attestedCompute(handle, Eq, settlementWallet) — covalidator returns signed bool
 *     (relayer was granted handle access at payInvoice time, so this works directly)
 *  2. unShield(noteId, settlementWallet, attestation, sigs) — funds transferred
 *  3. mark invoice paid + record unShield tx hash
 *
 * Triggered by Vercel cron (every 5 min) or manually via `make sweep`.
 */

import { eq, and, isNotNull, isNull, ne } from "drizzle-orm";
import { AttestedComputeSupportedOps } from "@inco/js/lite";
import type { HexString } from "@inco/js";
import { bytesToHex, pad, toHex } from "viem";
import { db } from "@/lib/db";
import { invoices, businesses } from "@/lib/db/schema";
import { getZap, getEnwisePayAddress } from "./client";
import { getRelayerWallet, getPublicClient } from "./relayer";
import enwisePayArtifact from "@/lib/abi/EnwisePay.json";

const enwisePayAbi = enwisePayArtifact.abi;

export type SweepResult =
  | { invoiceId: string; status: "swept"; txHash: string }
  | { invoiceId: string; status: "skipped"; reason: string }
  | { invoiceId: string; status: "error"; error: string };

export async function sweepReadyNotes(): Promise<SweepResult[]> {
  // Find all shielded-but-not-paid invoices where indexer has filled in noteId.
  const ready = await db
    .select({
      id: invoices.id,
      noteId: invoices.privateNoteId,
      businessId: invoices.businessId,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.privateEnabled, true),
        isNotNull(invoices.privateNoteId),
        isNull(invoices.privateUnshieldTxHash),
        ne(invoices.status, "paid"),
        ne(invoices.status, "void"),
      ),
    )
    .limit(50);

  const results: SweepResult[] = [];
  for (const row of ready) {
    if (row.noteId == null) continue;
    try {
      const r = await sweepOne(row.id, BigInt(row.noteId), row.businessId);
      results.push(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ invoiceId: row.id, status: "error", error: msg });
    }
  }
  return results;
}

async function sweepOne(
  invoiceId: string,
  noteId: bigint,
  businessId: string,
): Promise<SweepResult> {
  const [biz] = await db
    .select({ wallet: businesses.privateSettlementWallet })
    .from(businesses)
    .where(eq(businesses.id, businessId));

  if (!biz?.wallet || !/^0x[a-fA-F0-9]{40}$/.test(biz.wallet)) {
    return { invoiceId, status: "skipped", reason: "no settlement wallet" };
  }
  const settlement = biz.wallet.toLowerCase() as `0x${string}`;

  const enwisePay = getEnwisePayAddress();
  const relayer = getRelayerWallet();
  if (!relayer.account) {
    return { invoiceId, status: "skipped", reason: "relayer not configured" };
  }
  const publicClient = getPublicClient();
  const zap = await getZap();

  // 1. Read the note to get the on-chain handle.
  const note = (await publicClient.readContract({
    address: enwisePay,
    abi: enwisePayAbi,
    functionName: "notes",
    args: [noteId],
  })) as readonly [`0x${string}`, bigint, `0x${string}`, boolean];
  // notes returns (asset, amount, recipient, spent)
  const [, , recipientHandle, spent] = note;
  if (spent) {
    return { invoiceId, status: "skipped", reason: "already spent on-chain" };
  }

  // 2. attestedCompute(handle, Eq, settlement). Covalidator returns signed bool.
  // Relayer already has handle access from payInvoice (recipient.allow(msg.sender)).
  // Wrap in retry — covalidator can lag a few seconds after the shield tx confirms.
  const computeResult = await attestedComputeWithRetry(
    zap,
    relayer,
    recipientHandle as HexString,
    BigInt(settlement),
  );

  // 3. Build attestation params per the skill's pattern 3 (Attested Compute).
  const attestation = {
    handle: computeResult.handle,
    value: pad(toHex(computeResult.plaintext.value ? 1 : 0), { size: 32 }),
  };
  const sigs = computeResult.covalidatorSignatures.map((s: Uint8Array) => bytesToHex(s));

  // 4. Submit unShield. msg.sender is relayer; recipient is the settlement wallet.
  const txHash = await relayer.writeContract({
    account: relayer.account,
    chain: relayer.chain,
    address: enwisePay,
    abi: enwisePayAbi,
    functionName: "unShield",
    args: [noteId, settlement, attestation, sigs],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // 5. Persist invoice paid state.
  await db
    .update(invoices)
    .set({
      status: "paid",
      paidAt: new Date(),
      privateUnshieldTxHash: txHash,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId));

  return { invoiceId, status: "swept", txHash };
}

/**
 * Wraps attestedCompute with exponential backoff. The covalidator typically
 * needs a few seconds after a shield tx confirms before it'll attest;
 * cf. the skill's `waitAndRetry` pattern in examples/attestation-flow.ts.
 */
async function attestedComputeWithRetry(
  zap: Awaited<ReturnType<typeof getZap>>,
  relayer: ReturnType<typeof getRelayerWallet>,
  handle: HexString,
  scalar: bigint,
  maxRetries = 5,
  initialDelayMs = 2_000,
) {
  let lastErr: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await zap.attestedCompute(
        relayer as Parameters<typeof zap.attestedCompute>[0],
        handle,
        AttestedComputeSupportedOps.Eq,
        scalar,
      );
    } catch (err) {
      lastErr = err;
      if (i < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
