# Private Payments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** private-payments-native private-payments flow on Base Sepolia. Each invoice gets a pre-encrypted recipient address committed on-chain. Customers pay via gasless EIP-712 (Permit2 + witness or USDC EIP-3009). Enwise relayer submits, then sweeps to merchant.

**Architecture:**
1. **Contract** (`EnwisePay.sol`) holds USDC and a per-note encrypted recipient handle (`eaddress`). Permit2 with witness binds A's signature to the specific invoice.
2. **Backend** pre-encrypts B's address at invoice creation (no wallet needed for `zap.encrypt`), persists ct against the invoice slug, relays the on-chain shield + sweep using a KMS-backed relayer EOA.
3. **Frontend** at `/i/[slug]` lets payer connect wallet, sign Permit2 PermitWitnessTransferFrom (or USDC EIP-3009 fast path), POST sig to backend.

**Tech Stack:**
- Solidity 0.8.30 + `@inco/lightning` 0.7.10 + OpenZeppelin 5.4 + Permit2 (`permit2/src`)
- Hardhat + Ignition + viem (in `contract/`)
- Next.js 16 + viem + wagmi + RainbowKit (in `interface/`)
- `@inco/js` 0.7.10 (server-side encrypt + attestedCompute)
- Drizzle ORM + Neon Postgres (existing)
- Resend (existing) + Vercel Cron (new — sweep worker)

**Shortcuts:** the root [`Makefile`](../../Makefile) wraps every common command (`make compile`, `make test-contract`, `make deploy-testnet`, `make node`, `make db-push`, `make e2e`, `make sweep`, etc.). Each task below shows the raw command for clarity and reproducibility — substitute the Make target if you prefer (`make help` for the full list).

**Verified addresses (Base Sepolia, chainId 84532):**
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle docs)
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical CREATE2 deployment, audited by ABDK + Trail of Bits)
- Inco executor address: fetched from `Lightning.latest("testnet", 84532)` at runtime

---

## Pre-flight checklist (before Task 1)

- [ ] `make install` to populate both workspaces' `node_modules`.
- [ ] Confirm Base Sepolia ETH funded for `RELAYER_EOA` (~0.5 ETH for testing, gas + private payments fees).
- [ ] Generate `RELAYER_EOA` private key. For dev: store in `interface/.env` as `RELAYER_PRIVATE_KEY`. For prod: AWS KMS or Privy server wallets — flagged in Hosting Notes below.
- [ ] Verify private payments testnet covalidator + executor reachable: `make smoke-private` (after Task 10 lands the smoke script) — or run `await Lightning.latest("testnet", 84532)` manually.
- [ ] Cross-check `@inco/lightning` and `@inco/js` versions in `contract/package.json` and `interface/package.json` are aligned (both 0.7.10).

---

## Milestone 1 — Contract: EnwisePay.sol on Base Sepolia

### Task 1: Install Permit2 dependency in contract workspace

**Files:**
- Modify: `contract/package.json`

**Step 1: Add Permit2 dependency**

```bash
cd /Users/adityapundir/Documents/Code/envoice/contract
npm install --save permit2@github:Uniswap/permit2#main
```

**Step 2: Add remapping if needed**

Hardhat with `@nomicfoundation/hardhat-toolbox-viem` resolves `node_modules/` automatically. Verify `import` works:

```solidity
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
```

**Step 3: Commit**

```bash
git add contract/package.json contract/package-lock.json
git commit -m "deps(contract): add Permit2 from upstream Uniswap repo"
```

### Task 2: Delete unused scaffold contracts

**Files:**
- Delete: `contract/contracts/ConfidentialERC20.sol`
- Delete: `contract/contracts/ConfidentialLottery.sol`
- Delete: `contract/test/ConfidentialERC20.test.ts`
- Delete: `contract/test/ConfidentialLottery.test.ts`
- Delete: `contract/ignition/modules/ConfidentialERC20.ts`
- Delete: `contract/ignition/modules/ConfidentialLottery.ts`

**Step 1: Verify what exists**

```bash
ls contract/contracts/ contract/test/ contract/ignition/modules/
```

**Step 2: Delete scaffolds**

```bash
rm contract/contracts/ConfidentialERC20.sol contract/contracts/ConfidentialLottery.sol
rm contract/test/ConfidentialERC20.test.ts contract/test/ConfidentialLottery.test.ts
rm contract/ignition/modules/ConfidentialERC20.ts contract/ignition/modules/ConfidentialLottery.ts
```

**Step 3: Commit**

```bash
git add -A contract/
git commit -m "chore(contract): remove example scaffolds"
```

### Task 3: Write the failing EnwisePay test

**Files:**
- Create: `contract/test/EnwisePay.test.ts`

**Step 1: Write the test scaffolding**

```typescript
// contract/test/EnwisePay.test.ts
import { expect } from "chai";
import hre from "hardhat";
import { Lightning } from "@inco/js/lite";
import { handleTypes } from "@inco/js";
import { parseUnits, encodeAbiParameters, keccak256 } from "viem";

describe("EnwisePay", function () {
  it("shields a payment with pre-encrypted recipient", async function () {
    const [relayer, payer] = await hre.viem.getWalletClients();
    // ... will fail until contract exists
    expect(false).to.equal(true); // placeholder
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd contract && npx hardhat test
```

