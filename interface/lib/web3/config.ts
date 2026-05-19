import { createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";
import { resolveChain, transportFor } from "./chain";

export {
  DEFAULT_CHAIN_ID,
  SUPPORTED_CHAIN_IDS,
  chainLabel,
  isSupportedChainId,
  resolveChain,
} from "./chain";
export type { SupportedChainId, ResolvedChain } from "./chain";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

// Register every chain we might transact on. The literal tuple is required
// so wagmi's `Register` type knows the full set; per-tx chain is picked at
// writeContract time via the `chainId` arg.
const chains = [base, baseSepolia] as const;

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    walletConnect({
      projectId,
      metadata: {
        name: "enwise",
        description: "Pay invoice",
        url:
          process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ??
          process.env.PUBLIC_BASE_URL ??
          "https://enwise.app",
        icons: [
          (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ??
            process.env.PUBLIC_BASE_URL ??
            "https://enwise.app") + "/icon.svg",
        ],
      },
      showQrModal: true,
    }),
  ],
  transports: {
    [base.id]: transportFor(resolveChain(base.id)),
    [baseSepolia.id]: transportFor(resolveChain(baseSepolia.id)),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
