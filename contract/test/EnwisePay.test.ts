import { expect } from "chai";
import hre from "hardhat";
import { keccak256, toHex, getAddress, parseUnits, type Address } from "viem";

const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Unit tests that don't require the Inco Docker node.
 * Full shield → attestation → unShield happy paths run against the local
 * Inco node (`make node`) in `EnwisePay.integration.test.ts`.
 */
describe("EnwisePay — unit", function () {
  async function deployFixture() {
    const [relayer, alice] = await hre.viem.getWalletClients();
    const enwisePay = await hre.viem.deployContract("EnwisePay", [PERMIT2, relayer.account.address]);
    const usdc = await hre.viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    return { enwisePay, usdc, relayer, alice };
  }

  it("constructor stores Permit2 + relayer", async function () {
    const { enwisePay, relayer } = await deployFixture();
    expect(getAddress(await enwisePay.read.PERMIT2())).to.equal(PERMIT2);
    expect(getAddress(await enwisePay.read.relayer())).to.equal(getAddress(relayer.account.address));
  });

  it("nextNoteId starts at 0", async function () {
    const { enwisePay } = await deployFixture();
    expect(await enwisePay.read.nextNoteId()).to.equal(0n);
  });

  it("INVOICE_TYPEHASH matches the spec string", async function () {
    const { enwisePay } = await deployFixture();
    const expected = keccak256(toHex("InvoicePayment(bytes32 slug,bytes32 ctCommit,address settlement,uint256 expiry)"));
    expect(await enwisePay.read.INVOICE_TYPEHASH()).to.equal(expected);
  });

  it("INVOICE_WITNESS_STRING contains TokenPermissions per Permit2 spec", async function () {
    const { enwisePay } = await deployFixture();
    const s = await enwisePay.read.INVOICE_WITNESS_STRING();
    expect(s).to.include("InvoicePayment witness)");
    expect(s).to.include("TokenPermissions(address token,uint256 amount)");
  });

  it("payInvoice reverts NotRelayer when caller is not the relayer", async function () {
    const { enwisePay, usdc, alice } = await deployFixture();
    const slug = keccak256(toHex("invoice-1"));
    const fakeCt = "0x" + "ab".repeat(96) as `0x${string}`;
    const permit = {
      permitted: { token: usdc.address, amount: parseUnits("100", 6) },
      nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };

    await expect(
      enwisePay.write.payInvoice(
        [slug, fakeCt, alice.account.address, permit, "0x" as `0x${string}`],
        { account: alice.account, value: 1n },
      ),
    ).to.be.rejectedWith(/NotRelayer|reverted/i);
  });

  it("slugToNoteId returns 0 for unknown slug (unpaid sentinel)", async function () {
    const { enwisePay } = await deployFixture();
    const slug = keccak256(toHex("never-paid"));
    expect(await enwisePay.read.slugToNoteId([slug])).to.equal(0n);
  });
});
