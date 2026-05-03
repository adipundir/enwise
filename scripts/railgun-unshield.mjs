// RAILGUN unshield test on Sepolia.
//
// Demonstrates that the wallet our app mints is a fully-functional RAILGUN
// wallet — a third-party RAILGUN-compatible client (or this script standing
// in for one) can load it from mnemonic, see the shielded balance, generate
// a zkSNARK proof, and unshield USDC back out to any 0x address.
//
// Note: our production app does NOT do this. The mnemonic is returned to
// the user; spending is their responsibility via Railway Wallet or any
// compliant RAILGUN client. This script proves the receiving side is real.
//
// Run: node scripts/railgun-unshield.mjs <recipient-mnemonic>

import {
  startRailgunEngine,
  createRailgunWallet,
  loadProvider,
  setLoggers,
  getProver,
  ArtifactStore,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  setOnTXIDMerkletreeScanCallback,
  refreshBalances,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
  gasEstimateForUnprovenUnshieldToOrigin,
  generateUnshieldToOriginProof,
  populateProvedUnshieldToOrigin,
  getERC20AndNFTAmountRecipientsForUnshieldToOrigin,
  refreshReceivePOIsForWallet,
  refreshSpentPOIsForWallet,
  generatePOIsForWallet,
  getTXOsReceivedPOIStatusInfoForWallet,
} from "@railgun-community/wallet";
import {
  NetworkName,
  NETWORK_CONFIG,
  TXIDVersion,
  EVMGasType,
  RailgunWalletBalanceBucket,
  getEVMGasTypeForTransaction,
} from "@railgun-community/shared-models";
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  formatEther,
  formatUnits,
  parseUnits,
} from "ethers";
import { groth16 } from "snarkjs";
import memdown from "memdown";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import "dotenv/config";

const MemDOWN = memdown.default ?? memdown;
// Use publicnode.com instead of Alchemy here. Alchemy free tier caps
// eth_getLogs to 10-block ranges, and the RAILGUN merkle scan needs to
// fetch ~5M blocks of events on Sepolia. Hitting the cap leaves the local
// merkle tree incomplete → proof against wrong root → "Invalid Snark Proof".
const RPC_URL = process.env.SEPOLIA_RPC_URL_FOR_SCAN ?? "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const PAYER_PATH = new URL("./.test-payer.json", import.meta.url).pathname;
const ARTIFACTS_DIR = "/tmp/railgun-artifacts-test";
const NETWORK = NetworkName.EthereumSepolia;
const CHAIN = NETWORK_CONFIG[NETWORK].chain;
const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;

const mnemonic = process.argv[2];
if (!mnemonic || mnemonic.split(" ").length !== 12) {
  console.error("Usage: node scripts/railgun-unshield.mjs '<12-word mnemonic>'");
  process.exit(1);
}

// Payer EOA — pays gas for the unshield tx (sendWithPublicWallet=true).
const payer = new Wallet(JSON.parse(readFileSync(PAYER_PATH, "utf8")).privateKey);
console.log(`Gas-paying EOA: ${payer.address}`);

// Fresh recipient EOA so we prove free-unshield to any address (not just
// back-to-shielder, which would only test the POI standby exit path).
const recipientEOA = Wallet.createRandom();
console.log(`Unshield destination: ${recipientEOA.address} (fresh, never seen before)`);

// ─── Real artifact store (filesystem, /tmp) ────────────────────────────────
mkdirSync(ARTIFACTS_DIR, { recursive: true });
const artifactStore = new ArtifactStore(
  async (key) => {
    try {
      return await fs.readFile(path.join(ARTIFACTS_DIR, key));
    } catch {
      return null;
    }
  },
  async (_dir, key, value) => {
    const target = path.join(ARTIFACTS_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === "string" ? value : Buffer.from(value));
  },
  async (key) => {
    try {
      await fs.access(path.join(ARTIFACTS_DIR, key));
      return true;
    } catch {
      return false;
    }
  },
);

// ─── Logging ───────────────────────────────────────────────────────────────
let lastScanProgress = -1;
setLoggers(
  () => {}, // info — too noisy
  (err) => console.error("[engine error]", err),
);

// ─── Start engine + load Sepolia provider ──────────────────────────────────
console.log("\nStarting engine…");
const t0 = Date.now();
await startRailgunEngine(
  "enwise",
  MemDOWN(),
  false,
  artifactStore,
  false,
  false,
  ["https://ppoi-agg.horsewithsixlegs.xyz"],
);
console.log(`  engine ready in ${Date.now() - t0}ms`);

// snarkjs prover for proof generation
getProver().setSnarkJSGroth16(groth16);
console.log(`  snarkjs prover loaded`);

