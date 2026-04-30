import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { JsonRpcProvider } from "ethers";
import {
  ArtifactStore,
  startRailgunEngine,
  loadProvider,
} from "@railgun-community/wallet";
import {
  NetworkName,
  NETWORK_CONFIG,
  type FallbackProviderJsonConfig,
} from "@railgun-community/shared-models";
import MemDOWN from "memdown";

/**
 * RAILGUN engine — lazy singleton. Starts the engine once per Node process,
 * subsequent callers await the same promise. Tuned for "verify a tx hash"
 * use cases: shield-only mode, no merkletree scanning, no proving artifacts.
 *
 * If the deployment context is serverless (Vercel), each cold function pays
 * the init cost (~3-5s); warm reuses are free. Long-running workers init once.
 */

const ENGINE_DATA_DIR = path.resolve(
  process.env.RAILGUN_DATA_DIR ?? ".railgun-data",
);
const ARTIFACTS_DIR = path.join(ENGINE_DATA_DIR, "artifacts");
const LEVELDB_DIR = path.join(ENGINE_DATA_DIR, "leveldb");

let initPromise: Promise<void> | null = null;
const loadedNetworks = new Set<NetworkName>();

async function ensureDirs() {
  if (!existsSync(ENGINE_DATA_DIR)) await fs.mkdir(ENGINE_DATA_DIR, { recursive: true });
  if (!existsSync(ARTIFACTS_DIR)) await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  if (!existsSync(LEVELDB_DIR)) await fs.mkdir(LEVELDB_DIR, { recursive: true });
}

function buildArtifactStore(): ArtifactStore {
  // Filesystem-backed; sufficient for verify-only flows (proofs not generated
  // here). If we later add unshield/withdraw on the server, the store needs
  // to be writable to download Groth16 artifacts on first proof attempt.
  return new ArtifactStore(
    async (key) => {
      const file = path.join(ARTIFACTS_DIR, key);
      try {
        return await fs.readFile(file);
      } catch {
        return null;
      }
    },
    async (dir, key, value) => {
      const target = path.join(ARTIFACTS_DIR, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        typeof value === "string" ? value : Buffer.from(value),
      );
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
}

export async function ensureEngineStarted(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await ensureDirs();
    // memdown: pure-JS in-memory backend. Ephemeral (lost on process restart),
    // which is fine because we run with skipMerkletreeScans=true — there's no
    // long-lived state to preserve. Avoids native compilation headaches on
    // Vercel serverless.
    const db = new MemDOWN();
    const artifactStore = buildArtifactStore();
    // POI (Proof Of Innocence) is required for Arbitrum. Default test
    // aggregator works for now; for production we'd self-host or pin a paid
    // node URL via RAILGUN_POI_NODE_URL env.
    const poiNodeUrl =
      process.env.RAILGUN_POI_NODE_URL ?? "https://ppoi-agg.horsewithsixlegs.xyz";
    await startRailgunEngine(
      "enwise",
      db,
      false, // shouldDebug
      artifactStore,
      false, // useNativeArtifacts (false for nodejs)
      false, // skipMerkletreeScans — we'd love to skip this for verify-only
             // flows, but the SDK refuses to load any wallet (even view-only)
             // when this is true. We accept the merkletree-scan cost and run
             // the engine in a long-lived worker process for the scanner.
      [poiNodeUrl],
    );
  })();
  return initPromise;
}

/**
 * Connect engine to a chain's RPC. Idempotent — won't re-load if already
 * connected. Required before fetching tx receipts via the engine, though
 * for our verify path we mostly use viem directly (which is lighter).
 */
export async function ensureNetworkLoaded(
  network: NetworkName,
): Promise<void> {
  await ensureEngineStarted();
  if (loadedNetworks.has(network)) return;

  const cfg = NETWORK_CONFIG[network];
  if (!cfg) throw new Error(`Unknown RAILGUN network: ${network}`);

  const rpcUrl = rpcUrlForNetwork(network);
  // Probe RPC availability before loadProvider; engine throws cryptic errors
  // if the URL is unreachable.
  const probe = new JsonRpcProvider(rpcUrl);
  await probe.getBlockNumber();

  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId: cfg.chain.id,
    // FallbackProvider requires total weight >= 2 (quorum invariant). With a
    // single RPC URL, weight=2 satisfies it. To add redundancy later, list
    // multiple providers each with weight 1.
    providers: [{ provider: rpcUrl, priority: 1, weight: 2 }],
  };
  await loadProvider(fallbackConfig, network, 10_000);
  loadedNetworks.add(network);
}

function rpcUrlForNetwork(network: NetworkName): string {
  // Single chain for now: Ethereum mainnet. RAILGUN doesn't support Base, and
  // we deliberately don't fan out to Arbitrum/Polygon/BSC even though RAILGUN
  // does — sticking with one chain keeps anonymity-set + UX coherent.
  switch (network) {
    case NetworkName.Ethereum:
      // publicnode.com is the most reliable free public RPC at the moment;
      // cloudflare-eth.com and llamarpc both rate-limit aggressively. For
      // production, set ETH_RPC_URL to a paid endpoint (Alchemy, dRPC, etc.).
      return process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
    default:
      throw new Error(
        `Network ${network} is not supported. enwise only ships Ethereum mainnet RAILGUN integration.`,
      );
  }
}

export const PRIMARY_NETWORK: NetworkName = NetworkName.Ethereum;
