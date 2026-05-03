// On-chain RAILGUN test on Sepolia. Self-contained.
//
// Flow:
//   1. Loads (or generates and saves) a test payer EOA at scripts/.test-payer.json
//   2. Checks Sepolia ETH + USDC balance
//   3. If unfunded: prints faucet instructions, exits
//   4. If funded:
//      - Generates a fresh RAILGUN wallet (recipient)
//      - Approves USDC to the RAILGUN proxy
//      - Builds the Shield calldata (same code path as our prepare.ts)
//      - Sends the Shield tx
//      - Waits for receipt
//      - Runs the verify path (same code path as our verify.ts) against the
//        real on-chain Shield event
//      - Reports success/failure
//
// Run: node scripts/railgun-onchain.mjs

import {
  startRailgunEngine,
  createRailgunWallet,
  getRailgunAddress,
  getRailgunWalletPrivateViewingKey,
  unloadWalletByID,
  ArtifactStore,
} from "@railgun-community/wallet";
import {
  RailgunEngine,
  ShieldNote,
  ShieldNoteERC20,
  ByteUtils,
} from "@railgun-community/engine";
import {
  Mnemonic,
  randomBytes as ethersRandomBytes,
  getBytes,
  keccak256,
  Interface,
  Wallet,
  JsonRpcProvider,
  Contract,
  formatEther,
  formatUnits,
  parseUnits,
} from "ethers";
import memdown from "memdown";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import "dotenv/config";

const MemDOWN = memdown.default ?? memdown;
const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const RAILGUN_PROXY = "0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea";
const SHIELD_AMOUNT_USDC = 0.5; // dollars
const PAYER_PATH = new URL("./.test-payer.json", import.meta.url).pathname;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const SHIELD_FN_FRAGMENT =
  "function shield(((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] _shieldRequests) payable";
const SHIELD_EVENT_FRAGMENT =
  "event Shield(uint256 treeNumber,uint256 startPosition," +
  "(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value)[] commitments," +
  "(bytes32[3] encryptedBundle,bytes32 shieldKey)[] shieldCiphertext," +
  "uint256[] fees)";

const shieldFnIface = new Interface([SHIELD_FN_FRAGMENT]);
const shieldEvIface = new Interface([SHIELD_EVENT_FRAGMENT]);
const SHIELD_TOPIC = shieldEvIface.getEvent("Shield").topicHash.toLowerCase();

// ─── Setup ────────────────────────────────────────────────────────────────

function loadOrCreatePayer() {
  if (existsSync(PAYER_PATH)) {
    const j = JSON.parse(readFileSync(PAYER_PATH, "utf8"));
    return new Wallet(j.privateKey);
  }
  const w = Wallet.createRandom();
  mkdirSync(dirname(PAYER_PATH), { recursive: true });
  writeFileSync(PAYER_PATH, JSON.stringify({ privateKey: w.privateKey, address: w.address }, null, 2));
  console.log(`Generated new test payer at ${PAYER_PATH}`);
  return w;
}

async function startEngine() {
  const db = MemDOWN();
  const artifactStore = new ArtifactStore(async () => null, async () => {}, async () => false);
  await startRailgunEngine("enwise", db, false, artifactStore, false, false, ["https://ppoi-agg.horsewithsixlegs.xyz"]);
}

async function generateRailgun(mnemonic) {
  const ENC = randomBytes(32).toString("hex");
  const info = await createRailgunWallet(ENC, mnemonic, undefined);
  const zkAddress = getRailgunAddress(info.id);
  const viewing = Buffer.from(getRailgunWalletPrivateViewingKey(info.id)).toString("hex");
  unloadWalletByID(info.id);
  return { zkAddress, viewing, mnemonic };
}

async function buildShield({ zkAddress, signatureHex, grossUnits, usdcAddress }) {
  const sigBytes = getBytes(signatureHex);
  if (sigBytes.length !== 65) throw new Error("expected 65-byte signature");
  const shieldPrivateKey = keccak256(sigBytes);
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(zkAddress);
  const random = `0x${Buffer.from(randomBytes(16)).toString("hex")}`;
  const note = new ShieldNoteERC20(masterPublicKey, random, grossUnits, usdcAddress);
  const sr = await note.serialize(ByteUtils.hexToBytes(shieldPrivateKey), viewingPublicKey);
  const data = shieldFnIface.encodeFunctionData("shield", [
    [
      {
        preimage: { npk: sr.preimage.npk, token: { tokenType: sr.preimage.token.tokenType, tokenAddress: sr.preimage.token.tokenAddress, tokenSubID: sr.preimage.token.tokenSubID }, value: sr.preimage.value },
        ciphertext: { encryptedBundle: sr.ciphertext.encryptedBundle, shieldKey: sr.ciphertext.shieldKey },
      },
    ],
  ]);
  return { data, random, masterPublicKey };
}

