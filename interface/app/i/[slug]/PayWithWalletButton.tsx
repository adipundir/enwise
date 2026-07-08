"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi } from "viem";
import {
  useConnect,
  useConnection,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { ArbitrumLogo, BaseLogo, EthereumLogo } from "@/components/chain-logos";
import { WalletProviders } from "@/lib/web3/providers";
import { chainLabel, isSupportedChainId, resolveChain, type SupportedChainId } from "@/lib/web3/chain";
import { PaidBadge } from "./PaidBadge";

function isUserRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: number | string; message?: string; shortMessage?: string };
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return true;
  const msg = (e.shortMessage ?? e.message ?? "").toLowerCase();
  return (
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("rejected the request")
  );
}

function friendlyErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.length < 100 && !msg.includes("Contract Call") && !msg.includes("Request Arguments")) {
      return msg;
    }
  }
  return "Payment failed. Please try again.";
}

type Props = {
  slug: string;
  merchantWallet: `0x${string}`;
  /** Stablecoin base units (bigint as string, 6 decimals). USDC and USDT are
   *  both 6-dec, so the unit count is the same regardless of which chain. */
  amountUsdcUnits: string;
  /** Numeric amount for the button label, e.g. "236.00". The token symbol
   *  (USDC / USDT) is appended from whichever chain the payer selects. */
  amountDisplay: string;
  /** The EVM chains the merchant accepts on, in display order. The payer
   *  picks one; all pay to the same merchantWallet. Resolved by the share
   *  page from the invoice / business accepted_chain_ids. */
  acceptedChainIds: number[];
  /** Which accepted chain to pre-select (merchant's preferred, else first). */
  defaultChainId: number;
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

function CrossFade({ stateKey, children }: { stateKey: string; children: React.ReactNode }) {
  const [displayed, setDisplayed] = useState(children);
  const [displayedKey, setDisplayedKey] = useState(stateKey);
  const [animClass, setAnimClass] = useState("opacity-100 scale-100");
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // While not mid-transition, keep the shown content live as children change
  // within the same key (e.g. the inflight label cycling). Adjusting state
  // during render is React-endorsed and does not loop: the follow-up re-render
  // sees the same children reference, so the guard settles immediately.
  if (stateKey === displayedKey && displayed !== children) {
    setDisplayed(children);
  }

  useEffect(() => {
    if (stateKey === displayedKey) return;
    clearTimeout(timeoutRef.current);
    // Begin the fade-out on the next frame so setState is never called
    // synchronously inside the effect body.
    const raf = requestAnimationFrame(() => setAnimClass("opacity-0 scale-95"));
    timeoutRef.current = setTimeout(() => {
      setDisplayed(children);
      setDisplayedKey(stateKey);
      setAnimClass("opacity-0 scale-105");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimClass("opacity-100 scale-100");
        });
      });
    }, 150);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeoutRef.current);
    };
  }, [stateKey, displayedKey, children]);

  return (
    <div className={`transition-all duration-200 ease-out ${animClass}`}>
      {displayed}
    </div>
  );
}

