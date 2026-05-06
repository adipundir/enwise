// Rotate all active API tokens for a single user (by email).
// Revokes every non-revoked api_tokens row for that user, then issues one
// fresh token using the existing helpers so encrypt-at-rest stays correct.
//
// Run with:  npx tsx scripts/rotate-tokens.ts <email>

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiTokens, users } from "@/lib/db/schema";
import { createToken } from "@/lib/tokens";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: tsx scripts/rotate-tokens.ts <email>");
    process.exit(1);
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    console.error(`no user found for email: ${email}`);
    process.exit(2);
  }

  const active = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.createdByUserId, user.id), isNull(apiTokens.revokedAt)));

  console.log(`user: ${user.email} (${user.id})`);
  console.log(`active tokens before rotation: ${active.length}`);
  for (const t of active) {
    console.log(
      `  - ${t.tokenPrefix}…  name="${t.name}"  created=${t.createdAt.toISOString()}  lastUsed=${
        t.lastUsedAt ? t.lastUsedAt.toISOString() : "never"
      }`,
    );
  }

  const revokedAt = new Date();
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt })
    .where(and(eq(apiTokens.createdByUserId, user.id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  console.log(`revoked ${revoked.length} token(s) at ${revokedAt.toISOString()}`);

  const carryName = active[0]?.name ?? "default";
  const { raw, token } = await createToken({
    createdByUserId: user.id,
    name: carryName,
  });
  console.log(`issued new token id=${token.id}  name="${token.name}"  prefix=${token.tokenPrefix}`);
  console.log("");
  console.log("NEW RAW TOKEN (copy now, won't be shown again unless TOKEN_ENC_KEY is set):");
  console.log(raw);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
