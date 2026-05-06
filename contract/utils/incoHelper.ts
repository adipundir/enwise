import { AttestedComputeSupportedOps, Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';
import { publicClient } from './wallet';
import type { WalletClient, Hex } from 'viem';
import { bytesToHex, pad, toHex } from 'viem';

let zap: any = null;

// Get or initialize the Inco configuration based on the current chain
export async function getConfig() {
  if (zap) return zap;

  const chainId = publicClient.chain.id;
  console.log(`Initializing Inco config for chain: ${chainId}`);

  if (chainId === 31337) {
    zap = await Lightning.localNode(); // Local Anvil node
  } else if (chainId === 84532) {
    zap = await Lightning.latest('testnet', 84532); // Base Sepolia
  }
  else {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  return zap;

}

// Encrypt a value for a specific contract and account
export async function encryptValue({
  value,
  address,
  contractAddress,
}: {
  value: bigint;
  address: `0x${string}`;
  contractAddress: `0x${string}`;
}): Promise<Hex> {
  const zap = await getConfig();

  const encryptedData = await zap.encrypt(value, {
    accountAddress: address,
    dappAddress: contractAddress,
    handleType: handleTypes.euint256,
  });

  // Ensure it's treated as dynamic bytes, not bytes32
  return encryptedData as Hex;
}

// Re-encrypt and decrypt a handle for a specific wallet
// Retries up to maxRetries times with a delay between attempts, since the
// covalidator may not have processed the ciphertext yet.
export async function decryptValue({
  walletClient,
  handle,
  maxRetries = 10,
  retryDelayMs = 3000,
}: {
  walletClient: WalletClient;
  handle: string;
  maxRetries?: number;
  retryDelayMs?: number;
}): Promise<bigint> {
  const zap = await getConfig();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const attestedDecrypt = await zap.attestedDecrypt(
        walletClient,
        [handle],
      );
      return attestedDecrypt[0].plaintext.value;
    } catch (error: any) {
      const isRetryable =
        error.message?.includes('not found') ||
        error.message?.includes('not have been processed yet') ||
        error.message?.includes('Cannot reach threshold');
      if (!isRetryable || attempt === maxRetries) throw error;
      console.log(`  decrypt retry ${attempt}/${maxRetries} — waiting ${retryDelayMs}ms...`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error('unreachable');
}

export const attestedCompute = async ({
  walletClient,
  lhsHandle,
  op,
  rhsPlaintext,
}: {
  walletClient: WalletClient;
  lhsHandle: `0x${string}`;
  op: (typeof AttestedComputeSupportedOps)[keyof typeof AttestedComputeSupportedOps];
  rhsPlaintext: any;
}) => {
  const zap = await getConfig();

  const result = await zap.attestedCompute(
    walletClient as WalletClient,
    lhsHandle as `0x${string}`,
    op,
    rhsPlaintext
  );

  // Convert Uint8Array signatures to hex strings
  const signatures = result.covalidatorSignatures.map((sig: Uint8Array) => bytesToHex(sig));

  // Encode the plaintext value as bytes32
  const encodedValue = pad(toHex(result.plaintext.value ? 1 : 0), { size: 32 });

  // Return in format expected by contract
  return {
    plaintext: result.plaintext.value,
    attestation: {
      handle: result.handle,
      value: encodedValue,
    },
    signature: signatures,
  };
};

// Get a full decryption attestation for on-chain verification
// Returns the handle, encoded value, and covalidator signatures
// Retries up to maxRetries times with a delay between attempts.
export async function getDecryptionAttestation({
  walletClient,
  handle,
  maxRetries = 10,
  retryDelayMs = 3000,
}: {
  walletClient: WalletClient;
  handle: string;
  maxRetries?: number;
  retryDelayMs?: number;
}): Promise<{
  plaintext: bigint;
  decryption: { handle: Hex; value: Hex };
  signatures: Hex[];
}> {
  const zap = await getConfig();

  let result: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await zap.attestedDecrypt(
        walletClient,
        [handle],
      );
      break;
    } catch (error: any) {
      const isRetryable =
        error.message?.includes('not found') ||
        error.message?.includes('not have been processed yet') ||
        error.message?.includes('Cannot reach threshold');
      if (!isRetryable || attempt === maxRetries) throw error;
      console.log(`  attestation retry ${attempt}/${maxRetries} — waiting ${retryDelayMs}ms...`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  const attestation = result[0];

  // Convert Uint8Array signatures to hex strings
  const signatures = attestation.covalidatorSignatures.map(
    (sig: Uint8Array) => bytesToHex(sig)
  );

  // Encode the plaintext value as bytes32
  // For ebool: true=1, false=0
  const rawValue = attestation.plaintext.value;
  const encodedValue = pad(
    toHex(typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : Number(rawValue)),
    { size: 32 }
  );

  return {
    plaintext: typeof rawValue === 'boolean' ? BigInt(rawValue ? 1 : 0) : BigInt(rawValue),
    decryption: {
      handle: attestation.handle as Hex,
      value: encodedValue,
    },
    signatures,
  };
}

// Get the fee required for Inco operations
export async function getFee(): Promise<bigint> {
  const zap = await getConfig();

  const fee = await publicClient.readContract({
    address: zap.executorAddress,
    abi: [
      {
        type: 'function',
        inputs: [],
        name: 'getFee',
        outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
        stateMutability: 'pure',
      },
    ],
    functionName: 'getFee',
  });

  return fee;
}
