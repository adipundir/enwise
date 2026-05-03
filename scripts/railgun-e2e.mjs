// End-to-end RAILGUN test harness. Run with: node scripts/railgun-e2e.mjs
// Tests the cryptographic correctness of wallet creation + Shield prepare +
// verify, all without on-chain interaction. The on-chain leg is in
// railgun-onchain.mjs (separate, requires a funded Sepolia EOA).

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
import { Mnemonic, randomBytes as ethersRandomBytes, getBytes, keccak256, Interface, Wallet } from "ethers";
import memdown from "memdown";
import { randomBytes } from "node:crypto";

const MemDOWN = memdown.default ?? memdown;

// Same shape as our setup.ts
async function startEngine() {
  const db = MemDOWN();
  const artifactStore = new ArtifactStore(
    async () => null,
    async () => {},
    async () => false,
  );
  await startRailgunEngine(
    "enwise",
    db,
    false,
    artifactStore,
    false,
    false,
    ["https://ppoi-agg.horsewithsixlegs.xyz"],
  );
}

// Mirrors lib/railgun/wallet.ts
async function generate(mnemonic) {
  const ENC = randomBytes(32).toString("hex");
  const info = await createRailgunWallet(ENC, mnemonic, undefined);
  const zkAddress = getRailgunAddress(info.id);
  const viewingPrivateKeyBytes = getRailgunWalletPrivateViewingKey(info.id);
  unloadWalletByID(info.id);
  return {
    zkAddress,
    viewingPrivateKeyHex: Buffer.from(viewingPrivateKeyBytes).toString("hex"),
  };
}

// Mirrors lib/railgun/prepare.ts (the cryptographic core, sans DB)
const SHIELD_FN_FRAGMENT =
  "function shield(((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] _shieldRequests) payable";
const shieldIface = new Interface([SHIELD_FN_FRAGMENT]);

async function buildShieldCalldata({ zkAddress, signatureHex, grossUnits, usdcAddress }) {
  const sigBytes = getBytes(signatureHex);
  if (sigBytes.length !== 65) throw new Error("expected 65-byte signature");
  const shieldPrivateKey = keccak256(sigBytes);
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(zkAddress);
  const random = `0x${Buffer.from(randomBytes(16)).toString("hex")}`;
  const note = new ShieldNoteERC20(masterPublicKey, random, grossUnits, usdcAddress);
  const shieldRequest = await note.serialize(
    ByteUtils.hexToBytes(shieldPrivateKey),
    viewingPublicKey,
  );
  const data = shieldIface.encodeFunctionData("shield", [
    [
      {
        preimage: {
          npk: shieldRequest.preimage.npk,
          token: {
            tokenType: shieldRequest.preimage.token.tokenType,
            tokenAddress: shieldRequest.preimage.token.tokenAddress,
            tokenSubID: shieldRequest.preimage.token.tokenSubID,
          },
          value: shieldRequest.preimage.value,
        },
        ciphertext: {
          encryptedBundle: shieldRequest.ciphertext.encryptedBundle,
          shieldKey: shieldRequest.ciphertext.shieldKey,
        },
      },
    ],
  ]);
  return { data, random, shieldRequest, masterPublicKey };
}