Expected: FAIL — placeholder assertion or missing contract.

**Step 3: Commit**

```bash
git add contract/test/EnwisePay.test.ts
git commit -m "test(contract): scaffold EnwisePay test"
```

### Task 4: Implement EnwisePay.sol

**Files:**
- Create: `contract/contracts/EnwisePay.sol`

**Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {euint256, ebool, eaddress, e, inco} from "@inco/lightning/src/Lib.sol";
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";
import {asBool} from "@inco/lightning/src/shared/TypeUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

/// @title EnwisePay — private shielded recipient + Permit2 witness invoicing
contract EnwisePay is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using e for *;

    struct Note {
        address asset;
        uint256 amount;
        eaddress recipient;
        bool spent;
    }

    ISignatureTransfer public immutable PERMIT2;
    address public immutable relayer;
    uint256 public nextNoteId;
    mapping(uint256 => Note) public notes;
    mapping(bytes32 => uint256) public slugToNoteId;

    bytes32 public constant INVOICE_TYPEHASH = keccak256(
        "InvoicePayment(bytes32 slug,bytes32 ctCommit,address settlement,uint256 expiry)"
    );
    string public constant INVOICE_WITNESS_STRING =
        "InvoicePayment witness)InvoicePayment(bytes32 slug,bytes32 ctCommit,address settlement,uint256 expiry)TokenPermissions(address token,uint256 amount)";

    event Shielded(uint256 indexed noteId, bytes32 indexed slug, address asset, uint256 amount);
    event HandleAccessGranted(uint256 indexed noteId, address indexed grantee);
    event Unshielded(uint256 indexed noteId, address indexed recipient);

    error NotRelayer();
    error InsufficientFee();
    error AlreadyPaid();
    error AlreadySpent();
    error InvalidAttestation();
    error HandleMismatch();
    error NotRecipient();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address _permit2, address _relayer) {
        PERMIT2 = ISignatureTransfer(_permit2);
        relayer = _relayer;
    }

    /// @notice Pulls A's tokens via Permit2 + witness, materializes encrypted recipient handle.
    function payInvoice(
        bytes32 slug,
        bytes calldata recipientCt,
        address payer,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external payable onlyRelayer nonReentrant returns (uint256 noteId) {
        if (msg.value < inco.getFee()) revert InsufficientFee();
        if (slugToNoteId[slug] != 0) revert AlreadyPaid();

        bytes32 witness = keccak256(abi.encode(
            INVOICE_TYPEHASH,
            slug,
            keccak256(recipientCt),
            address(this),
            permit.deadline
        ));

        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            payer,
            witness,
            INVOICE_WITNESS_STRING,
            signature
        );

        eaddress recipient = recipientCt.newEaddress(msg.sender);
        recipient.allowThis();

        noteId = ++nextNoteId;
        notes[noteId] = Note(permit.permitted.token, permit.permitted.amount, recipient, false);
        slugToNoteId[slug] = noteId;

        emit Shielded(noteId, slug, permit.permitted.token, permit.permitted.amount);
    }

    /// @notice Lazy access grant. eaddress brute force is infeasible (160-bit space).
    function requestHandleAccess(uint256 noteId) external {
        Note storage n = notes[noteId];
        if (n.spent) revert AlreadySpent();
        e.allow(n.recipient, msg.sender);
        emit HandleAccessGranted(noteId, msg.sender);
    }

    /// @notice Anyone may submit; funds go to `recipient` proven via attestation.
    function unShield(
        uint256 noteId,
        address recipient,
        DecryptionAttestation calldata att,
        bytes[] calldata sigs
    ) external nonReentrant {
        Note storage n = notes[noteId];
        if (n.spent) revert AlreadySpent();
        if (!inco.incoVerifier().isValidDecryptionAttestation(att, sigs)) revert InvalidAttestation();
        if (ebool.unwrap(e.eq(n.recipient, recipient)) != att.handle) revert HandleMismatch();
        if (!asBool(att.value)) revert NotRecipient();

        n.spent = true;
        IERC20(n.asset).safeTransfer(recipient, n.amount);
        emit Unshielded(noteId, recipient);
    }
}
```

**Step 2: Compile**

```bash
cd contract && npx hardhat compile
```

Expected: SUCCESS, contract size warning if any.

**Step 3: Commit**

```bash
git add contract/contracts/EnwisePay.sol
git commit -m "feat(contract): EnwisePay with Permit2 witness + Inco encrypted recipient"
```

### Task 5: Write IncoTest-based unit test for shield path

**Files:**
- Modify: `contract/test/EnwisePay.test.ts`

**Step 1: Write the shield path test using IncoTest cheatcodes**

This test mocks Permit2 with a stub and uses `IncoTest`'s `fakePrepareEuint256Ciphertext`-style helpers. Note: euint160 prep is a slight variant — check `@inco/lightning/src/test/IncoTest.sol` for the exact eaddress helper. Pattern:

```typescript
// Pseudocode — adapt actual IncoTest helper names from @inco/lightning source
import { expect } from "chai";
import hre from "hardhat";
import { parseUnits, keccak256, encodeAbiParameters, encodePacked } from "viem";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

