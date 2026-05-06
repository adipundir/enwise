import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Permit2 canonical CREATE2 deployment — same address on every EVM chain.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export default buildModule("EnwisePay", (m) => {
  const relayer = m.getParameter<`0x${string}`>("relayer");
  const permit2 = m.getParameter<`0x${string}`>("permit2", PERMIT2);

  const enwisePay = m.contract("EnwisePay", [permit2, relayer]);

  return { enwisePay };
});