// Load Sepolia provider
console.log(`  connecting to Sepolia (${RPC_URL.replace(/\/v2\/[^/]+/, "/v2/***")})…`);
const fallback = {
  chainId: CHAIN.id,
  providers: [{ provider: RPC_URL, priority: 1, weight: 2 }],
};
const t1 = Date.now();
await loadProvider(fallback, NETWORK, 10_000);
console.log(`  provider loaded in ${Date.now() - t1}ms`);

// ─── Recreate wallet from mnemonic ─────────────────────────────────────────
console.log("\nRecreating wallet from mnemonic…");
const ENC = randomBytes(32).toString("hex");
const walletInfo = await createRailgunWallet(ENC, mnemonic, undefined);
console.log(`  wallet id: ${walletInfo.id.slice(0, 16)}…`);

// ─── Scan balances ─────────────────────────────────────────────────────────
console.log("\nScanning merkle tree (this can take a few minutes on first run)…");
const balancesByBucket = new Map();
let utxoMerkleComplete = false; // tree state fully synced (matters for proof root)
let balanceUpdateReceived = false; // wallet's UTXOs decrypted (matters for amount)

setOnUTXOMerkletreeScanCallback((evt) => {
  const pct = Math.round((evt.progress ?? 0) * 100);
  if (pct !== lastScanProgress && (pct % 10 === 0 || pct >= 95)) {
    lastScanProgress = pct;
    process.stdout.write(`\r  UTXO scan: ${pct}% (${evt.scanStatus})    `);
  }
  if (evt.scanStatus === "Complete") {
    utxoMerkleComplete = true;
  }
});
setOnTXIDMerkletreeScanCallback(() => {});
setOnBalanceUpdateCallback((evt) => {
  if (evt.railgunWalletID !== walletInfo.id) return;
  balancesByBucket.set(evt.balanceBucket, evt);
  balanceUpdateReceived = true;
});

const scanStart = Date.now();
await refreshBalances(CHAIN, [walletInfo.id]);

