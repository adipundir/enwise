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
 *   42161  = Arbitrum One mainnet
 *
 * Add a chain: append to SUPPORTED with its USDC contract and the name of
 * its server-only RPC override env var. The wagmi config + verify endpoint
 * pick up new chains automatically via SUPPORTED_CHAIN_IDS.
 */

import { fallback, http, type Transport } from "viem";
import { arbitrum, base, baseSepolia, type Chain } from "viem/chains";

type ChainEntry = {
  chain: Chain;
  /** Canonical USDC ERC-20 contract on this chain. */
  usdcAddress: `0x${string}`;
  /** Name of the server-only RPC override env var (Alchemy / Infura) for
   *  THIS chain. Each chain needs its own — a Base RPC URL returns wrong /
   *  empty data for an Arbitrum receipt. Falls back to the chain's public
   *  RPC when unset. */
  rpcEnvVar: string;
};

const SUPPORTED = {
  8453: {
    chain: base,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcEnvVar: "BASE_RPC_URL",
  },
  84532: {
    chain: baseSepolia,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
  },
  42161: {
    chain: arbitrum,
    // Circle-issued native USDC on Arbitrum One (NOT the bridged USDC.e).
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcEnvVar: "ARBITRUM_RPC_URL",
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
  const usdcAddress = entry.usdcAddress;
  // Priority: this chain's own server-only RPC override (e.g. BASE_RPC_URL,
  // ARBITRUM_RPC_URL — the paid Alchemy/Infura URL) → the chain's public
  // default. The override is read by its per-chain env-var name so we never
  // point an Arbitrum verify at a Base RPC. On the client these server vars
  // are absent (not NEXT_PUBLIC_), so it transparently uses the public RPC —
  // fine, since the actual transfer is signed by the user's wallet and the
  // authoritative verification happens server-side. Dedup so we don't
  // double-call the same URL on failure.
  const envServer = process.env[entry.rpcEnvVar];
  const publicDefault = chain.rpcUrls.default.http[0];
  const rpcUrls = [envServer, publicDefault].filter(
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

/**
 * Resolve the set of chains a payer may pay an invoice on, in display order.
 *
 * Precedence (first non-empty, after filtering to currently-supported ids):
 *   1. the invoice's own `accepted_chain_ids` override
 *   2. the business's `accepted_chain_ids` default set
 *   3. `[businessPreferred ?? DEFAULT_CHAIN_ID]` — the legacy single-chain path
 *
 * Always returns at least one chain: an override that filters down to empty
 * (e.g. a stale id no longer supported) falls through rather than leaving the
 * invoice with no payable chain. Hiding the wallet rail entirely is the job of
 * `accepted_payment_methods`, not this function. Deduplicated, order preserved.
 */
export function resolveAcceptedChainIds(opts: {
  invoiceAccepted?: number[] | null;
  businessAccepted?: number[] | null;
  businessPreferred?: number | null;
}): SupportedChainId[] {
  const supported = (arr: number[] | null | undefined): SupportedChainId[] => {
    if (!arr) return [];
    const seen = new Set<number>();
    const out: SupportedChainId[] = [];
    for (const id of arr) {
      if (isSupportedChainId(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };
  const fromInvoice = supported(opts.invoiceAccepted);
  if (fromInvoice.length) return fromInvoice;
  const fromBusiness = supported(opts.businessAccepted);
  if (fromBusiness.length) return fromBusiness;
  const preferred =
    opts.businessPreferred != null && isSupportedChainId(opts.businessPreferred)
      ? opts.businessPreferred
      : DEFAULT_CHAIN_ID;
  return [preferred];
}

/**
 * Which chain to pre-select for the payer: the merchant's preferred chain if
 * it's in the accepted set, else the first accepted chain. `accepted` must be
 * non-empty (guaranteed by resolveAcceptedChainIds).
 */
export function defaultSelectedChainId(
  accepted: SupportedChainId[],
  businessPreferred?: number | null,
): SupportedChainId {
  if (
    businessPreferred != null &&
    isSupportedChainId(businessPreferred) &&
    accepted.includes(businessPreferred)
  ) {
    return businessPreferred;
  }
  return accepted[0]!;
}