describe("EnwisePay.payInvoice", function () {
  let enwisePay: any;
  let mockUsdc: any;
  let relayer: any;
  let alice: any;
  let bob: any;
  
  beforeEach(async function () {
    [relayer, alice, bob] = await hre.viem.getWalletClients();
    mockUsdc = await hre.viem.deployContract("MockERC20", ["USDC", "USDC", 6]);
    enwisePay = await hre.viem.deployContract("EnwisePay", [PERMIT2, relayer.account.address]);
  });

  it("reverts if non-relayer calls payInvoice", async function () {
    await expect(
      enwisePay.write.payInvoice([
        keccak256(encodePacked(["string"], ["slug"])),
        "0x",
        alice.account.address,
        { permitted: { token: mockUsdc.address, amount: 0n }, nonce: 0n, deadline: 0n },
        "0x"
      ], { account: alice.account })
    ).to.be.rejectedWith("NotRelayer");
  });

  // Add: shield + unshield happy paths once IncoTest mock helpers are wired in.
});
```

**Step 2: Run**

```bash
cd contract && npx hardhat test
```

Expected: NotRelayer test passes; full shield/unshield tests will be added once the local Inco Docker stack is running (Task 8).

**Step 3: Commit**

```bash
git add contract/test/EnwisePay.test.ts
git commit -m "test(contract): NotRelayer guard on payInvoice"
```

### Task 6: Add MockERC20 helper for tests

**Files:**
- Create: `contract/contracts/test/MockERC20.sol`

**Step 1: Write minimal mock**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private _customDecimals;
    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _customDecimals = dec_;
    }
    function decimals() public view override returns (uint8) { return _customDecimals; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
```

**Step 2: Compile**

```bash
cd contract && npx hardhat compile
```

**Step 3: Commit**

```bash
git add contract/contracts/test/MockERC20.sol
git commit -m "test(contract): MockERC20 helper for unit tests"
```

### Task 7: Ignition module to deploy EnwisePay

**Files:**
- Create: `contract/ignition/modules/EnwisePay.ts`

**Step 1: Write the deployment module**

```typescript
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export default buildModule("EnwisePay", (m) => {
  const relayer = m.getParameter("relayer");
  const enwisePay = m.contract("EnwisePay", [PERMIT2, relayer]);
  return { enwisePay };
});
```

**Step 2: Add deploy script to package.json**

In `contract/package.json` scripts:

```json
"deploy:enwisepay:testnet": "hardhat ignition deploy ignition/modules/EnwisePay.ts --network baseSepolia --parameters ignition/parameters.testnet.json"
```

**Step 3: Create parameters file**

`contract/ignition/parameters.testnet.json`:
```json
{
  "EnwisePay": {
    "relayer": "0xYOUR_RELAYER_EOA_ADDRESS"
  }
}
```

**Step 4: Deploy** (manual, after private payments testnet relayer is funded)

```bash
cd contract
export PRIVATE_KEY_BASE_SEPOLIA=0x...
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
npm run deploy:enwisepay:testnet
```

Capture the deployed address — it goes into `interface/.env` as `ENWISE_PAY_ADDRESS`.

**Step 5: Commit**

```bash
git add contract/ignition/modules/EnwisePay.ts contract/ignition/parameters.testnet.json contract/package.json
git commit -m "feat(contract): Ignition module for EnwisePay deployment"
```

### Task 8: Verify contract on Basescan (optional but recommended)

**Files:**
- Modify: `contract/hardhat.config.ts` — add etherscan config

**Step 1: Add etherscan API key block**

```typescript
etherscan: {
  apiKey: {
    baseSepolia: process.env.BASESCAN_API_KEY ?? "",
  },
  customChains: [{
    network: "baseSepolia",
    chainId: 84532,
    urls: {
      apiURL: "https://api-sepolia.basescan.org/api",
      browserURL: "https://sepolia.basescan.org",
    },
  }],
},
```

**Step 2: Verify**

```bash
cd contract
export BASESCAN_API_KEY=...
npx hardhat verify --network baseSepolia <DEPLOYED_ADDRESS> 0x000000000022D473030F116dDEE9F6B43aC78BA3 <RELAYER_EOA>
```

**Step 3: Commit**

```bash
git add contract/hardhat.config.ts
git commit -m "chore(contract): basescan verify config"
```

---

## Milestone 2 — Backend: private payments SDK + relayer + DB schema

### Task 9: Install private payments JS SDK in interface

**Files:**
- Modify: `interface/package.json`

**Step 1: Add deps**

```bash
cd /Users/adityapundir/Documents/Code/envoice/interface
npm install @inco/js@0.7.10 @inco/lightning@0.7.10
```

Note: `@inco/lightning` is a Solidity package; we install it for typechain types, but the runtime use is via `@inco/js`.

**Step 2: Commit**

```bash
git add interface/package.json interface/package-lock.json
git commit -m "deps(interface): add @inco/js for server-side encrypt + relayer"
```

### Task 10: private payments SDK singleton helper

**Files:**
- Create: `interface/lib/inco/client.ts`

**Step 1: Write the singleton**

