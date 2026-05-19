"use client";

import { useMemo, useState } from "react";
import { erc20Abi } from "viem";
import {
  useConnect,
  useConnection,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { WalletProviders } from "@/lib/web3/providers";
import { resolveChain } from "@/lib/web3/chain";
import { PaidBadge } from "./PaidBadge";

type Props = {
  slug: string;
  merchantWallet: `0x${string}`;
  /** USDC units (bigint as string, 6 decimals). */
  amountUsdcUnits: string;
  /** "236.00 USDC" for the button label. */
  amountLabel: string;
  /** Which chain the merchant accepts on. Looked up by share page from
   *  business.payment_chain_id (or platform default if null). */
  chainId: number;
};

export function PayWithWalletButton(props: Props) {
  return (
    <WalletProviders>
      <PayInner {...props} />
    </WalletProviders>
  );
}

type Phase =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "confirming"; txHash: `0x${string}` }
  | { kind: "verifying"; txHash: `0x${string}` }
  | { kind: "paid"; txHash: `0x${string}` }
  | { kind: "error"; message: string };

function RainbowButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={
        "inline-block rounded-lg bg-[linear-gradient(120deg,#f43f5e,#f59e0b,#84cc16,#06b6d4,#8b5cf6,#f43f5e)] bg-[length:300%_100%] p-[2px] transition-[background-position] duration-700 ease-out [background-position:0%_0%] hover:[background-position:100%_0%]" +
        (disabled ? " opacity-60" : "")
      }
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="rounded-[6px] bg-zinc-900 px-4 py-1.5 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed"
      >
        {children}
      </button>
    </span>
  );
}

function PayInner({ slug, merchantWallet, amountUsdcUnits, amountLabel, chainId }: Props) {
  const { address, chainId: walletChainId, status } = useConnection();
  const { connect, connectors, isPending: isConnecting, error: connectError } =
    useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const resolved = useMemo(() => resolveChain(chainId), [chainId]);
  const onWrongChain = status === "connected" && walletChainId !== resolved.chainId;
  const amount = BigInt(amountUsdcUnits);

  // 1. Disconnected — single Connect button. Always routes through the
  // WalletConnect modal so the payer sees a unified wallet picker (browser
  // extensions, mobile QR, deep links) instead of having a single browser
  // extension auto-intercept the connection.
  if (status !== "connected" || !address) {
    const wc = connectors.find((c) => c.id === "walletConnect");
    return (
      <div className="flex flex-col items-end gap-1.5">
        <RainbowButton
          onClick={() => {
            if (wc) connect({ connector: wc });
          }}
          disabled={isConnecting || !wc}
        >
          {isConnecting ? "Connecting…" : "Connect wallet to pay"}
        </RainbowButton>
        {connectError ? (
          <span className="max-w-xs text-right text-xs text-red-700">
            {connectError.message}
          </span>
        ) : null}
      </div>
    );
  }

  // 2. Wrong network. The wallet-side chain switch is best-effort on mobile
  // WalletConnect — the wallet sends back a confirmation asynchronously,
  // and wagmi often reports an ambiguous error even when the switch
  // succeeds. Swallow that error here; the next render of useConnection()
  // sees the updated chainId and advances us to the Pay state automatically.
  if (onWrongChain) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <RainbowButton
          onClick={async () => {
            try {
              await switchChainAsync({ chainId: resolved.chainId });
            } catch {
              // Mobile wallet may still switch successfully even though
              // wagmi resolves with an error here — wait for chainId to
              // update via the wallet's own emit.
            }
          }}
          disabled={isSwitching}
        >
          {isSwitching
            ? "Approve on your wallet…"
            : `Switch to ${resolved.chain.name}`}
        </RainbowButton>
        <WalletMeta address={address} onDisconnect={() => disconnect()} />
      </div>
    );
  }

  // 3. Paid
  if (phase.kind === "paid") {
    return <PaidBadge slug={slug} txHash={phase.txHash} chainId={resolved.chainId} />;
  }

  // 4. In-flight
  if (phase.kind === "signing" || phase.kind === "confirming" || phase.kind === "verifying") {
    const label =
      phase.kind === "signing"
        ? "Confirm in wallet…"
        : phase.kind === "confirming"
        ? "Sending tx…"
        : "Verifying on-chain…";
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="rounded-md bg-zinc-100 px-3.5 py-1.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200">
          {label}
        </span>
        <WalletMeta address={address} onDisconnect={() => disconnect()} />
      </div>
    );
  }

  async function onPay() {
    setPhase({ kind: "signing" });
    try {
      const txHash = await writeContractAsync({
        chainId: resolved.chainId,
        address: resolved.usdcAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [merchantWallet, amount],
      });
      setPhase({ kind: "confirming", txHash });
      setPhase({ kind: "verifying", txHash });
      const res = await fetch(`/api/invoices/${slug}/confirm-payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash, payer: address }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "verification failed" }));
        setPhase({ kind: "error", message: body.error ?? "verification failed" });
        return;
      }
      setPhase({ kind: "paid", txHash });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message });
    }
  }

  // 5. Ready to pay (also error retry state)
  return (
    <div className="flex flex-col items-end gap-1.5">
      <RainbowButton onClick={onPay}>Pay {amountLabel}</RainbowButton>
      <WalletMeta address={address} onDisconnect={() => disconnect()} />
      {phase.kind === "error" ? (
        <span className="max-w-xs text-right text-xs text-red-700">{phase.message}</span>
      ) : null}
    </div>
  );
}

function WalletMeta({
  address,
  onDisconnect,
}: {
  address: `0x${string}`;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
      <span className="font-mono">
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={onDisconnect}
        className="hover:text-zinc-800 hover:underline underline-offset-2"
      >
        disconnect
      </button>
    </div>
  );
}
