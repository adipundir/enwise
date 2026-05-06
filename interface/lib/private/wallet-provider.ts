/**
 * Provider selection for browsers with multiple wallet extensions installed.
 *
 * On Brave, the built-in Brave Wallet hijacks `window.ethereum` by default —
 * even if MetaMask is installed. Same situation if a user has MetaMask +
 * Coinbase Wallet + Rabby simultaneously.
 *
 * Resolution order:
 *  1. EIP-6963 announced providers (modern multi-wallet protocol)
 *  2. `window.ethereum.providers` array (legacy, set by some wallets)
 *  3. `window.ethereum` (single-wallet fallback)
 *
 * Within any list, prefer MetaMask if present, otherwise the first one.
 *
 * Usage in a React component:
 *   const provider = await selectProvider({ prefer: "MetaMask" });
 *   const accounts = await provider.request({ method: "eth_requestAccounts" });
 */

import type { EIP1193Provider } from "viem";

type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
};

type WalletFlags = {
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
};

type FlaggedProvider = EIP1193Provider & WalletFlags;

type AnyEthWindow = Window & {
  ethereum?: FlaggedProvider & {
    providers?: FlaggedProvider[];
  };
};

export type WalletPreference = "MetaMask" | "Coinbase Wallet" | "Rabby" | "any";

export type WalletInfo = {
  provider: EIP1193Provider;
  name: string;
  isBraveWallet: boolean;
};

function nameOf(p: FlaggedProvider): string {
  if (p.isMetaMask && !p.isBraveWallet) return "MetaMask";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isRabby) return "Rabby";
  return "Unknown";
}

/**
 * Discover all wallet providers via EIP-6963. The browser dispatches
 * `eip6963:announceProvider` events synchronously when we ask via
 * `eip6963:requestProvider`. We collect for ~200ms.
 */
async function discover6963(): Promise<EIP6963ProviderDetail[]> {
  if (typeof window === "undefined") return [];
  const found: EIP6963ProviderDetail[] = [];
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<EIP6963ProviderDetail>).detail;
    if (detail?.provider) found.push(detail);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 200));
  window.removeEventListener("eip6963:announceProvider", handler);
  return found;
}

/**
 * Returns the best available wallet, preferring `prefer` if present.
 */
export async function selectProvider(opts: { prefer?: WalletPreference } = {}): Promise<WalletInfo | null> {
  if (typeof window === "undefined") return null;
  const prefer = opts.prefer ?? "MetaMask";

  // 1. EIP-6963.
  const announced = await discover6963();
  if (announced.length > 0) {
    const match =
      prefer !== "any"
        ? announced.find((d) => d.info.name === prefer || d.info.name.toLowerCase().includes(prefer.toLowerCase()))
        : null;
    const pick = match ?? announced[0]!;
    return {
      provider: pick.provider,
      name: pick.info.name,
      isBraveWallet: pick.info.rdns?.includes("brave") ?? false,
    };
  }

  // 2. Legacy multi-provider array.
  const eth = (window as AnyEthWindow).ethereum;
  if (eth?.providers?.length) {
    const list = eth.providers;
    const match = prefer === "MetaMask" ? list.find((p) => p.isMetaMask && !p.isBraveWallet) : null;
    const pick = match ?? list[0]!;
    return { provider: pick, name: nameOf(pick), isBraveWallet: !!pick.isBraveWallet };
  }

  // 3. Single provider.
  if (eth) {
    return { provider: eth, name: nameOf(eth), isBraveWallet: !!eth.isBraveWallet };
  }

  return null;
}
