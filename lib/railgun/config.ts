import "server-only";
import { NetworkName } from "@railgun-community/shared-models";

/**
 * Single source of truth for the chain RAILGUN payments run on.
 *
 * Switched at build/deploy time via env:
 *   - RAILGUN_NETWORK=mainnet (or unset)  → Ethereum mainnet
 *   - RAILGUN_NETWORK=sepolia              → Ethereum Sepolia testnet
 *
 * Any other value throws. Silent fallback to mainnet for typos
 * (sepoolia, polygon, arbitrum) is the kind of bug that drains real
 * funds — explicit list, explicit error.
 *
 * Why testnet exists: shielding on mainnet costs gas + USDC, so e2e tests
 * happen on Sepolia where gas is free and Circle hands out USDC.
 */

export type RailgunNetworkConfig = {
  chainId: number;
  network: NetworkName;
  /** RAILGUN smart wallet proxy. Token allowances + shield calls go here. */
  railgunProxy: `0x${string}`;
  usdcAddress: `0x${string}`;
  rpcEnvVar: string;
  defaultRpcUrl: string;
  blockExplorerTxBase: string;
  displayName: string;
  isTestnet: boolean;
};

const MAINNET: RailgunNetworkConfig = {
  chainId: 1,
  network: NetworkName.Ethereum,
  railgunProxy: "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9",
  usdcAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  rpcEnvVar: "ETH_RPC_URL",
  defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
  blockExplorerTxBase: "https://etherscan.io/tx/",
  displayName: "Ethereum",
  isTestnet: false,
};

const SEPOLIA: RailgunNetworkConfig = {
  chainId: 11_155_111,
  network: NetworkName.EthereumSepolia,
  railgunProxy: "0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea",
  // Circle's official Sepolia USDC. Faucet: faucet.circle.com.
  usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  rpcEnvVar: "SEPOLIA_RPC_URL",
  defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  blockExplorerTxBase: "https://sepolia.etherscan.io/tx/",
  displayName: "Ethereum Sepolia",
  isTestnet: true,
};

const SUPPORTED: Record<string, RailgunNetworkConfig> = {
  "": MAINNET, // unset = mainnet
  mainnet: MAINNET,
  ethereum: MAINNET,
  sepolia: SEPOLIA,
};

export function activeRailgunNetwork(): RailgunNetworkConfig {
  const choice = (process.env.RAILGUN_NETWORK ?? "").toLowerCase();
  const cfg = SUPPORTED[choice];
  if (!cfg) {
    throw new Error(
      `Unsupported RAILGUN_NETWORK="${process.env.RAILGUN_NETWORK}". ` +
        `Allowed: ${Object.keys(SUPPORTED).filter(Boolean).join(", ")} (or unset for mainnet).`,
    );
  }
  return cfg;
}

export function rpcUrlFor(cfg: RailgunNetworkConfig): string {
  return process.env[cfg.rpcEnvVar] ?? cfg.defaultRpcUrl;
}

/**
 * Ordered RPC URLs for resilient calls — primary first (Alchemy / paid
 * provider via env), public publicnode.com second. Callers should try
 * each in order on failure. If no env var is set, returns just the
 * public URL.
 *
 * Server-only by construction: the env-var URL contains an API key in
 * the path, so it must NEVER be sent to the browser. Don't add a
 * NEXT_PUBLIC_ alias.
 */
export function rpcUrlsFor(cfg: RailgunNetworkConfig): string[] {
  const envUrl = process.env[cfg.rpcEnvVar];
  if (!envUrl || envUrl === cfg.defaultRpcUrl) {
    return [cfg.defaultRpcUrl];
  }
  return [envUrl, cfg.defaultRpcUrl];
}

/**
 * Public-safe view of the active config — no env-secret URLs, just chain
 * identifiers + addresses + display strings. Safe to ship to the browser.
 */
export type PublicRailgunNetwork = {
  chainId: number;
  railgunProxy: string;
  usdcAddress: string;
  blockExplorerTxBase: string;
  displayName: string;
  isTestnet: boolean;
};

export function publicRailgunNetwork(): PublicRailgunNetwork {
  const cfg = activeRailgunNetwork();
  return {
    chainId: cfg.chainId,
    railgunProxy: cfg.railgunProxy,
    usdcAddress: cfg.usdcAddress,
    blockExplorerTxBase: cfg.blockExplorerTxBase,
    displayName: cfg.displayName,
    isTestnet: cfg.isTestnet,
  };
}