function findMatchedCommitment(receipt, expectedNpk, usdcAddress) {
  const proxyLower = RAILGUN_PROXY.toLowerCase();
  const usdcLower = usdcAddress.toLowerCase();
  const shieldLogs = receipt.logs.filter(
    (l) => l.address.toLowerCase() === proxyLower && l.topics[0]?.toLowerCase() === SHIELD_TOPIC,
  );
  if (shieldLogs.length === 0) return { matched: false, reason: "no Shield event in receipt" };
  for (const log of shieldLogs) {
    const dec = shieldEvIface.decodeEventLog("Shield", log.data, log.topics);
    const commitments = dec.commitments;
    const fees = dec.fees;
    for (let i = 0; i < commitments.length; i++) {
      if (BigInt(commitments[i].npk) === expectedNpk) {
        const tokenAddr = commitments[i].token.tokenAddress.toLowerCase();
        if (tokenAddr !== usdcLower) return { matched: false, reason: `token mismatch (${tokenAddr})` };
        return { matched: true, value: BigInt(commitments[i].value), fee: BigInt(fees[i] ?? 0n) };
      }
    }
  }
  return { matched: false, reason: "no commitment in any Shield event matched expected npk" };
}

// ─── Run ──────────────────────────────────────────────────────────────────

const payer = loadOrCreatePayer();
const provider = new JsonRpcProvider(RPC_URL);
const payerSigner = payer.connect(provider);

console.log(`\nTest payer EOA: ${payer.address}`);
console.log(`RPC: ${RPC_URL.replace(/\/v2\/[^/]+/, "/v2/***")}`);

const ethBal = await provider.getBalance(payer.address);
const usdc = new Contract(SEPOLIA_USDC, ERC20_ABI, provider);
const usdcBal = await usdc.balanceOf(payer.address);
console.log(`Balances: ${formatEther(ethBal)} ETH, ${formatUnits(usdcBal, 6)} USDC`);

const need = parseUnits(SHIELD_AMOUNT_USDC.toString(), 6);
if (ethBal === 0n || usdcBal < need) {
  console.log(`\n⚠ Payer is unfunded. Send these to the address above on Sepolia:`);
  if (ethBal === 0n) console.log(`   • ~0.05 Sepolia ETH for gas — https://www.alchemy.com/faucets/ethereum-sepolia`);
  if (usdcBal < need) console.log(`   • ${SHIELD_AMOUNT_USDC} Sepolia USDC — https://faucet.circle.com (pick Ethereum Sepolia)`);
  console.log(`\nThen re-run: node scripts/railgun-onchain.mjs\n`);
  process.exit(1);
}

console.log("\nStarting engine…");
await startEngine();

// 1. Generate the recipient RAILGUN wallet
const mnemonic = Mnemonic.fromEntropy(ethersRandomBytes(16)).phrase;
const recipient = await generateRailgun(mnemonic);
console.log(`Recipient: ${recipient.zkAddress.slice(0, 16)}…${recipient.zkAddress.slice(-8)}`);

// 2. Sign the canonical message → derives shieldPrivateKey
const sig = await payerSigner.signMessage("RAILGUN_SHIELD");

// 3. Build the Shield calldata
const shield = await buildShield({
  zkAddress: recipient.zkAddress,
  signatureHex: sig,
  grossUnits: need,
  usdcAddress: SEPOLIA_USDC,
});
const expectedNpk = ShieldNote.getNotePublicKey(shield.masterPublicKey, shield.random.replace(/^0x/, ""));
console.log(`Built Shield calldata (${shield.data.length} bytes), expectedNpk=${expectedNpk.toString().slice(0, 16)}…`);

// 4. Approve USDC if needed
const allowance = await usdc.allowance(payer.address, RAILGUN_PROXY);
if (allowance < need) {
  console.log(`Approving ${SHIELD_AMOUNT_USDC} USDC to RAILGUN proxy…`);
  const usdcSigner = usdc.connect(payerSigner);
  const tx = await usdcSigner.approve(RAILGUN_PROXY, need);
  console.log(`  approve tx: ${tx.hash}`);
  await tx.wait();
  console.log(`  approved ✓`);
}

// 5. Send the Shield tx
console.log("Sending Shield tx…");
const shieldTx = await payerSigner.sendTransaction({ to: RAILGUN_PROXY, data: shield.data, value: 0n });
console.log(`  shield tx: ${shieldTx.hash}`);
console.log(`  https://sepolia.etherscan.io/tx/${shieldTx.hash}`);
const receipt = await shieldTx.wait();
console.log(`  mined in block ${receipt.blockNumber}, status=${receipt.status}`);

if (receipt.status !== 1) {
  console.log(`\n✗ FAIL: Shield tx reverted on-chain`);
  process.exit(1);
}

// 6. Run the verifier — same logic as lib/railgun/verify.ts
const m = findMatchedCommitment(receipt, expectedNpk, SEPOLIA_USDC);
if (!m.matched) {
  console.log(`\n✗ FAIL: verifier did not match — ${m.reason}`);
  process.exit(1);
}

const gross = m.value + m.fee;
console.log(`\n✓ Verified Shield event:`);
console.log(`  matched npk: yes`);
console.log(`  shielded value: ${formatUnits(m.value, 6)} USDC`);
console.log(`  protocol fee:   ${formatUnits(m.fee, 6)} USDC`);
console.log(`  gross paid:     ${formatUnits(gross, 6)} USDC`);
console.log(`  expected:       ${formatUnits(need, 6)} USDC`);
if (gross !== need) {
  console.log(`\n✗ FAIL: gross != expected (off by ${gross - need})`);
  process.exit(1);
}

console.log(`\n✓✓ END-TO-END PASS — Shield prepared, sent, verified.`);
console.log(`\nRecipient mnemonic (would be returned to user once):`);
console.log(`  ${mnemonic}`);
process.exit(0);
