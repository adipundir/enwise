import { resolveChain } from "@/lib/web3/chain";

type Props = {
  /** Share slug — required so the badge can link to /i/:slug/receipt.pdf. */
  slug: string;
  txHash?: string | null;
  chainId?: number | null;
};

/**
 * Bare-bones paid state. No pill, no border — just a green check, "Paid",
 * a clickable transaction hash (block explorer), and a "Receipt" download.
 * Reads as text on the page, not a UI control.
 */
export function PaidBadge({ slug, txHash, chainId }: Props) {
  const showTx = !!txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash);
  const explorerUrl =
    showTx && chainId ? resolveChain(chainId).txExplorerUrl(txHash) : null;
  const txShort = showTx ? `${txHash!.slice(0, 6)}…${txHash!.slice(-4)}` : null;

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-900">
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-4 text-emerald-600"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
      <span>Paid</span>
      {explorerUrl && txShort ? (
        <>
          <span aria-hidden className="text-zinc-300">·</span>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-1.5 text-zinc-600 hover:text-zinc-900 hover:underline underline-offset-2"
            title="View on block explorer"
          >
            <span>Transaction</span>
            <span className="font-mono">{txShort}</span>
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 2h6v6" />
              <path d="M10 2L4.5 7.5" />
              <path d="M9 7v3H2V3h3" />
            </svg>
          </a>
        </>
      ) : null}
      <span aria-hidden className="text-zinc-300">·</span>
      <a
        href={`/i/${slug}/receipt.pdf`}
        download
        className="group inline-flex items-center gap-1.5 text-zinc-600 hover:text-zinc-900 hover:underline underline-offset-2"
        title="Download payment receipt"
      >
        <span>Receipt</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 1v8" />
          <path d="M3 6l3 3 3-3" />
          <path d="M2 11h8" />
        </svg>
      </a>
    </span>
  );
}
