/**
 * private-event indexer.
 *
 * Scans EnwisePay.Shielded(noteId, slug, asset, amount) over a recent block
 * window. When an event's slug matches an private-payments-enabled invoice that doesn't
 * have a noteId yet, attaches the noteId so the sweep worker can pick it up.
 *
 * Triggered every 2 minutes from Vercel cron.
 */

import { eq, and, isNotNull, isNull } from "drizzle-orm";
import { keccak256, encodePacked, parseAbiItem } from "viem";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { getEnwisePayAddress } from "./client";
import { getPublicClient } from "./relayer";

const SHIELDED_EVENT = parseAbiItem(
  "event Shielded(uint256 indexed noteId, bytes32 indexed slug, address asset, uint256 amount)",
);

// Base Sepolia: ~2s blocks. 2 min cadence + 30 min lookback covers reorgs/cron skips.
const LOOKBACK_BLOCKS = 900n;

export type IndexResult = {
  scanned: number;
  matched: number;
  fromBlock: string;
  toBlock: string;
};

export async function indexShieldedEvents(): Promise<IndexResult> {
  const enwisePay = getEnwisePayAddress();
  const publicClient = getPublicClient();

  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

  const logs = await publicClient.getLogs({
    address: enwisePay,
    event: SHIELDED_EVENT,
    fromBlock,
    toBlock: latest,
  });

  if (logs.length === 0) {
    return { scanned: 0, matched: 0, fromBlock: fromBlock.toString(), toBlock: latest.toString() };
  }

  // Build slug-bytes32 → invoice lookup ONLY for private-payments-enabled, unshielded invoices.
  const open = await db
    .select({ id: invoices.id, shareSlug: invoices.shareSlug })
    .from(invoices)
    .where(
      and(
        eq(invoices.privateEnabled, true),
        isNull(invoices.privateNoteId),
        isNotNull(invoices.privateRecipientCt),
      ),
    );

  const slugToInvoice = new Map<string, string>();
  for (const inv of open) {
    const slugBytes32 = keccak256(encodePacked(["string"], [inv.shareSlug]));
    slugToInvoice.set(slugBytes32, inv.id);
  }

  let matched = 0;
  for (const log of logs) {
    const slug = log.args.slug;
    const noteId = log.args.noteId;
    if (!slug || noteId == null) continue;
    const invoiceId = slugToInvoice.get(slug);
    if (!invoiceId) continue;

    await db
      .update(invoices)
      .set({ privateNoteId: Number(noteId), updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    matched++;
  }

  return { scanned: logs.length, matched, fromBlock: fromBlock.toString(), toBlock: latest.toString() };
}
