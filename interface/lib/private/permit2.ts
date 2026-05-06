/**
 * Permit2 EIP-712 witness signing for invoice payments.
 *
 * The witness binds the signature to a specific (slug, ctCommit, settlement,
 * expiry) tuple — even if a relayer is compromised it can't redirect funds
 * to a different invoice or contract.
 *
 * Permit2 is the same address on every EVM chain (CREATE2 deployment):
 * https://github.com/Uniswap/permit2
 */

import {
  type WalletClient,
  hashTypedData,
} from "viem";

export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export type Permit2TokenPermissions = {
  token: `0x${string}`;
  amount: bigint;
};

export type Permit2PermitTransferFrom = {
  permitted: Permit2TokenPermissions;
  nonce: bigint;
  deadline: bigint;
};

export type InvoiceWitness = {
  slug: `0x${string}`;
  ctCommit: `0x${string}`;
  settlement: `0x${string}`;
  expiry: bigint;
};

const TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "InvoicePayment" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  InvoicePayment: [
    { name: "slug", type: "bytes32" },
    { name: "ctCommit", type: "bytes32" },
    { name: "settlement", type: "address" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

function buildDomain(chainId: number) {
  return {
    name: "Permit2",
    chainId: BigInt(chainId),
    verifyingContract: PERMIT2_ADDRESS,
  } as const;
}

function buildMessage(
  permit: Permit2PermitTransferFrom,
  spender: `0x${string}`,
  witness: InvoiceWitness,
) {
  return {
    permitted: { token: permit.permitted.token, amount: permit.permitted.amount },
    spender,
    nonce: permit.nonce,
    deadline: permit.deadline,
    witness: {
      slug: witness.slug,
      ctCommit: witness.ctCommit,
      settlement: witness.settlement,
      expiry: witness.expiry,
    },
  };
}

/** Sign the witness-bound PermitTransferFrom typed data with a wallet client. */
export async function signPermit2InvoiceWitness(opts: {
  walletClient: WalletClient;
  account: `0x${string}`;
  chainId: number;
  spender: `0x${string}`; // EnwisePay contract
  permit: Permit2PermitTransferFrom;
  witness: InvoiceWitness;
}): Promise<`0x${string}`> {
  return opts.walletClient.signTypedData({
    account: opts.account,
    domain: buildDomain(opts.chainId),
    types: TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: buildMessage(opts.permit, opts.spender, opts.witness),
  });
}

/** Hash the typed data — useful for off-chain verification / debugging. */
export function hashPermit2InvoiceWitness(opts: {
  chainId: number;
  spender: `0x${string}`;
  permit: Permit2PermitTransferFrom;
  witness: InvoiceWitness;
}): `0x${string}` {
  return hashTypedData({
    domain: buildDomain(opts.chainId),
    types: TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: buildMessage(opts.permit, opts.spender, opts.witness),
  });
}

/** Random 256-bit Permit2 nonce. Permit2's nonce space is bitmap-based, so
 *  collision in 2^256 is practically impossible. */
export function generatePermit2Nonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}
