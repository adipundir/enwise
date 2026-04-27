import { createHash, timingSafeEqual } from "node:crypto";
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
    })
    .returning();
  return { raw, token: row! };
}

/**
 * Fetch the active (non-revoked) token for a user. Tokens are now user-scoped
 *. one token grants access to every business the user owns. Returns only
 * identifying fields; the raw secret is never persisted.
 */
export async function getActiveToken(userId: string): Promise<{
  tokenId: string;
  tokenPrefix: string;
} | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      tokenPrefix: apiTokens.tokenPrefix,
    })
    .from(apiTokens)
    .where(
      and(eq(apiTokens.createdByUserId, userId), isNull(apiTokens.revokedAt)),
    )
    .orderBy(desc(apiTokens.createdAt))
    .limit(1);
  if (!row) return null;
  return { tokenId: row.id, tokenPrefix: row.tokenPrefix };
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