function PayInner({
  slug,
  merchantWallet,
  amountUsdcUnits,
  amountDisplay,
  acceptedChainIds,
  defaultChainId,
}: Props) {
  const { address, chainId: walletChainId, status } = useConnection();
  const { connectAsync, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<"connect" | "network">("connect");
  // Which accepted chain the payer is paying on. Starts at the merchant's
  // preferred; the payer picks one in the setup modal before connecting.
  const [selectedChainId, setSelectedChainId] = useState<number>(defaultChainId);

  const resolved = useMemo(() => resolveChain(selectedChainId), [selectedChainId]);
  const onWrongChain = status === "connected" && walletChainId !== resolved.chainId;
  const inflight =
    phase.kind === "signing" ||
    phase.kind === "confirming" ||
    phase.kind === "verifying";
  const amount = BigInt(amountUsdcUnits);

  // Picking a chain updates the target and, when already connected, asks the
  // wallet to switch networks. Disabled mid-transaction so we never change
  // chain under an in-flight transfer.
  async function pickChain(id: number) {
    if (inflight || id === selectedChainId) return;
    setSelectedChainId(id);
    setPhase({ kind: "idle" });
    if (status === "connected" && walletChainId !== id && isSupportedChainId(id)) {
      try {
        await switchChainAsync({ chainId: id });
      } catch (e) {
        if (!isUserRejection(e)) {
          // Wallet declined for a reason other than user cancel; the "Switch to …"
          // button remains as the explicit fallback.
        }
      }
    }
  }

  async function handleConnectDirect() {
    const wc = connectors.find((c) => c.id === "walletConnect");
    if (!wc) return;
    const chainId = acceptedChainIds[0] ?? defaultChainId;
    setSelectedChainId(chainId);
    try {
      await connectAsync({
        connector: wc,
        ...(isSupportedChainId(chainId) ? { chainId } : {}),
      });
      // Do not call switchChainAsync here — WalletConnect chain-switch requests
      // frequently hang when sent immediately after connect (the relay delivers
      // the request but MetaMask never surfaces it). The onWrongChain render
      // branch shows an explicit "Switch to …" button when needed.
    } catch (e) {
      if (!isUserRejection(e)) {
        setPhase({ kind: "error", message: "Could not connect wallet. Please try again." });
      }
    }
  }

  function openSetup(mode: "connect" | "network") {
    setSetupMode(mode);
    setSetupOpen(true);
  }

  async function handleSetupConfirm() {
    if (setupMode === "connect") {
      const wc = connectors.find((c) => c.id === "walletConnect");
      if (!wc) return;
      try {
        await connectAsync({
          connector: wc,
          ...(isSupportedChainId(selectedChainId) ? { chainId: selectedChainId as SupportedChainId } : {}),
        });
        // Do not call switchChainAsync here — it frequently hangs over
        // WalletConnect when the relay delivers the request but MetaMask
        // never surfaces the approval prompt, leaving the modal frozen.
        // If the wallet lands on the wrong chain, onWrongChain renders an
        // explicit "Switch to …" button.
        setSetupOpen(false);
      } catch (e) {
        if (!isUserRejection(e)) {
          setPhase({ kind: "error", message: "Could not connect wallet. Please try again." });
        }
      }
    } else {
      try {
        await pickChain(selectedChainId);
        setSetupOpen(false);
      } catch {
        // pickChain already swallows user rejections.
      }
    }
  }

  // Safety net: close the setup modal as soon as wagmi reports connected,
  // even if connectAsync's promise never resolved (a known WalletConnect
  // relay timing issue where the session is established but the promise hangs).
  useEffect(() => {
    if (status === "connected" && setupOpen) {
      setSetupOpen(false);
    }
  }, [status, setupOpen]);

  // Eagerly initialize WalletConnect SDK so the modal opens instantly.
  const warmedRef = useRef(false);
  useEffect(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    const wc = connectors.find((c) => c.id === "walletConnect");
    wc?.getProvider?.().catch(() => {});
  }, [connectors]);

  async function onPay() {
    setPhase({ kind: "signing" });
    try {
      const txHash = await writeContractAsync({
        chainId: resolved.chainId,
        address: resolved.tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [merchantWallet, amount],
      });
      setPhase({ kind: "confirming", txHash });
      setPhase({ kind: "verifying", txHash });
      const res = await fetch(`/api/invoices/${slug}/confirm-payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash, chainId: resolved.chainId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "verification failed" }));
        setPhase({ kind: "error", message: body.error ?? "verification failed" });
        return;
      }
      setPhase({ kind: "paid", txHash });
    } catch (e) {
      if (isUserRejection(e)) {
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "error", message: friendlyErrorMessage(e) });
    }
  }

  const stateKey =
    status !== "connected" || !address
      ? "connect"
      : onWrongChain
      ? "switch"
      : phase.kind === "paid"
      ? "paid"
      : phase.kind === "signing" || phase.kind === "confirming" || phase.kind === "verifying"
      ? "inflight"
      : "ready";

  if (phase.kind === "paid") {
    return (
      <CrossFade stateKey={stateKey}>
        <PaidBadge slug={slug} txHash={phase.txHash} chainId={resolved.chainId} />
      </CrossFade>
    );
  }

  let content: React.ReactNode;

  if (status !== "connected" || !address) {
    content = (
      <div className="flex flex-col items-end gap-1.5">
        <RainbowButton
          onClick={() => {
            if (acceptedChainIds.length === 1) {
              void handleConnectDirect();
            } else {
              openSetup("connect");
            }
          }}
          disabled={isConnecting}
        >
          {isConnecting ? "Connecting…" : "Connect wallet to pay"}
        </RainbowButton>
      </div>
    );
  } else if (onWrongChain) {
    content = (
      <div className="flex flex-col items-end gap-1.5">
        <RainbowButton
          onClick={async () => {
            try {
              await switchChainAsync({ chainId: resolved.chainId });
            } catch (e) {
              if (!isUserRejection(e)) {
                // Mobile wallet may still switch successfully even though
                // wagmi resolves with an error here.
              }
            }
          }}
          disabled={isSwitching}
        >
          {isSwitching
            ? "Approve on your wallet…"
            : `Switch to ${resolved.chain.name}`}
        </RainbowButton>
        <WalletMeta
          address={address}
          chainId={selectedChainId}
          showNetworkPicker={acceptedChainIds.length > 1}
          onChangeNetwork={() => openSetup("network")}
          onDisconnect={() => disconnect()}
        />
      </div>
    );
  } else if (phase.kind === "signing" || phase.kind === "confirming" || phase.kind === "verifying") {
    const label =
      phase.kind === "signing"
        ? "Confirm in wallet…"
        : phase.kind === "confirming"
        ? "Sending tx…"
        : "Verifying on-chain…";
    content = (
      <div className="flex flex-col items-end gap-1.5">
        <span className="rounded-md bg-zinc-100 px-3.5 py-1.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200">
          {label}
        </span>
        <WalletMeta
          address={address}
          chainId={selectedChainId}
          showNetworkPicker={acceptedChainIds.length > 1}
          onChangeNetwork={() => openSetup("network")}
          onDisconnect={() => disconnect()}
        />
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col items-end gap-1.5">
        <RainbowButton onClick={onPay}>
          Pay {amountDisplay} {resolved.tokenSymbol}
        </RainbowButton>
        <WalletMeta
          address={address}
          chainId={selectedChainId}
          showNetworkPicker={acceptedChainIds.length > 1}
          onChangeNetwork={() => openSetup("network")}
          onDisconnect={() => disconnect()}
        />
        {phase.kind === "error" ? (
          <span className="max-w-xs text-right text-xs text-red-700">{phase.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <CrossFade stateKey={stateKey}>{content}</CrossFade>
      {setupOpen ? (
        <PaySetupModal
          mode={setupMode}
          chains={acceptedChainIds}
          selectedChainId={selectedChainId}
          onSelectChain={setSelectedChainId}
          onConfirm={handleSetupConfirm}
          onClose={() => setSetupOpen(false)}
          isPending={isConnecting || isSwitching}
        />
      ) : null}
    </>
  );
}

function ChainLogo({ chainId, className }: { chainId: number; className?: string }) {
  if (chainId === 8453 || chainId === 84532) {
    return <BaseLogo className={className} />;
  }
  if (chainId === 42161) {
    return <ArbitrumLogo className={className} />;
  }
  if (chainId === 1) {
    return <EthereumLogo className={className} />;
  }
  return (
    <span
      className={`inline-flex size-5 items-center justify-center rounded-full bg-zinc-200 text-[9px] font-semibold text-zinc-600 ${className ?? ""}`}
      aria-hidden
    >
      {chainLabel(chainId).slice(0, 1)}
    </span>
  );
}

function PaySetupModal({
  mode,
  chains,
  selectedChainId,
  onSelectChain,
  onConfirm,
  onClose,
  isPending,
}: {
  mode: "connect" | "network";
  chains: number[];
  selectedChainId: number;
  onSelectChain: (id: number) => void;
  onConfirm: () => void;
  onClose: () => void;
  isPending: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPending, onClose]);

  const title = mode === "connect" ? "Connect wallet to pay" : "Choose network";
  const confirmLabel =
    mode === "connect"
      ? isPending
        ? "Connecting…"
        : "Connect wallet"
      : isPending
      ? "Switching…"
      : "Continue";

  return (
    <div
      aria-modal="true"
      role="dialog"
      aria-labelledby="pay-setup-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
    >
      <div className="relative w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="absolute right-3 top-3 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Close"
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>

        <h2 id="pay-setup-title" className="pr-6 text-base font-semibold text-zinc-900">
          {title}
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          {mode === "connect"
            ? "Select the network you want to pay on, then connect your wallet."
            : "Select the network for this payment."}
        </p>

        {chains.length > 1 ? (
          <div role="radiogroup" aria-label="Pay on chain" className="mt-5 space-y-2">
            {chains.map((id) => {
              const active = id === selectedChainId;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isPending}
                  onClick={() => onSelectChain(id)}
                  className={
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                    (active
                      ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                      : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50")
                  }
                >
                  <ChainLogo chainId={id} className="size-5 shrink-0" />
                  <span className="text-sm font-medium text-zinc-900">{chainLabel(id)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
            <ChainLogo chainId={chains[0]!} className="size-5 shrink-0" />
            <span className="text-sm font-medium text-zinc-900">{chainLabel(chains[0]!)}</span>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function WalletMeta({
  address,
  chainId,
  showNetworkPicker,
  onChangeNetwork,
  onDisconnect,
}: {
  address: `0x${string}`;
  chainId: number;
  showNetworkPicker: boolean;
  onChangeNetwork: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-zinc-500">
      {showNetworkPicker ? (
        <>
          <button
            type="button"
            onClick={onChangeNetwork}
            className="hover:text-zinc-800 hover:underline underline-offset-2"
          >
            {chainLabel(chainId)}
          </button>
          <span aria-hidden>·</span>
        </>
      ) : null}
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