```typescript
// interface/lib/inco/client.ts
import { Lightning } from "@inco/js/lite";

let _zap: Awaited<ReturnType<typeof Lightning.latest>> | null = null;

export async function getZap() {
  if (_zap) return _zap;
  const network = process.env.PRIVATE_PAYMENTS_NETWORK as "testnet" | "mainnet";
  const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID);
  if (!network || !chainId) {
    throw new Error("PRIVATE_PAYMENTS_NETWORK and PRIVATE_PAYMENTS_CHAIN_ID must be set");
  }
  _zap = await Lightning.latest(network, chainId);
  return _zap;
}

export const ENWISE_PAY_ADDRESS = process.env.ENWISE_PAY_ADDRESS as `0x${string}`;
export const RELAYER_EOA_ADDRESS = process.env.RELAYER_EOA_ADDRESS as `0x${string}`;
```

**Step 2: Add env to interface/.env (and .env.example):**

```
PRIVATE_PAYMENTS_NETWORK=testnet
PRIVATE_PAYMENTS_CHAIN_ID=84532
ENWISE_PAY_ADDRESS=0x...           # set after deploy
RELAYER_EOA_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...           # dev only — KMS in prod
```

**Step 3: Smoke test**

```typescript
// One-off scratch — interface/scripts/smoke-private.ts
import { getZap } from "@/lib/private/client";
(async () => {
  const zap = await getZap();
  console.log("executor:", zap.executorAddress);
})();
```

```bash
cd interface && npx tsx scripts/smoke-private.ts
```

Expected: prints executor address from private payments testnet.

**Step 4: Commit**

```bash
git add interface/lib/inco/client.ts interface/scripts/smoke-private.ts
git commit -m "feat(inco): zap SDK singleton + smoke script"
```

### Task 11: Encrypt-recipient helper

**Files:**
- Create: `interface/lib/inco/encrypt.ts`

**Step 1: Write the helper**

```typescript
// interface/lib/inco/encrypt.ts
import { handleTypes, type HexString } from "@inco/js";
import { getZap, ENWISE_PAY_ADDRESS, RELAYER_EOA_ADDRESS } from "./client";

export async function encryptRecipient(recipient: `0x${string}`): Promise<HexString> {
  const zap = await getZap();
  return zap.encrypt(BigInt(recipient), {
    accountAddress: RELAYER_EOA_ADDRESS,   // binds ct so only relayer can submit
    dappAddress: ENWISE_PAY_ADDRESS,
    handleType: handleTypes.euint160,
  });
}
```

