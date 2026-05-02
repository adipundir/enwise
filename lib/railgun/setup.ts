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
import { activeRailgunNetwork, rpcUrlsFor } from "./config";

/**
 * RAILGUN engine — lazy singleton. Starts the engine once per Node process,
 * subsequent callers await the same promise. Tuned for "create wallet +
 * verify a tx hash" use cases: shield-only mode, no proving artifacts, no
 * filesystem persistence.
 *
 * Cold-start cost: ~1ms for engine init alone (no merkle scan, no provider
 * load). Wallet creation (createRailgunWallet) adds ~70ms. Network connect
 * via ensureNetworkLoaded is the only slow path and is opt-in.
 *
 * Designed to run cleanly on Vercel / read-only-FS environments: nothing
 * is mkdir'd, the ArtifactStore is in-memory (we never generate proofs
 * server-side, so it's never consulted in practice).
 */

let initPromise: Promise<void> | null = null;
const loadedNetworks = new Set<NetworkName>();

function buildArtifactStore(): ArtifactStore {
  // No-op store. We never generate Groth16 proofs server-side — wallet
  // creation doesn't need them, and verify reads on-chain Shield events
  // directly without any proof. So the read/write/exists handlers are
  // never actually invoked during normal operation.
  //
  // Crucially: no filesystem access. Vercel function bundles live under
  // a read-only /var/task; only /tmp is writable. Touching the FS at
  // engine init time would crash setup_private_payments. If we ever add
  // server-side proof generation (unshield/transfer), this store needs
  // a real backend (an in-memory Map cache + Vercel Blob fetcher would
  // work; see RAILGUN docs §Build a persistent store).
  return new ArtifactStore(
    async () => null, // get
    async () => {},   // store (no-op)
    async () => false, // exists
  );
}

export async function ensureEngineStarted(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // memdown: pure-JS in-memory backend. Avoids native compilation
    // headaches on Vercel serverless. Wallet records live here for ~70ms
    // during createRailgunWallet, then we unloadWalletByID and the slot
    // is freed.
    const db = new MemDOWN();
    const artifactStore = buildArtifactStore();
    // POI (Proof Of Innocence) is required for Arbitrum. Default test
    // aggregator works for now; for production we'd self-host or pin a
    // paid node URL via RAILGUN_POI_NODE_URL env.
    const poiNodeUrl =
      process.env.RAILGUN_POI_NODE_URL ?? "https://ppoi-agg.horsewithsixlegs.xyz";
    await startRailgunEngine(
      "enwise",
      db,
      false, // shouldDebug
      artifactStore,
      false, // useNativeArtifacts (false for nodejs)
      false, // skipMerkletreeScans — SDK refuses to create a wallet with
             // this true ("Cannot load wallet: skipMerkletreeScans set to
             // true"), so we leave it false. With memdown the cost is
             // moot since the in-memory tree is discarded on unloadWalletByID.
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

  const urls = rpcUrlsForNetwork(network);
  // Probe the primary URL before loadProvider; engine throws cryptic errors
  // if the URL is unreachable. If primary is down we still proceed —
  // loadProvider will route to the secondary on actual calls.
  try {
    const probe = new JsonRpcProvider(urls[0]);
    await probe.getBlockNumber();
  } catch {
    // Probe failure is informational only; the FallbackProvider has the
    // public URL as a backup. Don't refuse to start the engine here.
  }

  // FallbackProvider requires total weight >= 2 (quorum invariant). With a
  // single URL, weight=2 satisfies it. With primary + fallback, two
  // providers at weight 1 each total 2 and route by priority (1 = preferred).
  const providers =
    urls.length === 1
      ? [{ provider: urls[0]!, priority: 1, weight: 2 }]
      : urls.map((url, i) => ({ provider: url, priority: i + 1, weight: 1 }));

  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId: cfg.chain.id,
    providers,
  };
  await loadProvider(fallbackConfig, network, 10_000);
  loadedNetworks.add(network);
}

function rpcUrlsForNetwork(network: NetworkName): string[] {
  // We support whatever RAILGUN_NETWORK env points at — mainnet by default,
  // Sepolia for testing. Other RAILGUN-supported chains (Polygon, Arbitrum,
  // BNB) are deliberately not wired up to keep anonymity-set + UX coherent.
  const cfg = activeRailgunNetwork();
  if (network !== cfg.network) {
    throw new Error(
      `Network ${network} is not the active RAILGUN network (${cfg.network}).`,
    );
  }
  return rpcUrlsFor(cfg);
}

export const PRIMARY_NETWORK: NetworkName = activeRailgunNetwork().network;
