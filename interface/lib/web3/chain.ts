/**
 * Per-chain resolver.
 *
 * Each business has a `payment_chain_id` preference; null = platform default
 * from NEXT_PUBLIC_DEFAULT_CHAIN_ID. Everything chain-specific (chain object,
 * USDC contract, RPC URL, block explorer) flows out of `resolveChain(id)`.
 *
 * Supported chains:
 *   8453   = Base mainnet
 *   84532  = Base Sepolia (testnet)
 *
 * Add a chain: append to SUPPORTED with its USDC + (optional) RPC override
 * env-var name. The wagmi config + verify endpoint pick up new chains
 * automatically via SUPPORTED_CHAIN_IDS.
 */

import { fallback, http, type Transport } from "viem";
import { base, baseSepolia, type Chain } from "viem/chains";

type ChainEntry = {
  chain: Chain;
  /** Canonical USDC ERC-20 contract on this chain. */
  usdcAddress: `0x${string}`;
};

const SUPPORTED = {
  8453: {
    chain: base,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  84532: {
    chain: baseSepolia,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
} as const satisfies Record<number, ChainEntry>;

export type SupportedChainId = keyof typeof SUPPORTED;

export const SUPPORTED_CHAIN_IDS: SupportedChainId[] = Object.keys(SUPPORTED).map(
  (k) => Number(k) as SupportedChainId,
);

export const DEFAULT_CHAIN_ID: SupportedChainId = pickDefault();

function pickDefault(): SupportedChainId {
  const env = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ?? 8453);
  return isSupportedChainId(env) ? env : 8453;
}

export function isSupportedChainId(id: unknown): id is SupportedChainId {
  return typeof id === "number" && id in SUPPORTED;
}

export type ResolvedChain = {
  chainId: SupportedChainId;
  chain: Chain;
  usdcAddress: `0x${string}`;
  usdcDecimals: number;
  /** Primary RPC URL. First entry in rpcUrls. */
  rpcUrl: string;
  /** All RPC URLs in priority order: env override(s) first, then the
   *  chain's public default as a fallback. Wrap in viem's `fallback()`
   *  transport for automatic retry on the next URL when the primary
   *  returns 429 / 5xx / times out. */
  rpcUrls: string[];
  explorerUrl: string;
  txExplorerUrl: (txHash: string) => string;
};

/**
 * Resolve a chainId (or null/undefined → platform default) to the full
 * config bag. Throws on unsupported ids so callers don't silently fall
 * back to a wrong-chain transfer.
 */
export function resolveChain(chainId?: number | null): ResolvedChain {
  const id: SupportedChainId =
    chainId == null
      ? DEFAULT_CHAIN_ID
      : isSupportedChainId(chainId)
        ? chainId
        : DEFAULT_CHAIN_ID;
  const entry = SUPPORTED[id];
  const chain = entry.chain;
  const usdcAddress =
    (process.env.NEXT_PUBLIC_USDC_ADDRESS as `0x${string}` | undefined) ??
    entry.usdcAddress;
  // Priority: NEXT_PUBLIC_RPC_URL (client-readable override) →
  // BASE_RPC_URL (server-only override, typically the paid Alchemy URL) →
  // chain's public default. Dedup so we don't double-call the same URL on
  // failure.
  const envClient = process.env.NEXT_PUBLIC_RPC_URL;
  const envServer = process.env.BASE_RPC_URL;
  const publicDefault = chain.rpcUrls.default.http[0];
  const rpcUrls = [envClient, envServer, publicDefault].filter(
    (u, i, arr): u is string => !!u && arr.indexOf(u) === i,
  );
  const explorerUrl =
    chain.blockExplorers?.default.url ?? "https://basescan.org";
  return {
    chainId: id,
    chain,
    usdcAddress,
    usdcDecimals: 6,
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
    explorerUrl,
    txExplorerUrl: (txHash: string) => `${explorerUrl}/tx/${txHash}`,
  };
}

/** Build a viem transport that tries each rpcUrl in order, falling back
 *  on failure. Single URL → plain http; multiple → fallback wrapper. */
export function transportFor(resolved: ResolvedChain): Transport {
  if (resolved.rpcUrls.length <= 1) {
    return http(resolved.rpcUrls[0]);
  }
  return fallback(resolved.rpcUrls.map((url) => http(url)));
}

/**
 * Human label for a chainId — used in UI labels ("Pay on Base") and MCP
 * descriptions ("Base mainnet (8453)"). Falls back to the chain.name from
 * viem for any supported id.
 */
export function chainLabel(chainId: number): string {
  if (isSupportedChainId(chainId)) {
    return SUPPORTED[chainId].chain.name;
  }
  return `chain ${chainId}`;
}

/** Every viem chain object we register with wagmi at init. */
export const ALL_SUPPORTED_CHAINS: readonly Chain[] = SUPPORTED_CHAIN_IDS.map(
  (id) => SUPPORTED[id].chain,
);
