import { ArtifactStore, startRailgunEngine } from "@railgun-community/wallet";
import MemDOWN from "memdown";

/**
 * RAILGUN engine — lazy singleton. Starts the engine once per Node process,
 * subsequent callers await the same promise. Tuned exactly for our two
 * operations:
 *
 * 1. createRailgunWallet at onboarding time (lib/railgun/wallet.ts).
 * 2. RailgunEngine.decodeAddress + ShieldNote.getNotePublicKey at verify
 *    time — these are static helpers re-exported by the engine package and
 *    don't need the engine running, but importing them pulls the engine
 *    code in, so we initialise once anyway.
 *
 * What we deliberately don't do:
 * - No filesystem persistence (memdown). Vercel function bundles live under
 *   read-only /var/task; only /tmp is writable. Touching the FS at engine
 *   init crashes setup_private_payments. memdown also makes wallet creation
 *   ephemeral, which is exactly what we want — the SDK's encrypted wallet
 *   record is destroyed on unloadWalletByID.
 * - No Groth16 prover, no artifact store backend. Per RAILGUN docs §6 of
 *   Getting Started: "A Prover is only necessary for applications that
 *   intend to generate proofs ... Shield-only applications can safely skip
 *   this step." We are exactly that — wallet creation is pure key
 *   derivation, verify reads on-chain Shield events directly.
 * - No loadProvider call. The engine's chain provider machinery is for
 *   balance scanning + spending. Verify uses viem directly. Wallet
 *   creation needs nothing on-chain.
 *
 * Cold-start cost: ~1ms for the engine init alone, ~70ms for the
 * subsequent createRailgunWallet call. Smoke-confirmed.
 */

let initPromise: Promise<void> | null = null;

function buildArtifactStore(): ArtifactStore {
  // No-op store. We never generate proofs server-side, so the
  // read/write/exists handlers are never invoked during normal operation.
  // If we later add server-side proof generation, swap this for an
  // in-memory Map cache + Vercel Blob fetcher (per RAILGUN docs §4 of
  // Getting Started — "Build a persistent store for artifact downloads").
  // Local FS is not an option on Vercel.
  return new ArtifactStore(
    async () => null, // get
    async () => {}, // store (no-op)
    async () => false, // exists
  );
}

export async function ensureEngineStarted(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const t0 = Date.now();
    const db = new MemDOWN();
    const artifactStore = buildArtifactStore();
    const poiNodeUrl =
      process.env.RAILGUN_POI_NODE_URL ??
      "https://ppoi-agg.horsewithsixlegs.xyz";
    console.log(`[railgun] engine_start poi=${poiNodeUrl}`);
    try {
      await startRailgunEngine(
        "enwise",
        db,
        false, // shouldDebug
        artifactStore,
        false, // useNativeArtifacts (false for nodejs)
        false, // skipMerkletreeScans
        [poiNodeUrl],
      );
      console.log(`[railgun] engine_ready ms=${Date.now() - t0}`);
    } catch (err) {
      console.error(
        `[railgun] engine_init_failed ms=${Date.now() - t0} poi=${poiNodeUrl}`,
        err,
      );
      // Clear cached promise so next call retries instead of returning
      // the stuck rejection forever.
      initPromise = null;
      throw err;
    }
  })();
  return initPromise;
}