// Mirrors the npk-match step from lib/railgun/verify.ts
function checkNpkMatch({ commitments, masterPublicKey, random }) {
  const expectedNpk = ShieldNote.getNotePublicKey(masterPublicKey, random.replace(/^0x/, ""));
  for (const c of commitments) {
    if (BigInt(c.npk) === expectedNpk) return { matched: true, value: BigInt(c.value), token: c.token.tokenAddress.toLowerCase() };
  }
  return { matched: false };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const results = [];
function pass(name, detail = "") { results.push({ name, status: "PASS", detail }); console.log(`✓ ${name}`, detail ? `— ${detail}` : ""); }
function fail(name, err) { results.push({ name, status: "FAIL", err: String(err) }); console.log(`✗ ${name} — ${err}`); }

console.log("Starting engine…");
const t0 = Date.now();
await startEngine();
console.log(`engine ready in ${Date.now() - t0}ms\n`);

// Test 1 — wallet generation
let wallet;
try {
  const mnemonic = Mnemonic.fromEntropy(ethersRandomBytes(16)).phrase;
  wallet = await generate(mnemonic);
  if (!wallet.zkAddress.startsWith("0zk1q")) throw new Error(`bad address prefix: ${wallet.zkAddress}`);
  if (wallet.zkAddress.length < 100 || wallet.zkAddress.length > 130) throw new Error(`bad address length: ${wallet.zkAddress.length}`);
  if (wallet.viewingPrivateKeyHex.length !== 64) throw new Error(`viewing key not 32 bytes: ${wallet.viewingPrivateKeyHex.length} hex chars`);
  if (mnemonic.split(" ").length !== 12) throw new Error("not 12 words");
  wallet.mnemonic = mnemonic;
  pass("Test 1: wallet generation", `${wallet.zkAddress.slice(0,14)}…${wallet.zkAddress.slice(-6)}`);
} catch (e) { fail("Test 1: wallet generation", e); }

// Test 2 — determinism: same mnemonic must produce same address
try {
  const a = await generate(wallet.mnemonic);
  const b = await generate(wallet.mnemonic);
  if (a.zkAddress !== b.zkAddress) throw new Error(`addresses differ: ${a.zkAddress} vs ${b.zkAddress}`);
  if (a.zkAddress !== wallet.zkAddress) throw new Error(`re-derive differs from original`);
  if (a.viewingPrivateKeyHex !== b.viewingPrivateKeyHex) throw new Error(`viewing keys differ`);
  if (a.viewingPrivateKeyHex !== wallet.viewingPrivateKeyHex) throw new Error(`re-derive viewing key differs from original`);
  pass("Test 2: determinism", "same mnemonic → same address + viewing key, 3 trials");
} catch (e) { fail("Test 2: determinism", e); }

// Test 3 — address round-trip
try {
  const decoded = RailgunEngine.decodeAddress(wallet.zkAddress);
  if (typeof decoded.masterPublicKey !== "bigint") throw new Error("masterPublicKey not bigint");
  if (!(decoded.viewingPublicKey instanceof Uint8Array)) throw new Error("viewingPublicKey not Uint8Array");
  if (decoded.viewingPublicKey.length !== 32) throw new Error(`viewing pubkey not 32 bytes: ${decoded.viewingPublicKey.length}`);
  const reEncoded = RailgunEngine.encodeAddress({
    masterPublicKey: decoded.masterPublicKey,
    viewingPublicKey: decoded.viewingPublicKey,
  });
  if (reEncoded !== wallet.zkAddress) throw new Error(`re-encoded differs:\n  orig: ${wallet.zkAddress}\n  re:   ${reEncoded}`);
  pass("Test 3: address round-trip", "decode → re-encode → byte-equal");
} catch (e) { fail("Test 3: address round-trip", e); }

// Test 4 — Shield calldata build
let shield;
try {
  // Generate a fresh EOA to act as the payer; sign the canonical message.
  const payer = Wallet.createRandom();
  const sig = await payer.signMessage("RAILGUN_SHIELD");
  shield = await buildShieldCalldata({
    zkAddress: wallet.zkAddress,
    signatureHex: sig,
    grossUnits: 1_000_000n, // 1 USDC
    usdcAddress: SEPOLIA_USDC,
  });
  if (!shield.data.startsWith("0x")) throw new Error("not hex");
  // Decode our own calldata back, confirm npk is set
  const decoded = shieldIface.decodeFunctionData("shield", shield.data);
  const reqs = decoded[0];
  if (reqs.length !== 1) throw new Error(`expected 1 shield request, got ${reqs.length}`);
  const npk = BigInt(reqs[0][0][0]); // _shieldRequests[0].preimage.npk
  if (npk === 0n) throw new Error("npk is zero");
  shield.expectedNpk = npk;
  pass("Test 4: Shield calldata build", `npk=${npk.toString().slice(0,12)}…, ${shield.data.length} bytes calldata`);
} catch (e) { fail("Test 4: Shield calldata build", e); }

// Test 5 — verifier recognises matching commitment, rejects tampered ones
try {
  // Build a synthetic Shield event matching our calldata's commitment
  const commitments = [
    {
      npk: shield.expectedNpk.toString(),
      token: { tokenAddress: SEPOLIA_USDC },
      value: "1000000",
    },
  ];
  const ok = checkNpkMatch({ commitments, masterPublicKey: shield.masterPublicKey, random: shield.random });
  if (!ok.matched) throw new Error("verifier did not match its own commitment");
  if (ok.value !== 1_000_000n) throw new Error(`value mismatch: ${ok.value}`);
  if (ok.token !== SEPOLIA_USDC.toLowerCase()) throw new Error(`token mismatch: ${ok.token}`);

  // Tampered: wrong npk → must not match
  const tampered = [{ npk: (shield.expectedNpk + 1n).toString(), token: { tokenAddress: SEPOLIA_USDC }, value: "1000000" }];
  const bad = checkNpkMatch({ commitments: tampered, masterPublicKey: shield.masterPublicKey, random: shield.random });
  if (bad.matched) throw new Error("verifier matched a tampered commitment — false positive");

  // Tampered: wrong random → must not match (different random produces different npk)
  const wrongRandom = `0x${Buffer.from(randomBytes(16)).toString("hex")}`;
  const bad2 = checkNpkMatch({ commitments, masterPublicKey: shield.masterPublicKey, random: wrongRandom });
  if (bad2.matched) throw new Error("verifier matched with a different random — replay vulnerability");

  pass("Test 5: verifier matches prepared note", "true positive + 2 negatives (tampered npk, wrong random)");
} catch (e) { fail("Test 5: verifier matches prepared note", e); }

// ─── Report ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${passed} passed, ${failed} failed`);
if (wallet) {
  console.log("\nGenerated wallet (use this for the on-chain test):");
  console.log(`  zk address: ${wallet.zkAddress}`);
  console.log(`  mnemonic:   ${wallet.mnemonic}`);
}
process.exit(failed === 0 ? 0 : 1);