**Step 2: Unit-test it** (just shape, since we can't decrypt):

```typescript
// interface/lib/inco/__tests__/encrypt.test.ts
import { encryptRecipient } from "../encrypt";
test("returns hex bytes", async () => {
  const ct = await encryptRecipient("0x1111111111111111111111111111111111111111");
  expect(ct).toMatch(/^0x[0-9a-f]+$/i);
  expect(ct.length).toBeGreaterThan(64);
});
```

**Step 3: Commit**

```bash
git add interface/lib/inco/encrypt.ts interface/lib/inco/__tests__/encrypt.test.ts
git commit -m "feat(inco): encryptRecipient helper bound to relayer EOA"
```

### Task 12: DB schema additions

**Files:**
- Modify: `interface/lib/db/schema.ts`

**Step 1: Add columns to invoices table**

Find the `invoices` table around line 330 and append (drizzle-orm syntax):

```typescript
// private payment fields
privateEnabled: boolean("private_enabled").notNull().default(false),
privateRecipientCt: text("private_recipient_ct"),       // pre-encrypted recipient eaddress (hex bytes)
privateNoteId: bigint("private_note_id", { mode: "number" }), // on-chain note id once shielded
privateChainId: integer("private_chain_id"),
```

**Step 2: Add columns to businesses table**:

```typescript
// Inco settlement
privateSettlementWallet: text("private_settlement_wallet"),    // where unshielded USDC lands
privateEnabledAt: timestamp("private_enabled_at", { withTimezone: true }),
```

**Step 3: Generate + apply migration**

```bash
cd interface
npm run db:generate
# Review generated SQL in lib/db/migrations/
npm run db:push   # applies to current DATABASE_URL
```

**Step 4: Commit**

```bash
git add interface/lib/db/schema.ts interface/lib/db/migrations/
git commit -m "feat(db): inco columns on invoices + businesses"
```

### Task 13: Hook encryptRecipient into create_invoice MCP tool

**Files:**
- Modify: `interface/lib/mcp/tools/invoices.ts:150-194` (`create_invoice`)
- Modify: `interface/lib/invoices.ts` (`createInvoice` function)

**Step 1: Update `createInvoice` to encrypt when business has Inco enabled**

```typescript
// in interface/lib/invoices.ts
import { encryptRecipient } from "@/lib/private/encrypt";

export async function createInvoice(input: CreateInvoiceInput) {
  // ... existing logic creates the invoice row ...
  
  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, businessId) });
  
  if (business?.privateSettlementWallet) {
    const ct = await encryptRecipient(business.privateSettlementWallet as `0x${string}`);
    await db.update(invoices)
      .set({
        privateEnabled: true,
        privateRecipientCt: ct,
        privateChainId: Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID),
      })
      .where(eq(invoices.id, invoice.id));
  }
  
  return invoice;
}
```

**Step 2: Add unit test**

```typescript
// interface/lib/__tests__/invoices.test.ts
test("createInvoice encrypts recipient when Inco enabled", async () => {
  // setup business with privateSettlementWallet set
  // call createInvoice
  // assert invoice row has privateRecipientCt set
});
```

**Step 3: Commit**

```bash
git add interface/lib/invoices.ts interface/lib/__tests__/invoices.test.ts
git commit -m "feat(mcp): encrypt recipient at create_invoice time"
```

### Task 14: Setup-Inco-payments MCP tool

**Files:**
- Create: `interface/lib/mcp/tools/private_payments.ts`
- Modify: `interface/lib/mcp/server.ts` to register it

**Step 1: Write the tool**

```typescript
// interface/lib/mcp/tools/private_payments.ts
import { z } from "zod";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { ScopedCtx } from "@/lib/mcp/auth";

export function registerPrivatePaymentTools(server: any, ctxFn: () => Promise<ScopedCtx>) {
  server.tool(
    "setup_private_payments",
    {
      settlement_wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    },
    async ({ settlement_wallet }: { settlement_wallet: string }) => {
      const ctx = await ctxFn();
      await db.update(businesses)
        .set({ privateSettlementWallet: settlement_wallet, privateEnabledAt: new Date() })
        .where(eq(businesses.id, ctx.businessId));
      return {
        content: [{ type: "text", text: `private payments enabled. Settlement wallet: ${settlement_wallet}` }],
      };
    }
  );
}
```

**Step 2: Wire into server.ts**

```typescript
// interface/lib/mcp/server.ts
import { registerPrivatePaymentTools } from "./tools/private_payments";
// ...
registerPrivatePaymentTools(server, ctxFn);
```

**Step 3: Commit**

```bash
git add interface/lib/mcp/tools/private_payments.ts interface/lib/mcp/server.ts
git commit -m "feat(mcp): setup_private_payments tool"
```

### Task 15: Relayer wallet helper (KMS-pluggable)

**Files:**
- Create: `interface/lib/inco/relayer.ts`

**Step 1: Write the relayer wallet factory**

```typescript
// interface/lib/inco/relayer.ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";

export function getRelayerWallet() {
  const chainId = Number(process.env.PRIVATE_PAYMENTS_CHAIN_ID);
  const chain = chainId === 84532 ? baseSepolia : base;
  const rpc = process.env.BASE_RPC_URL ?? chain.rpcUrls.default.http[0];

  // DEV: env var. PROD: swap for KMS / Privy server wallet.
  const pk = process.env.RELAYER_PRIVATE_KEY as `0x${string}`;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk);

  return createWalletClient({ account, chain, transport: http(rpc) });
}
```

**Step 2: Document KMS migration in code comments** — flag the `pk` block as the swap point.

**Step 3: Commit**

```bash
git add interface/lib/inco/relayer.ts
git commit -m "feat(inco): relayer wallet helper with KMS migration marker"
```

---

## Milestone 3 — Frontend: Permit2 + witness signing on /i/[slug]

### Task 16: Build Permit2 witness signing util

**Files:**
- Create: `interface/lib/inco/permit2.ts`

**Step 1: Write the EIP-712 sig builder**

```typescript
// interface/lib/inco/permit2.ts
import { type WalletClient, keccak256, toHex, encodePacked, encodeAbiParameters } from "viem";

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export type PermitTransferFromWithWitness = {
  permitted: { token: `0x${string}`; amount: bigint };
  spender: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  witness: { slug: `0x${string}`; ctCommit: `0x${string}`; settlement: `0x${string}`; expiry: bigint };
};

export async function signPermitWitness(
  walletClient: WalletClient,
  chainId: number,
  payer: `0x${string}`,
  args: PermitTransferFromWithWitness,
): Promise<`0x${string}`> {
  return walletClient.signTypedData({
    account: payer,
    domain: {
      name: "Permit2",
      chainId: BigInt(chainId),
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
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
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: args.permitted,
      spender: args.spender,
      nonce: args.nonce,
      deadline: args.deadline,
      witness: args.witness,
    },
  });
}

export function generateNonce(): bigint {
  // Bitmap nonce — random 256 bits is collision-free in practice.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""));
}
```

**Step 2: Commit**

```bash
git add interface/lib/inco/permit2.ts
git commit -m "feat(inco): Permit2 witness signing util"
```

### Task 17: API route — POST /api/invoices/:slug/pay

**Files:**
- Create: `interface/app/api/invoices/[slug]/pay/route.ts`

**Step 1: Write the route**

```typescript
// interface/app/api/invoices/[slug]/pay/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getRelayerWallet } from "@/lib/private/relayer";
import { getZap, ENWISE_PAY_ADDRESS } from "@/lib/private/client";
import { encodeFunctionData, keccak256, toHex } from "viem";
import enwisePayAbi from "@/lib/abi/EnwisePay.json";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const body = await req.json();
  const { payer, signature, permit } = body;

  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.shareSlug, slug) });
  if (!invoice || !invoice.privateRecipientCt) {
    return NextResponse.json({ error: "invoice not found or Inco not enabled" }, { status: 404 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "already paid" }, { status: 409 });
  }

  const slugBytes32 = keccak256(toHex(slug));
  const relayer = getRelayerWallet();
  const zap = await getZap();
  const fee = await zap.getFee?.() ?? 0n; // fallback if SDK helper differs

  const txHash = await relayer.writeContract({
    address: ENWISE_PAY_ADDRESS,
    abi: enwisePayAbi,
    functionName: "payInvoice",
    args: [
      slugBytes32,
      invoice.privateRecipientCt as `0x${string}`,
      payer,
      permit,
      signature,
    ],
    value: fee,
  });

  return NextResponse.json({ txHash });
}
```

**Step 2: Export ABI**

After deploying the contract, copy `contract/artifacts/contracts/EnwisePay.sol/EnwisePay.json` ABI portion into `interface/lib/abi/EnwisePay.json`.

**Step 3: Commit**

```bash
git add interface/app/api/invoices/\[slug\]/pay/route.ts interface/lib/abi/EnwisePay.json
git commit -m "feat(api): POST /api/invoices/:slug/pay relayer endpoint"
```

### Task 18: PrivatePayButton React component

**Files:**
- Create: `interface/app/i/[slug]/PrivatePayButton.tsx`

**Step 1: Write the client component**

```tsx
"use client";

import { useState } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import { keccak256, toHex, parseUnits } from "viem";
import { signPermitWitness, generateNonce, PERMIT2_ADDRESS } from "@/lib/private/permit2";

const PERMIT2_ABI = [{
  inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }],
  name: "allowance",
  outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
  stateMutability: "view",
  type: "function",
}] as const;

const ERC20_ABI = [{
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  name: "approve",
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
  type: "function",
}] as const;

export function PrivatePayButton({
  slug,
  asset,
  amount,
  ctCommit,
  enwisePayAddress,
  chainId,
}: {
  slug: string;
  asset: `0x${string}`;
  amount: string; // human "100" USDC
  ctCommit: `0x${string}`;
  enwisePayAddress: `0x${string}`;
  chainId: number;
}) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<string>("");

  const onPay = async () => {
    if (!walletClient || !address || !publicClient) return;
    setStatus("Checking Permit2 allowance...");

    const amountBig = parseUnits(amount, 6); // USDC = 6 dec

    // 1. Check Permit2 has allowance for USDC
    const allowance = await publicClient.readContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [address, asset, enwisePayAddress],
    });
    const currentAllowance = allowance[0];

    if (currentAllowance < amountBig) {
      setStatus("First-time approval — please confirm in wallet...");
      const approveHash = await walletClient.writeContract({
        address: asset,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, BigInt("0xffffffffffffffffffffffffffffffffffffffff")],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    setStatus("Sign payment authorization in wallet...");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const slugBytes32 = keccak256(toHex(slug));
    const nonce = generateNonce();

    const signature = await signPermitWitness(walletClient, chainId, address, {
      permitted: { token: asset, amount: amountBig },
      spender: enwisePayAddress,
      nonce,
      deadline,
      witness: {
        slug: slugBytes32,
        ctCommit,
        settlement: enwisePayAddress,
        expiry: deadline,
      },
    });

    setStatus("Submitting...");
    const res = await fetch(`/api/invoices/${slug}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payer: address,
        signature,
        permit: {
          permitted: { token: asset, amount: amountBig.toString() },
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    });
    const { txHash, error } = await res.json();
    if (error) { setStatus("Error: " + error); return; }
    setStatus("Submitted! Tx: " + txHash);
  };

  return (
    <div>
      <button onClick={onPay} className="rounded bg-black text-white px-4 py-2">
        Pay {amount} USDC privately
      </button>
      {status && <p className="text-sm mt-2">{status}</p>}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add interface/app/i/\[slug\]/PrivatePayButton.tsx
git commit -m "feat(ui): PrivatePayButton with Permit2 first-time + witness signing"
```

### Task 19: Wire PrivatePayButton into invoice page

**Files:**
- Modify: `interface/app/i/[slug]/page.tsx` around line 62-75 (where existing PayButton lives)

**Step 1: Mount the PrivatePayButton on the share page**

```tsx
import { PrivatePayButton } from "./PrivatePayButton";
// ... existing imports

// Inside the share page header, alongside the Download PDF button:
{invoice.privateEnabled && invoice.privateRecipientCt && (
  <PrivatePayButton
    slug={invoice.shareSlug}
    asset={USDC_BASE_SEPOLIA}
    amount={invoice.total}
    ctCommit={keccak256(invoice.privateRecipientCt as `0x${string}`)}
    enwisePayAddress={ENWISE_PAY_ADDRESS}
    chainId={84532}
  />
)}
```

**Step 2: Commit**

```bash
git add interface/app/i/\[slug\]/page.tsx
git commit -m "feat(ui): mount PrivatePayButton on share page when invoice has Inco enabled"
```

---

## Milestone 4 — Sweep worker

### Task 20: Indexer + sweep core logic

**Files:**
- Create: `interface/lib/inco/sweep.ts`

**Step 1: Write the sweep function**

```typescript
// interface/lib/inco/sweep.ts
import { db } from "@/lib/db";
import { invoices, businesses } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { AttestedComputeSupportedOps } from "@inco/js/lite";
import { bytesToHex, pad, toHex } from "viem";
import { getRelayerWallet } from "./relayer";
import { getZap, ENWISE_PAY_ADDRESS } from "./client";
import enwisePayAbi from "@/lib/abi/EnwisePay.json";

export async function sweepReadyNotes() {
  // Find all shielded-but-not-paid invoices
  const ready = await db.query.invoices.findMany({
    where: and(
      eq(invoices.status, "sent"),
      isNotNull(invoices.privateNoteId),
    ),
  });

  for (const inv of ready) {
    if (!inv.privateNoteId) continue;
    const business = await db.query.businesses.findFirst({ where: eq(businesses.id, inv.businessId) });
    if (!business?.privateSettlementWallet) continue;

    try {
      await sweepOne(BigInt(inv.privateNoteId), business.privateSettlementWallet as `0x${string}`, inv.id);
    } catch (e) {
      console.error("sweep failed for invoice", inv.id, e);
    }
  }
}

async function sweepOne(noteId: bigint, recipient: `0x${string}`, invoiceId: string) {
  const relayer = getRelayerWallet();
  const zap = await getZap();

  // 1. Grant relayer handle access
  await relayer.writeContract({
    address: ENWISE_PAY_ADDRESS,
    abi: enwisePayAbi,
    functionName: "requestHandleAccess",
    args: [noteId],
  });

  // 2. Read note to get the eaddress handle
  // (fetch via publicClient.readContract on `notes(noteId)`)

  // 3. attestedCompute(handle, Eq, recipient)
  const handle = "0x..."; // from step 2
  const result = await zap.attestedCompute(
    relayer,
    handle,
    AttestedComputeSupportedOps.Eq,
    BigInt(recipient),
  );

  // 4. Build attestation params
  const attestation = {
    handle: result.handle,
    value: pad(toHex(result.plaintext.value ? 1 : 0), { size: 32 }),
  };
  const sigs = result.covalidatorSignatures.map((s: Uint8Array) => bytesToHex(s));

  // 5. Submit unShield
  const txHash = await relayer.writeContract({
    address: ENWISE_PAY_ADDRESS,
    abi: enwisePayAbi,
    functionName: "unShield",
    args: [noteId, recipient, attestation, sigs],
  });

  // 6. Mark invoice paid
  await db.update(invoices).set({ status: "paid", paidAt: new Date() }).where(eq(invoices.id, invoiceId));
  return txHash;
}
```

**Step 2: Commit**

```bash
git add interface/lib/inco/sweep.ts
git commit -m "feat(inco): sweep worker core logic"
```

### Task 21: Vercel cron route

**Files:**
- Create: `interface/app/api/cron/sweep-private/route.ts`
- Modify: `interface/vercel.json`

**Step 1: Write the cron handler**

```typescript
// interface/app/api/cron/sweep-private/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sweepReadyNotes } from "@/lib/private/sweep";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await sweepReadyNotes();
  return NextResponse.json({ ok: true });
}
```

**Step 2: Add to vercel.json**

```json
{
  "crons": [
    { "path": "/api/cron/sweep-private", "schedule": "*/5 * * * *" }
  ]
}
```

**Step 3: Commit**

```bash
git add interface/app/api/cron/sweep-private/route.ts interface/vercel.json
git commit -m "feat(cron): every-5-min sweep worker"
```

### Task 22: Indexer to set privateNoteId from Shielded events

**Files:**
- Create: `interface/app/api/cron/index-shielded/route.ts`

**Step 1: Write the indexer**

```typescript
// interface/app/api/cron/index-shielded/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem, keccak256, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ENWISE_PAY_ADDRESS } from "@/lib/private/client";

