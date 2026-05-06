"use client";

import { useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  encodePacked,
  parseAbi,
  type Address,
  type EIP1193Provider,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  PERMIT2_ADDRESS,
  generatePermit2Nonce,
  signPermit2InvoiceWitness,
} from "@/lib/private/permit2";
import { selectProvider } from "@/lib/private/wallet-provider";

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

type Status =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "submitted"; txHash: string }
  | { kind: "error"; message: string };

type Props = {
  slug: string;
  amountLabel: string;     // e.g. "5,000.00 USDC"
  amountUnits: string;     // raw integer string in token's smallest unit
  asset: Address;          // USDC on Base Sepolia
  ctCommit: `0x${string}`; // keccak256(recipient_ct) — must match server
  enwisePayAddress: Address;
  chainId: number;
  blockExplorerTxBase: string;
};

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export default function PrivatePayButton(props: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const onPay = async () => {
    try {
      setStatus({ kind: "working", label: "Connecting wallet…" });
      const wallet = await selectProvider({ prefer: "MetaMask" });
      if (!wallet) throw new Error("no wallet detected (install MetaMask, Rabby, or Coinbase Wallet)");
      const provider = wallet.provider as EIP1193Provider;

      const [account] = (await provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      if (!account) throw new Error("no account selected");

      // Ensure correct network
      const currentChainHex = (await provider.request({ method: "eth_chainId" })) as string;
      const currentChain = parseInt(currentChainHex, 16);
      if (currentChain !== props.chainId) {
        setStatus({ kind: "working", label: "Switch network in wallet…" });
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${props.chainId.toString(16)}` }],
          });
        } catch {
          throw new Error(`please switch wallet to chain ${props.chainId}`);
        }
      }

      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: custom(provider),
      });
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(),
      });

      const amount = BigInt(props.amountUnits);

      // Step 1: ensure Permit2 has USDC allowance from this payer.
      setStatus({ kind: "working", label: "Checking Permit2 allowance…" });
      const [allowance] = (await publicClient.readContract({
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ABI,
        functionName: "allowance",
        args: [account, props.asset, props.enwisePayAddress],
      })) as [bigint, number, number];

      if (allowance < amount) {
        setStatus({ kind: "working", label: "First-time setup: approve Permit2…" });
        const approveHash = await walletClient.writeContract({
          account,
          chain: baseSepolia,
          address: props.asset,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, BigInt("0xffffffffffffffffffffffffffffffffffffffff")],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // Step 2: sign Permit2 witness-bound transfer auth.
      setStatus({ kind: "working", label: "Sign payment authorization…" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const slugBytes32 = keccak256(encodePacked(["string"], [props.slug]));
      const nonce = generatePermit2Nonce();

      const signature = await signPermit2InvoiceWitness({
        walletClient,
        account,
        chainId: props.chainId,
        spender: props.enwisePayAddress,
        permit: {
          permitted: { token: props.asset, amount },
          nonce,
          deadline,
        },
        witness: {
          slug: slugBytes32,
          ctCommit: props.ctCommit,
          settlement: props.enwisePayAddress,
          expiry: deadline,
        },
      });

      // Step 3: hand sig to relayer; it submits the on-chain tx.
      setStatus({ kind: "working", label: "Submitting…" });
      const res = await fetch(`/api/invoices/${props.slug}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payer: account,
          signature,
          permit: {
            permitted: { token: props.asset, amount: amount.toString() },
            nonce: nonce.toString(),
            deadline: deadline.toString(),
          },
        }),
      });
      const out = (await res.json()) as { txHash?: string; error?: string };
      if (!res.ok || !out.txHash) {
        throw new Error(out.error || "submission failed");
      }
      setStatus({ kind: "submitted", txHash: out.txHash });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message });
    }
  };

  if (status.kind === "submitted") {
    return (
      <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">
        Payment submitted privately.{" "}
        <a
          className="underline"
          href={`${props.blockExplorerTxBase}${status.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          View tx
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={onPay}
        disabled={status.kind === "working"}
        className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-60"
      >
        {status.kind === "working" ? status.label : `Pay ${props.amountLabel} privately (private)`}
      </button>
      {status.kind === "error" && (
        <p className="text-sm text-red-600">{status.message}</p>
      )}
    </div>
  );
}
