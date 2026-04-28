import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { db } from "@/lib/db";
import {
  accounts,
  businesses,
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";
import { uniqueSlug } from "@/lib/slug";
import { createToken } from "@/lib/tokens";

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [Google, GitHub],
  session: { strategy: "database" },
  pages: { signIn: "/signin" },
  callbacks: {
    session({ session, user }) {
      // Expose the user's default business to client-side session consumers.
      session.user.id = user.id;
      // @ts-expect-error user is the full DB row; the extra column rides along
      session.user.defaultBusinessId = user.defaultBusinessId ?? null;
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (!user.id) return;
      const businessName = user.name
        ? `${user.name.split(" ")[0]}'s Business`
        : "My Business";
      const [created] = await db
        .insert(businesses)
        .values({
          ownerUserId: user.id,
          name: businessName,
          slug: uniqueSlug(businessName),
        })
        .returning({ id: businesses.id });
      if (created) {
        await db
          .update(users)
          .set({ defaultBusinessId: created.id })
          .where(eq(users.id, user.id));
      }
      // Mint the user's API token at signup time so it's encrypted from
      // creation. The dashboard's lazy fallback stays for safety, but with
      // this hook in place, new accounts always have a retrievable token
      // on first dashboard load.
      await createToken({ createdByUserId: user.id, name: "Default" });
    },
  },
});