const SHIELDED = parseAbiItem("event Shielded(uint256 indexed noteId, bytes32 indexed slug, address asset, uint256 amount)");

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pc = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_RPC_URL) });
  const latest = await pc.getBlockNumber();
  const fromBlock = latest - 5000n; // last ~3 hours on Base

  const logs = await pc.getLogs({
    address: ENWISE_PAY_ADDRESS,
    event: SHIELDED,
    fromBlock,
    toBlock: latest,
  });

  for (const log of logs) {
    const slug = log.args.slug as `0x${string}`;
    const noteId = Number(log.args.noteId);
    // Match slug bytes32 → invoice.shareSlug via keccak256(toHex(shareSlug))
    const all = await db.query.invoices.findMany({ where: eq(invoices.privateEnabled, true) });
    const match = all.find(inv => keccak256(toHex(inv.shareSlug)) === slug);
    if (match && !match.privateNoteId) {
      await db.update(invoices).set({ privateNoteId: noteId }).where(eq(invoices.id, match.id));
    }
  }

  return NextResponse.json({ scanned: logs.length });
}
```

**Step 2: Add cron entry**

In `interface/vercel.json`, add:

```json
{ "path": "/api/cron/index-shielded", "schedule": "*/2 * * * *" }
```

**Step 3: Commit**

```bash
git add interface/app/api/cron/index-shielded/route.ts interface/vercel.json
git commit -m "feat(cron): Shielded event indexer wires noteId onto invoice rows"
```

---

## Milestone 5 — Cleanup

### Task 23: Update reset_private_payments to handle Inco

**Files:**
- Modify: `interface/lib/mcp/tools/private_payments.ts`

**Step 1: Confirm `reset_private_payments` is registered** alongside `setup_private_payments` (single-rail Inco design — no other tool needed).

**Step 2: Commit**

```bash
git add interface/lib/mcp/tools/private_payments.ts interface/lib/mcp/tools/private_payments.ts
git commit -m "feat(mcp): reset_private_payments tool"
```

### Task 24: E2E smoke test on Base Sepolia

**Files:**
- Create: `interface/scripts/e2e-private.ts`

**Step 1: Write the script**

A scripted run that:
1. Creates a test merchant business with `privateSettlementWallet`.
2. Creates a test invoice (encrypts ct).
3. Simulates A signing Permit2 (use a test EOA wallet).
4. POSTs to `/api/invoices/:slug/pay`.
5. Triggers the indexer + sweep crons manually.
6. Asserts USDC arrived at settlement wallet.

**Step 2: Run on Base Sepolia**

```bash
cd interface && npx tsx scripts/e2e-private.ts
```

**Step 3: Commit**

```bash
git add interface/scripts/e2e-private.ts
git commit -m "test(e2e): full shield → sweep flow on Base Sepolia"
```

---

## Milestone 6 — Optional: x402 endpoint (defer if running short)

### Task 25: Content-negotiate /i/[slug] for AI agents

**Files:**
- Modify: `interface/app/i/[slug]/page.tsx` to handle `Accept: application/x402+json`

**Step 1:** When the request `Accept` header includes `x402+json`, return a 402 Payment Required JSON body containing the Permit2 schema, ct, settlement contract, asset, amount, deadline. Spec: `https://www.x402.org`.

