/**
 * private payments SDK connectivity smoke test.
 *
 * Run: `make smoke-private`
 *
 * Verifies:
 *  - Lightning.latest() initialises against testnet+chainId from env
 *  - executor address is reachable
 *  - encrypt() produces ciphertext bytes for a placeholder recipient
 */

import "dotenv/config";
import { getZap } from "@/lib/private/client";
import { encryptRecipient } from "@/lib/private/encrypt";

async function main() {
  console.log("PRIVATE_PAYMENTS_NETWORK    :", process.env.PRIVATE_PAYMENTS_NETWORK);
  console.log("PRIVATE_PAYMENTS_CHAIN_ID   :", process.env.PRIVATE_PAYMENTS_CHAIN_ID);
  console.log("RELAYER_EOA     :", process.env.RELAYER_EOA_ADDRESS || "(unset)");
  console.log("ENWISE_PAY      :", process.env.ENWISE_PAY_ADDRESS || "(unset, deploy first)");

  const zap = await getZap();
  console.log("\n✅ Lightning.latest initialised");
  console.log("   executor addr:", zap.executorAddress);

  if (!process.env.RELAYER_EOA_ADDRESS || !process.env.ENWISE_PAY_ADDRESS) {
    console.log("\n⚠ Set RELAYER_EOA_ADDRESS and ENWISE_PAY_ADDRESS to test encryption");
    return;
  }

  const sample = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const ct = await encryptRecipient(sample);
  console.log("\n✅ encryptRecipient OK");
  console.log("   ct length :", ct.length, "chars (=", (ct.length - 2) / 2, "bytes)");
  console.log("   ct prefix :", ct.slice(0, 32) + "...");
}

main().catch((e) => {
  console.error("\n❌ smoke-private failed:", e);
  process.exit(1);
});