// Wait for BOTH the merkle tree scan to fully complete AND the wallet
// balance update to arrive. Previously we exited on balance update alone,
// which fires as soon as the wallet's UTXOs are decrypted — but that
// happens BEFORE the global merkle tree finishes syncing to current head.
// Generating a proof against an incomplete tree produces an invalid root.
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
while (!utxoMerkleComplete || !balanceUpdateReceived) {
  if (Date.now() - scanStart > SCAN_TIMEOUT_MS) {
    console.log(`\n  scan timed out after 10 min (merkleComplete=${utxoMerkleComplete}, balanceReceived=${balanceUpdateReceived})`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
process.stdout.write(`\n  scan complete in ${Math.round((Date.now() - scanStart) / 1000)}s (merkletree=Complete, balance updated)\n`);

// ─── Report balances by bucket ─────────────────────────────────────────────
console.log("\nBalance buckets:");
for (const [bucket, evt] of balancesByBucket) {
  const usdcEntry = evt.erc20Amounts?.find(
    (e) => e.tokenAddress.toLowerCase() === SEPOLIA_USDC.toLowerCase(),
  );
  const amt = usdcEntry ? formatUnits(usdcEntry.amount, 6) : "0";
  console.log(`  ${bucket.padEnd(20)} ${amt} USDC`);
}

const spendable = balancesByBucket.get(RailgunWalletBalanceBucket.Spendable);
const shieldPending = balancesByBucket.get(RailgunWalletBalanceBucket.ShieldPending);
const spendableUSDC = spendable?.erc20Amounts?.find(
  (e) => e.tokenAddress.toLowerCase() === SEPOLIA_USDC.toLowerCase(),
);
const pendingUSDC = shieldPending?.erc20Amounts?.find(
  (e) => e.tokenAddress.toLowerCase() === SEPOLIA_USDC.toLowerCase(),
);

// Pick the bucket with non-zero amount. Both buckets typically appear in
// the callback even when one is empty.
const spendableAmt = spendableUSDC?.amount ?? 0n;
const pendingAmt = pendingUSDC?.amount ?? 0n;

let unshieldAmount;
let standby;
if (spendableAmt > 0n) {
  unshieldAmount = spendableAmt;
  standby = false;
  console.log(`\n✓ Funds are Spendable: ${formatUnits(spendableAmt, 6)} USDC. Free unshield to any address allowed.`);

  // Belt-and-suspenders POI refresh. Spendable bucket means POI is complete
  // per the docs, but the on-chain proof verification can still fail if the
  // engine's merkle tree view is behind. Force a refresh.
  console.log("\nRefreshing POIs for wallet…");
  await refreshReceivePOIsForWallet(TXID_VERSION, NETWORK, walletInfo.id);
  await refreshSpentPOIsForWallet(TXID_VERSION, NETWORK, walletInfo.id);
  await generatePOIsForWallet(NETWORK, walletInfo.id);
  const poiStatus = await getTXOsReceivedPOIStatusInfoForWallet(TXID_VERSION, NETWORK, walletInfo.id);
  console.log(`  received POI status entries: ${poiStatus.length}`);
  for (const s of poiStatus) console.log(`    txid=${s.txidIndex ?? "?"}, blindedCommitment=${s.blindedCommitment?.slice(0, 16) ?? "?"}…, status=${JSON.stringify(s.strings ?? s)}`);
} else if (pendingAmt > 0n) {
  unshieldAmount = pendingAmt;
  standby = true;
  console.log(`\n⏳ Funds in ShieldPending: ${formatUnits(pendingAmt, 6)} USDC. POI standby, unshield only back to shielder.`);
} else {
  console.log(`\n✗ No spendable USDC found. Cannot unshield.`);
  process.exit(1);
}

// Original Shield txid — required for unshieldToOrigin path during POI standby.
const ORIGINAL_SHIELD_TXID = "0xfb096f93345eb91a6fa05103fdd42b1ae4617bc5719ef361997198316938b62d";

// Encode our own wallet's 0zk address — used as broadcaster fee recipient
// when going through the proper proof path (sendWithPublicWallet: false).
// This forces the SDK to generate POIs and a complete proof bundle.
const recipientZkAddress = await import("@railgun-community/wallet").then(
  (m) => m.getRailgunAddress(walletInfo.id),
);
console.log(`Self-broadcaster fee target: ${recipientZkAddress.slice(0,16)}…${recipientZkAddress.slice(-6)}`);

const provider = new JsonRpcProvider(RPC_URL);
const feeData = await provider.getFeeData();
// Sepolia broadcaster path requires Type1 (legacy) gas. Use the SDK helper
// that knows the right type per network + sendWithPublicWallet flag.
const evmGasType = getEVMGasTypeForTransaction(NETWORK, /*sendWithPublicWallet*/ standby ? true : false);
const originalGasDetails = evmGasType === EVMGasType.Type2
  ? {
      evmGasType: EVMGasType.Type2,
      maxFeePerGas: feeData.maxFeePerGas ?? 1_000_000_000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
      gasEstimate: 0n,
    }
  : {
      evmGasType, // Type0 or Type1 (legacy)
      gasPrice: feeData.gasPrice ?? 1_000_000_000n,
      gasEstimate: 0n,
    };
console.log(`Using EVMGasType=${evmGasType} for ${standby ? "self-broadcast (origin path)" : "broadcaster path"}`);

let erc20AmountRecipients;
let gasEstimate;
let populated;

if (standby) {
  console.log(`\nResolving unshield-to-origin recipients from original Shield tx ${ORIGINAL_SHIELD_TXID.slice(0, 12)}…`);
  const recipients = await getERC20AndNFTAmountRecipientsForUnshieldToOrigin(
    TXID_VERSION,
    NETWORK,
    walletInfo.id,
    ORIGINAL_SHIELD_TXID,
  );
  erc20AmountRecipients = recipients.erc20AmountRecipients;
  console.log(`  recipients: ${erc20AmountRecipients.length}`);
  for (const r of erc20AmountRecipients) {
    console.log(`    ${formatUnits(r.amount, 6)} USDC → ${r.recipientAddress}`);
  }

  console.log(`\nGas estimating unshield-to-origin…`);
  try {
    const out = await gasEstimateForUnprovenUnshieldToOrigin(
      ORIGINAL_SHIELD_TXID, TXID_VERSION, NETWORK, walletInfo.id, ENC, erc20AmountRecipients, [],
    );
    gasEstimate = out.gasEstimate;
    console.log(`  gas estimate: ${gasEstimate.toString()}`);
  } catch (e) {
    console.log(`\n✗ gasEstimateForUnprovenUnshieldToOrigin failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nGenerating zkSNARK proof (10-60s)…`);
  const proofStart = Date.now();
  await generateUnshieldToOriginProof(
    ORIGINAL_SHIELD_TXID, TXID_VERSION, NETWORK, walletInfo.id, ENC, erc20AmountRecipients, [], () => {},
  );
  console.log(`  proof generated in ${Math.round((Date.now() - proofStart) / 1000)}s`);

  console.log(`\nPopulating unshield-to-origin transaction…`);
  const gasDetails = { ...originalGasDetails, gasEstimate };
  populated = await populateProvedUnshieldToOrigin(
    TXID_VERSION, NETWORK, walletInfo.id, erc20AmountRecipients, [], gasDetails,
  );
} else {
  // Use SDK-recommended broadcaster-fee path. sendWithPublicWallet=true on
  // POI-active networks (Sepolia, mainnet, Polygon, Arbitrum) skips POI
  // generation in tx-generator.js:102 — the resulting proof is incomplete
  // and the contract rejects it. Workaround: pretend a broadcaster is
  // taking a tiny fee, send to our own 0zk so it loops back to us.
  const FEE = 1n; // 0.000001 USDC, payable to ourselves
  const unshieldNet = unshieldAmount - FEE; // we lose 1 unit to ourselves; net unshielded = total - fee
  erc20AmountRecipients = [
    { tokenAddress: SEPOLIA_USDC, amount: unshieldNet, recipientAddress: recipientEOA.address },
  ];
  const broadcasterFee = {
    tokenAddress: SEPOLIA_USDC,
    amount: FEE,
    recipientAddress: recipientZkAddress,
  };
  console.log(`\nGas estimating unshield of ${formatUnits(unshieldNet, 6)} USDC → ${recipientEOA.address}`);
  console.log(`  + ${FEE.toString()} unit "broadcaster fee" → self (forces full POI proof path)`);

  // 30s breather for any background POI / merkletree commits to settle.
  console.log("\nWaiting 30s for POI/merkletree state to settle…");
  await new Promise((r) => setTimeout(r, 30_000));

  // feeTokenDetails describes the broadcaster's fee policy, distinct from
  // the actual broadcasterFee recipient used in proof generation.
  const feeTokenDetails = {
    tokenAddress: SEPOLIA_USDC,
    feePerUnitGas: 1n,
  };

  const out = await gasEstimateForUnprovenUnshield(
    TXID_VERSION, NETWORK, walletInfo.id, ENC, erc20AmountRecipients, [], originalGasDetails, feeTokenDetails, false,
  );
  gasEstimate = out.gasEstimate;
  console.log(`  gas estimate: ${gasEstimate.toString()}`);

  console.log(`\nGenerating zkSNARK proof (10-60s, includes POI generation)…`);
  const proofStart = Date.now();
  await generateUnshieldProof(
    TXID_VERSION, NETWORK, walletInfo.id, ENC, erc20AmountRecipients, [], broadcasterFee, false, undefined, () => {},
  );
  console.log(`  proof generated in ${Math.round((Date.now() - proofStart) / 1000)}s`);

  console.log(`\nPopulating unshield transaction…`);
  const gasDetails = { ...originalGasDetails, gasEstimate };
  populated = await populateProvedUnshield(
    TXID_VERSION, NETWORK, walletInfo.id, erc20AmountRecipients, [], broadcasterFee, false, undefined, gasDetails,
  );
}

const unshieldDestination = erc20AmountRecipients[0].recipientAddress;

console.log(`\nPopulated transaction full keys:`, Object.keys(populated.transaction));
console.log(`  to:    ${populated.transaction.to}`);
console.log(`  value: ${populated.transaction.value}`);
console.log(`  data:  ${populated.transaction.data ? populated.transaction.data.slice(0, 80) + "…" : "(EMPTY!)"}`);
console.log(`  data length: ${populated.transaction.data?.length ?? 0}`);

if (!populated.transaction.data || populated.transaction.data === "0x" || populated.transaction.data.length < 10) {
  console.log(`\n✗ FAIL: populateProvedUnshield returned empty calldata.`);
  process.exit(1);
}

console.log(`\nSending unshield tx from ${payer.address}…`);
const signer = payer.connect(provider);

// Build a clean ethers TransactionRequest from the ContractTransaction.
// Passing the populated object directly somehow strips the data field.
const txRequest = {
  to: populated.transaction.to,
  data: populated.transaction.data,
  value: populated.transaction.value ?? 0n,
};
const tx = await signer.sendTransaction(txRequest);
console.log(`  tx: ${tx.hash}`);
console.log(`  https://sepolia.etherscan.io/tx/${tx.hash}`);
const receipt = await tx.wait();
console.log(`  mined in block ${receipt.blockNumber}, status=${receipt.status}`);

if (receipt.status !== 1) {
  console.log(`\n✗ FAIL: unshield tx reverted`);
  process.exit(1);
}

// Verify USDC actually arrived at the recipient
const usdc = new Contract(
  SEPOLIA_USDC,
  ["function balanceOf(address) view returns (uint256)"],
  provider,
);
const finalBal = await usdc.balanceOf(unshieldDestination);
console.log(`\n✓✓ UNSHIELD SUCCESS`);
console.log(`   Recipient ${unshieldDestination}`);
console.log(`   USDC balance after unshield: ${formatUnits(finalBal, 6)} USDC`);
process.exit(0);