**Step 2: Commit**

```bash
git add interface/app/i/\[slug\]/page.tsx
git commit -m "feat(x402): AI-agent-payable invoice endpoint"
```

---

## Hosting & Configs (single page reference)

### What needs to be hosted

| Component | Where | Notes |
|---|---|---|
| Next.js app (UI + API + MCP) | **Vercel** (already) | Add cron config; ensure functions don't time out on relayed txs (default 60s is plenty) |
| Postgres | **Neon** (already) | Run migrations after schema change |
| Cron jobs (sweep + indexer) | **Vercel Cron** | Free tier supports 1-min granularity; we use 2-5 min |
| Email | **Resend** (already) | No change |
| Email transactional | **Resend** (already) | Notify B on Unshielded |
| private payments SDK runtime | In-app (Vercel Functions) | No separate infra. RPC calls only |
| Inco covalidator | **Inco hosted** (testnet/mainnet) | Liveness dependency; monitor uptime |
| Smart contract | **Base Sepolia** (later: Base mainnet when private payments mainnets) | One-time deploy via Ignition |
| Relayer EOA | **AWS KMS / Privy server wallets / Coinbase MPC** for prod; env var `RELAYER_PRIVATE_KEY` for dev | Funded with ~0.5 ETH on testnet, top up via monitoring |
| RPC | **Alchemy / QuickNode** for Base | Set `BASE_RPC_URL` env |
| Block explorer verify | **Basescan** | One-time, optional but recommended |

