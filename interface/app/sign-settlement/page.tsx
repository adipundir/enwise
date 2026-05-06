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

function SignInner() {
  const sp = useSearchParams();
  const messageB64 = sp.get("m");

  const message = useMemo(() => {
    if (!messageB64) return null;
    try {
      // base64url → base64 (atob is strict about padding in Safari).
      const std = messageB64.replace(/-/g, "+").replace(/_/g, "/");
      const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
      return atob(padded);
    } catch {
      return null;
    }
  }, [messageB64]);

  // Pull the candidate address out of the message (it's there explicitly).
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
        setStatus({ kind: "error", message: "No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet." });
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
        message: `Connected wallet is ${account}, but the message is for ${candidate}. Switch accounts in your wallet and try again.`,
      });
      return;
    }

    setStatus({ kind: "signing" });
    try {
      const walletClient = createWalletClient({
        account,
        // Chain doesn't matter for personal_sign — using mainnet just to satisfy viem's type.
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

  if (!message || !candidate) {
    return (
      <main className="mx-auto max-w-xl p-8 text-zinc-900">
        <h1 className="text-xl font-semibold">Invalid signing link</h1>
        <p className="mt-2 text-sm text-zinc-600">
          The link is missing or malformed. Ask Claude to call{" "}
          <code className="rounded bg-zinc-100 px-1">request_settlement_wallet_proof</code> again to get a fresh URL.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-6 sm:p-8 text-zinc-900">
      <h1 className="text-xl font-semibold">Confirm your settlement wallet</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Sign this message with the wallet you want to bind. Signing has no on-chain effect and costs no gas. It just proves you control the address.
      </p>

      <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 text-xs text-zinc-800 ring-1 ring-zinc-200">
        {message}
      </pre>

      <div className="mt-6 space-y-3">
        {status.kind === "idle" && (
          <button
            onClick={connect}
            className="w-full rounded-lg bg-black py-3 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Connect wallet
          </button>
        )}

        {status.kind === "connecting" && (
          <p className="text-sm text-zinc-600">Connecting…</p>
        )}

        {status.kind === "ready" && (
          <>
            <p className="text-sm text-zinc-600">
              Connected via <span className="font-medium text-zinc-900">{status.wallet.name}</span> as{" "}
              <code className="rounded bg-zinc-100 px-1">{status.account}</code>
            </p>
            {status.wallet.isBraveWallet && (
              <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
                Brave Wallet was selected. If you wanted MetaMask: open{" "}
                <code>brave://settings/wallet</code>, set "Default crypto wallet" to "Extensions (no fallback)",
                refresh this page, then reconnect.
              </p>
            )}
            <button
              onClick={() => signAndSubmit(status.account, status.wallet)}
              className="w-full rounded-lg bg-black py-3 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Sign and confirm
            </button>
          </>
        )}

        {status.kind === "signing" && <p className="text-sm text-zinc-600">Waiting for signature…</p>}
        {status.kind === "submitting" && <p className="text-sm text-zinc-600">Verifying…</p>}

        {status.kind === "done" && (
          <div className="rounded-lg bg-emerald-50 p-4 ring-1 ring-emerald-200">
            <p className="font-medium text-emerald-900">✓ Settlement wallet confirmed</p>
            <p className="mt-1 text-sm text-emerald-800">
              <code className="rounded bg-white px-1">{status.settlement_wallet}</code> is now bound to this business.
              Go back to Claude and say "done"; new invoices will use this wallet.
            </p>
          </div>
        )}

        {status.kind === "error" && (
          <div className="rounded-lg bg-red-50 p-4 ring-1 ring-red-200">
            <p className="text-sm text-red-900">{status.message}</p>
            {candidate && (
              <p className="mt-2 text-xs text-red-700">
                Expected to sign with: <code>{candidate}</code>
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default function SignSettlementPage() {
  return (
    <Suspense fallback={<main className="p-8">Loading…</main>}>
      <SignInner />
    </Suspense>
  );
}
