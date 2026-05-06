/**
 * Relayer wallet client. Submits payInvoice + sweep transactions on behalf of
 * payers and merchants.
 *
 * DEV: reads RELAYER_PRIVATE_KEY from env directly.
 *
 * PROD MIGRATION POINT: replace `privateKeyToAccount(pk)` below with a
 * KMS-backed signer (AWS KMS via @aws-sdk/client-kms + @latticexyz/aws-kms-account,
 * or Privy server wallet, or Coinbase MPC). The rest of the file does not
 * need to change — viem custom-signer wrappers expose the same `Account`
 * interface.
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

// Cached clients. Stored as `unknown` to dodge the duplicate-viem-types
// conflict that surfaces when @inco/js (which depends on viem) and our own
// viem dep aren't deduped — both `PublicClient` types are structurally
// identical but TS sees them as nominally distinct. Runtime is fine.
let _walletClient: unknown = null;
let _publicClient: unknown = null;

function chainFor(chainId: number) {
  if (chainId === 84532) return baseSepolia;
  if (chainId === 8453) return base;
  throw new Error(`Unsupported chain id ${chainId} for relayer`);
}

function rpcUrl() {
  return process.env.BASE_RPC_URL ?? "https://sepolia.base.org";
}

/**
 * Returns a viem WalletClient configured to send transactions as the relayer.
 * Lazy-initialised; safe to call from any server-side handler.
 */
export function getRelayerWallet(): ReturnType<typeof createWalletClient> {
  if (_walletClient) return _walletClient as ReturnType<typeof createWalletClient>;

  const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID ?? 84532);
  const chain = chainFor(chainId);

  // ─── KMS migration point ──────────────────────────────────────────────────
  const pk = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) {
    throw new Error(
      "RELAYER_PRIVATE_KEY is not set. In dev, populate interface/.env. " +
      "In prod, swap this block for a KMS-backed signer."
    );
  }
  const account = privateKeyToAccount(pk);
  // ──────────────────────────────────────────────────────────────────────────

  _walletClient = createWalletClient({ account, chain, transport: http(rpcUrl()) });
  return _walletClient as ReturnType<typeof createWalletClient>;
}

export function getPublicClient(): ReturnType<typeof createPublicClient> {
  if (_publicClient) return _publicClient as ReturnType<typeof createPublicClient>;
  const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID ?? 84532);
  _publicClient = createPublicClient({ chain: chainFor(chainId), transport: http(rpcUrl()) });
  return _publicClient as ReturnType<typeof createPublicClient>;
}
