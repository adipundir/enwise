/**
 * One-off: flip a user's plan to "pro" by email. Manual escape hatch
 * until the Stripe checkout + webhook branch lands.
 *
 * Run: npx tsx lib/db/_grant-pro.ts <email>
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npx tsx lib/db/_grant-pro.ts <email>");
    process.exit(1);
  }

  const [updated] = await db
    .update(users)
    .set({ plan: "pro", updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      plan: users.plan,
    });

  if (!updated) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }

  console.log("granted Pro:");
  console.log(JSON.stringify(updated, null, 2));
}

main().then(() => process.exit(0));
