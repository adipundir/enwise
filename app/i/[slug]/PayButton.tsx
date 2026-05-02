"use client";

import { useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { buildRailgunShield, submitRailgunPayment } from "./actions";

const SHIELD_MESSAGE = "RAILGUN_SHIELD";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

type Status =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | {
      kind: "paid";
      txHash: string;
      alreadyRecorded: boolean;
    }
  | { kind: "error"; message: string };

type PayButtonNetwork = {
  chainId: number;
  railgunProxy: string;
  usdcAddress: string;
  blockExplorerTxBase: string;
  displayName: string;
  isTestnet: boolean;
};

type PayButtonProps = {
  slug: string;
  amountLabel: string;
  amountUnits: string;
  walletConnectProjectId: string | null;
  network: PayButtonNetwork;
};

function chainFor(network: PayButtonNetwork): Chain {
  if (network.chainId === mainnet.id) return mainnet;
  if (network.chainId === sepolia.id) return sepolia;
  // RAILGUN runs on a small set of chains; the remaining ones we don't ship,
  // so this fallback exists only to keep the type system honest.
  return defineChain({
    id: network.chainId,
    name: network.displayName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

export function PayButton({
  slug,
  amountLabel,
  amountUnits,
  walletConnectProjectId,
  network,
}: PayButtonProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const usdc = network.usdcAddress as Address;
  const chain = chainFor(network);
  const expectedChainHex = `0x${network.chainId.toString(16)}` as Hex;

  async function start(provider: EIP1193Provider) {
    try {
      setStatus({ kind: "working", label: "Connecting wallet…" });

      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const account = accounts[0]?.toLowerCase() as Address | undefined;
      if (!account) throw new Error("No account returned by the wallet.");

      const walletClient = createWalletClient({
        account,
        chain,
        transport: custom(provider),
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(),
      });

      const currentChain = (await provider.request({
        method: "eth_chainId",
      })) as Hex;
      if (parseInt(currentChain, 16) !== network.chainId) {
        setStatus({
          kind: "working",
          label: `Switching to ${network.displayName}…`,
        });
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: expectedChainHex }],
          });
        } catch (err) {
          throw new Error(
            `Please switch your wallet to ${network.displayName} and try again.`,
          );
        }
      }

      const grossUnits = BigInt(amountUnits);
      const balance = (await publicClient.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
      if (balance < grossUnits) {
        throw new Error(
          `Insufficient USDC. Need ${amountLabel}, wallet has ${formatUsdc(balance)}.`,
        );
      }

      // Build calldata first so we know who needs the allowance.
      setStatus({ kind: "working", label: "Sign the RAILGUN message in your wallet…" });
      const signatureHex = (await provider.request({
        method: "personal_sign",
        params: [hexFromUtf8(SHIELD_MESSAGE), account],
      })) as Hex;

      setStatus({ kind: "working", label: "Preparing private transfer…" });
      const prep = await buildRailgunShield({ slug, signatureHex });
      if (!prep.ok) {
        throw new Error(prep.message);
      }

      const allowance = (await publicClient.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, prep.railgunProxyAddress as Address],
      })) as bigint;
      if (allowance < grossUnits) {
        setStatus({ kind: "working", label: "Approve USDC in your wallet…" });
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [prep.railgunProxyAddress as Address, grossUnits],
        });
        const approveHash = await walletClient.sendTransaction({
          to: usdc,
          data: approveData,
        });
        setStatus({ kind: "working", label: "Confirming approval…" });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setStatus({ kind: "working", label: "Confirm the private payment in your wallet…" });
      const shieldHash = await walletClient.sendTransaction({
        to: prep.to as Address,
        data: prep.data as Hex,
        value: BigInt(prep.value),
      });
      setStatus({
        kind: "working",
        label: `Confirming on ${network.displayName} (~30s)…`,
      });
      await publicClient.waitForTransactionReceipt({ hash: shieldHash });

      setStatus({ kind: "working", label: "Verifying payment…" });
      // First verification can race the RPC's mempool→receipt visibility window.
      // Retry a few times before surfacing tx_not_mined to the user.
      let verifyResult = await submitRailgunPayment({
        slug,
        txHash: shieldHash,
        shieldRandom: prep.shieldRandom,
      });
      let attempts = 0;
      while (
        !verifyResult.ok &&
        verifyResult.code === "tx_not_mined" &&
        attempts < 4
      ) {
        await sleep(3000);
        attempts += 1;
        verifyResult = await submitRailgunPayment({
          slug,
          txHash: shieldHash,
          shieldRandom: prep.shieldRandom,
        });
      }
      if (!verifyResult.ok) {
        throw new Error(verifyResult.message);
      }

      setStatus({
        kind: "paid",
        txHash: shieldHash,
        alreadyRecorded: verifyResult.alreadyRecorded,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: (err as Error).message ?? "Something went wrong.",
      });
    }
  }

  async function startInjected() {
    setPickerOpen(false);
    const injected =
      typeof window !== "undefined"
        ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum
        : undefined;
    if (!injected) {
      setStatus({
        kind: "error",
        message:
          "No browser wallet detected. Install MetaMask or Rabby, or use WalletConnect.",
      });
      return;
    }
    await start(injected);
  }

  async function startWalletConnect() {
    setPickerOpen(false);
    if (!walletConnectProjectId) {
      setStatus({
        kind: "error",
        message:
          "WalletConnect isn't configured for this deployment. Use a browser wallet instead.",
      });
      return;
    }
    setStatus({ kind: "working", label: "Loading WalletConnect…" });
    try {
      const { EthereumProvider } = await import(
        "@walletconnect/ethereum-provider"
      );
      const wc = await EthereumProvider.init({
        projectId: walletConnectProjectId,
        chains: [network.chainId],
        showQrModal: true,
        metadata: {
          name: "enwise",
          description: "Pay an invoice privately via RAILGUN.",
          url:
            typeof window !== "undefined" ? window.location.origin : "https://enwise.app",
          icons: [],
        },
      });
      await wc.connect();
      await start(wc as unknown as EIP1193Provider);
    } catch (err) {
      setStatus({
        kind: "error",
        message: (err as Error).message ?? "WalletConnect failed.",
      });
    }
  }

  if (status.kind === "paid") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="rounded-md bg-emerald-50 px-3.5 py-1.5 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200">
          Paid privately ✓
        </span>
        <a
          href={`${network.blockExplorerTxBase}${status.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
        >
          {status.txHash.slice(0, 10)}…{status.txHash.slice(-8)}
        </a>
      </div>
    );
  }

  if (status.kind === "working") {
    return (
      <button
        type="button"
        disabled
        className="cursor-wait rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-zinc-50 opacity-80"
      >
        {status.label}
      </button>
    );
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      {network.isTestnet ? (
        <span className="rounded-sm bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-900 ring-1 ring-amber-200">
          {network.displayName} testnet
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-zinc-50 hover:bg-zinc-800"
      >
        Pay {amountLabel} privately
      </button>
      {pickerOpen ? (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-lg">
          <button
            type="button"
            onClick={startInjected}
            className="block w-full px-3 py-2 text-left hover:bg-zinc-50"
          >
            Browser wallet
            <div className="text-xs text-zinc-500">MetaMask, Rabby, Coinbase</div>
          </button>
          <button
            type="button"
            onClick={startWalletConnect}
            disabled={!walletConnectProjectId}
            className="block w-full border-t border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            WalletConnect
            <div className="text-xs text-zinc-500">
              {walletConnectProjectId
                ? "Mobile wallet via QR code"
                : "Not configured"}
            </div>
          </button>
        </div>
      ) : null}
      {status.kind === "error" ? (
        <span className="max-w-xs rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-900 ring-1 ring-red-200">
          {status.message}
        </span>
      ) : null}
    </div>
  );
}

function hexFromUtf8(s: string): Hex {
  return `0x${Buffer.from(s, "utf8").toString("hex")}` as Hex;
}

function formatUsdc(units: bigint): string {
  const intPart = units / 1_000_000n;
  const fracPart = units % 1_000_000n;
  const cents = (fracPart + 5_000n) / 10_000n;
  if (cents >= 100n) return `${(intPart + 1n).toString()}.00`;
  return `${intPart.toString()}.${cents.toString().padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
