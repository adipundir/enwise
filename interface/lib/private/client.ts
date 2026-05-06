/**
 * private payments engine SDK singleton.
 *
 * Initialized once per server process. `Lightning.latest()` does NOT take a
 * wallet — encryption is pure crypto, no signing. The relayer wallet is
 * loaded separately from `./relayer.ts` only when an on-chain tx or
 * `attestedCompute` is needed.
 */

import { Lightning } from "@inco/js/lite";

// private payments SDK accepts these network identifiers. Mainnet does NOT yet exist as
// a public private payments network — when it ships, a new identifier will appear here.
type PrivatePaymentsNetwork = "testnet" | "demonet" | "alphanet" | "devnet";

// Chain IDs the private payments SDK supports. Base Sepolia = 84532 (the one we use); the
// others are private payments testnets / partner chains. Narrowing here so the
// SDK type-checks at the call site.
type PrivatePaymentsChainId = 84532 | 9746 | 10143 | 4801;
const PRIVATE_PAYMENTS_CHAIN_IDS: readonly PrivatePaymentsChainId[] = [84532, 9746, 10143, 4801] as const;

let _zap: Awaited<ReturnType<typeof Lightning.latest>> | null = null;

export async function getZap() {
  if (_zap) return _zap;

  const networkRaw = process.env.PRIVATE_PAYMENTS_NETWORK ?? "testnet";
  const validNetworks: PrivatePaymentsNetwork[] = ["testnet", "demonet", "alphanet", "devnet"];
  if (!validNetworks.includes(networkRaw as PrivatePaymentsNetwork)) {
    throw new Error(
      `PRIVATE_PAYMENTS_NETWORK must be one of ${validNetworks.join(", ")} (got ${networkRaw})`,
    );
  }
  const network = networkRaw as PrivatePaymentsNetwork;

  const chainIdRaw = process.env.PRIVATE_PAYMENTS_CHAIN_ID;
  if (!chainIdRaw) {
    throw new Error("PRIVATE_PAYMENTS_CHAIN_ID is required (84532 for Base Sepolia)");
  }
  const parsed = Number(chainIdRaw);
  if (!PRIVATE_PAYMENTS_CHAIN_IDS.includes(parsed as PrivatePaymentsChainId)) {
    throw new Error(
      `PRIVATE_PAYMENTS_CHAIN_ID must be one of ${PRIVATE_PAYMENTS_CHAIN_IDS.join(", ")} (got ${chainIdRaw})`,
    );
  }
  const chainId = parsed as PrivatePaymentsChainId;

  _zap = await Lightning.latest(network, chainId);
  return _zap;
}

/** Reads the contract address from env. Throws if unset. */
export function getEnwisePayAddress(): `0x${string}` {
  const a = process.env.ENWISE_PAY_ADDRESS;
  if (!a) throw new Error("ENWISE_PAY_ADDRESS is not set; deploy EnwisePay first");
  return a as `0x${string}`;
}

/** Reads the relayer's public address from env. */
export function getRelayerAddress(): `0x${string}` {
  const a = process.env.RELAYER_EOA_ADDRESS;
  if (!a) throw new Error("RELAYER_EOA_ADDRESS is not set");
  return a as `0x${string}`;
}

/** private payments chain id as a number. */
export function getPrivatePaymentsChainId(): number {
  return Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID ?? 84532);
}
