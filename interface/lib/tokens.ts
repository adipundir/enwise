import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateBody = customAlphabet(BASE62, 32);
const TOKEN_PREFIX = "env_live_";

export function generateRawToken(): string {
  return `${TOKEN_PREFIX}${generateBody()}`;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function tokenPrefix(raw: string): string {
  // First 12 chars of the raw token. stored for UI identification.
  return raw.slice(0, 12);
}

function isValidFormat(raw: string): boolean {
  if (!raw.startsWith(TOKEN_PREFIX)) return false;
  const body = raw.slice(TOKEN_PREFIX.length);
  return body.length === 32 && /^[0-9A-Za-z]+$/.test(body);
}

// ---------- Encrypt-at-rest helpers ----------
//
// We store BOTH a sha256 hash (indexed, used for fast lookup on every API
// request) AND an AES-256-GCM ciphertext of the raw token (used so the
// dashboard can show the user their key on revisit without forcing a rotate).
//
// Threat model:
//   - DB leak alone → attacker has nonce + ciphertext but not the key (which
//     lives in TOKEN_ENC_KEY env var, set on Vercel, never written to the DB).
//     They can't decrypt anything.
//   - Env var leak alone → attacker has the key but no ciphertext to decrypt.
//   - Both leak together → all tokens exposed. This is the inherent ceiling
//     of any encrypt-at-rest scheme; that's why the two stores are kept
//     deliberately independent.
//
// If TOKEN_ENC_KEY isn't configured (e.g., on a pre-rollout deployment), we
// silently skip encryption — the token still works because resolveBearer()
// only needs the hash. Dashboard will fall back to "rotate to view" for any
// row without ciphertext. Once the env var is added, new tokens get encrypted
// going forward.

const ENC_KEY_ALGO = "aes-256-gcm";
const ENC_NONCE_BYTES = 12; // 96-bit nonce, the standard for GCM
const ENC_TAG_BYTES = 16;

function readEncKey(): Buffer | null {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) return null;
  // Accept base64 (preferred). Reject anything that doesn't decode to 32 bytes.
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    console.warn("[tokens] TOKEN_ENC_KEY is set but not valid base64; ignoring.");
    return null;
  }
  if (key.length !== 32) {
    console.warn(
      `[tokens] TOKEN_ENC_KEY decoded to ${key.length} bytes; expected 32. ` +
        "Generate one with: openssl rand -base64 32",
    );
    return null;
  }
  return key;
}

/**
 * Encrypt the raw token for at-rest storage. Output is a single base64 blob
 * containing nonce(12) || ciphertext || authTag(16). Returns null if no
 * encryption key is configured — caller should treat the row as "no displayable
 * token" and rely on the hash for auth.
 */
export function encryptRawToken(raw: string): string | null {
  const key = readEncKey();
  if (!key) return null;
  const nonce = randomBytes(ENC_NONCE_BYTES);
  const cipher = createCipheriv(ENC_KEY_ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

/**
 * Decrypt a stored ciphertext blob produced by encryptRawToken. Returns null
 * if the env key is missing, the blob is malformed, or the auth tag doesn't
 * verify (which would indicate tampering or a key mismatch).
 */
export function decryptStoredToken(blobB64: string): string | null {
  const key = readEncKey();
  if (!key) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(blobB64, "base64");
  } catch {
    return null;
  }
  if (blob.length < ENC_NONCE_BYTES + ENC_TAG_BYTES) return null;
  const nonce = blob.subarray(0, ENC_NONCE_BYTES);
  const tag = blob.subarray(blob.length - ENC_TAG_BYTES);
  const ct = blob.subarray(ENC_NONCE_BYTES, blob.length - ENC_TAG_BYTES);
  try {
    const decipher = createDecipheriv(ENC_KEY_ALGO, key, nonce);
    decipher.setAuthTag(tag);
    return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * True when a valid TOKEN_ENC_KEY is configured on this server — i.e. newly
 * minted tokens will be encrypted-at-rest and therefore displayable on the
 * dashboard. Callers use this to avoid re-minting a token they still won't be
 * able to show (which would otherwise churn a fresh token on every page load).
 */
export function isEncryptionConfigured(): boolean {
  return readEncKey() !== null;
}

export async function createToken(params: {
  createdByUserId: string;
  name: string;
}) {
  const raw = generateRawToken();
  const [row] = await db
    .insert(apiTokens)
    .values({
      createdByUserId: params.createdByUserId,
      name: params.name,
      tokenHash: hashToken(raw),
      tokenPrefix: tokenPrefix(raw),
      tokenEncrypted: encryptRawToken(raw),
    })
    .returning();
  return { raw, token: row! };
}

/**
 * Fetch the active (non-revoked) token for a user. Returns the displayable
 * raw token if encryption is configured AND the row was created after
 * encrypt-at-rest was enabled. Otherwise returns just the prefix.
 */
export async function getActiveToken(userId: string): Promise<{
  tokenId: string;
  tokenPrefix: string;
  /** Decrypted raw token, when available. null for legacy hash-only rows or
   *  if TOKEN_ENC_KEY isn't configured on this server. */
  rawToken: string | null;
} | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      tokenPrefix: apiTokens.tokenPrefix,
      tokenEncrypted: apiTokens.tokenEncrypted,
    })
    .from(apiTokens)
    .where(
      and(eq(apiTokens.createdByUserId, userId), isNull(apiTokens.revokedAt)),
    )
    .orderBy(desc(apiTokens.createdAt))
    .limit(1);
  if (!row) return null;
  const rawToken = row.tokenEncrypted
    ? decryptStoredToken(row.tokenEncrypted)
    : null;
  return { tokenId: row.id, tokenPrefix: row.tokenPrefix, rawToken };
}

export async function listTokens(userId: string) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.createdByUserId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

export async function revokeToken(params: {
  userId: string;
  tokenId: string;
}) {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, params.tokenId),
        eq(apiTokens.createdByUserId, params.userId),
      ),
    );
}

export async function resolveBearer(raw: string): Promise<{
  userId: string;
  tokenId: string;
} | null> {
  if (!isValidFormat(raw)) return null;
  const hash = hashToken(raw);

  const [row] = await db
    .select({
      id: apiTokens.id,
      createdByUserId: apiTokens.createdByUserId,
      tokenHash: apiTokens.tokenHash,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(
      and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)),
    )
    .limit(1);

  if (!row) return null;

  // Defensive: constant-time compare even after indexed lookup.
  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort last_used_at bump; do not block on it.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch(() => {});

  return { userId: row.createdByUserId, tokenId: row.id };
}
