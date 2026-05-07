"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";
import { mainnet } from "viem/chains";
import { selectProvider, type WalletInfo } from "@/lib/private/wallet-provider";

type Status =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready"; account: Address; wallet: WalletInfo }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "done"; settlement_wallet: string }
  | { kind: "error"; message: string };

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function SignInner() {
  const sp = useSearchParams();
  const messageB64 = sp.get("m");

  const message = useMemo(() => {
    if (!messageB64) return null;
    try {
      const std = messageB64.replace(/-/g, "+").replace(/_/g, "/");
      const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
      return atob(padded);
    } catch {
      return null;
    }
  }, [messageB64]);

  const candidate = useMemo<Address | null>(() => {
    if (!message) return null;
    const m = message.match(/^Wallet:\s+(0x[a-fA-F0-9]{40})/m);
    return (m?.[1] as Address) ?? null;
  }, [message]);

  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const connect = async () => {
    setStatus({ kind: "connecting" });
    try {
      const wallet = await selectProvider({ prefer: "MetaMask" });
      if (!wallet) {
        setStatus({
          kind: "error",
          message: "No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.",
        });
        return;
      }
      const accounts = (await wallet.provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const account = accounts[0];
      if (!account) throw new Error("No account selected");
      setStatus({ kind: "ready", account, wallet });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Connection failed" });
    }
  };

  const signAndSubmit = async (account: Address, wallet: WalletInfo) => {
    if (!message) return;

    if (candidate && account.toLowerCase() !== candidate.toLowerCase()) {
      setStatus({
        kind: "error",
        message: `Connected wallet is ${shortAddr(account)}, but the message is for ${shortAddr(candidate)}. Switch accounts in your wallet and try again.`,
      });
      return;
    }

    setStatus({ kind: "signing" });
    try {
      const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: custom(wallet.provider as EIP1193Provider),
      });
      const signature = await walletClient.signMessage({ account, message });

      setStatus({ kind: "submitting" });
      const res = await fetch("/api/private/confirm-settlement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const out = (await res.json()) as { settlement_wallet?: string; error?: string };
      if (!res.ok || !out.settlement_wallet) {
        throw new Error(out.error ?? "submission failed");
      }
      setStatus({ kind: "done", settlement_wallet: out.settlement_wallet });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Signing failed" });
    }
  };

  // ── Invalid link ────────────────────────────────────────────────────────
  if (!message || !candidate) {
    return (
      <Page>
        <Eyebrow />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-zinc-100">
          This link is no longer valid
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Ask Claude to call <Mono>request_settlement_wallet_proof</Mono> again
          to get a fresh URL. Links expire after 15 minutes.
        </p>
      </Page>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────
  if (status.kind === "done") {
    return (
      <Page>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30">
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5 6.5 12 13 4.5" />
          </svg>
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-zinc-100">
          Settlement wallet confirmed
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          <Mono>{shortAddr(status.settlement_wallet)}</Mono> is now bound to this business.
          Future invoices will receive payments at this address.
        </p>
        <p className="mt-6 text-sm text-zinc-500">
          You can close this tab and return to Claude.
        </p>
      </Page>
    );
  }

  // ── Default flow ────────────────────────────────────────────────────────
  return (
    <Page>
      <Eyebrow />
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-zinc-100">
        Confirm your settlement wallet
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        Sign the message below with{" "}
        <span className="text-zinc-200">{shortAddr(candidate)}</span>. No
        transaction, no gas — just a signature that proves you control the
        address.
      </p>

      <pre className="mt-8 overflow-x-auto rounded-lg border border-zinc-900 bg-black/40 p-5 font-mono text-[12px] leading-[1.7] text-zinc-300">
{message}
      </pre>

      <div className="mt-8 space-y-3">
        {status.kind === "idle" && (
          <PrimaryButton onClick={connect}>Connect wallet</PrimaryButton>
        )}

        {status.kind === "connecting" && (
          <Hint>Opening your wallet…</Hint>
        )}

        {status.kind === "ready" && (
          <>
            <p className="text-xs text-zinc-500">
              Connected via{" "}
              <span className="text-zinc-300">{status.wallet.name}</span> as{" "}
              <Mono>{shortAddr(status.account)}</Mono>
            </p>
            {status.wallet.isBraveWallet && (
              <Tinted color="amber">
                Brave Wallet was selected. To use MetaMask instead: open{" "}
                <Mono>brave://settings/wallet</Mono>, set "Default crypto wallet"
                to "Extensions (no fallback)", refresh, then reconnect.
              </Tinted>
            )}
            <PrimaryButton onClick={() => signAndSubmit(status.account, status.wallet)}>
              Sign message
            </PrimaryButton>
          </>
        )}

        {status.kind === "signing" && <Hint>Waiting for your signature…</Hint>}
        {status.kind === "submitting" && <Hint>Verifying…</Hint>}

        {status.kind === "error" && (
          <Tinted color="red">
            <p className="leading-relaxed">{status.message}</p>
            {candidate && (
              <p className="mt-2 text-[11px] text-red-400/80">
                Expected to sign with <Mono>{shortAddr(candidate)}</Mono>
              </p>
            )}
          </Tinted>
        )}
      </div>
    </Page>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <div className="w-full max-w-lg">{children}</div>
    </main>
  );
}

function Eyebrow() {
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-zinc-500">
      <span className="block h-1 w-1 rounded-full bg-zinc-600" />
      enwise
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-lg bg-zinc-100 py-3 text-sm font-medium tracking-tight text-zinc-950 transition-colors hover:bg-white"
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-zinc-400">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-500" />
      {children}
    </p>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200 ring-1 ring-zinc-800">
      {children}
    </code>
  );
}

function Tinted({
  color,
  children,
}: {
  color: "amber" | "red";
  children: React.ReactNode;
}) {
  const palette =
    color === "amber"
      ? "bg-amber-500/[0.06] text-amber-200/90 ring-amber-500/20"
      : "bg-red-500/[0.06] text-red-200/90 ring-red-500/25";
  return (
    <div className={`rounded-lg p-3.5 text-xs ring-1 ${palette}`}>
      {children}
    </div>
  );
}

export default function SignSettlementPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
          Loading…
        </main>
      }
    >
      <SignInner />
    </Suspense>
  );
}