### Required env vars (additions to existing `.env`)

```bash
# Inco
PRIVATE_PAYMENTS_NETWORK=testnet              # or "mainnet" once private payments supports it
PRIVATE_PAYMENTS_CHAIN_ID=84532

# Contract
ENWISE_PAY_ADDRESS=0x...          # from Ignition deploy

# Relayer
RELAYER_EOA_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...         # DEV ONLY — replace with KMS in prod

# RPC (server-only, no NEXT_PUBLIC_)
BASE_RPC_URL=https://...

# Already exists, used by new cron routes
CRON_SECRET=...

# Optional
BASESCAN_API_KEY=...
```

### Production hardening checklist (post-MVP)

- [ ] Move `RELAYER_PRIVATE_KEY` from env → KMS-backed signing (Privy or AWS KMS + viem custom signer).
- [ ] Add monitoring on relayer ETH balance (alerts when < 0.1 ETH).
- [ ] Add monitoring on contract balance vs sum of unspent notes (sanity check).
- [ ] Add Sentry / observability on the sweep worker; failed sweeps must surface.
- [ ] Rate-limit `POST /api/invoices/:slug/pay` (5 req/min/IP) to prevent relayer fee griefing.
- [ ] Add Inco covalidator liveness monitor; if down, surface "private payments temporarily unavailable" on UI.
- [ ] Consider Permit2 nonce reuse window — we use random 256-bit so collision probability is negligible, but log + alert if a nonce ever rejects.
- [ ] When Inco ships mainnet: set `PRIVATE_PAYMENTS_NETWORK=mainnet`, `PRIVATE_PAYMENTS_CHAIN_ID=8453`, redeploy `EnwisePay`, swap USDC address to `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

### Open decisions to make before / during implementation

1. **Relayer custody model.** AWS KMS (most generic, requires viem custom signer wrapper) vs Privy server wallets (managed, easy) vs Coinbase MPC. Pick before Task 15 hardens.
2. **Sweep cadence.** 5 min (current plan) vs end-of-day batched (better amount privacy). Start with 5 min, switch to batched if amount-correlation analysis becomes a concern.
3. **First-time payer Permit2 approval UX.** Some payers won't have Permit2 approval. Decide whether to show explanation modal or fall back to USDC EIP-3009 for the first payment. EIP-3009 fast path = small extra contract function `payInvoiceWith3009` (deferred to v1.1).
4. **Mainnet timing.** private payments mainnet is not yet available (testnet only as of May 2026). Plan v1 ship on Base Sepolia. Mainnet deploy requires private payments mainnet support OR rolling out option E (deterministic stealth EOAs) as the production fallback.

### Out of scope for v1

- Confidential ERC-20 (encrypted amounts) — defer to v2.
- ZK proof of merchant identity in payment link — defer.
- Multi-currency settlement at sweep time — defer.
- Programmable disputes / escrow window — defer.
- ERC-8004 merchant identity registration — defer.
