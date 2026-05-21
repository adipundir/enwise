import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/lib/db/schema";
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
      // Mint the user's API token at signup time so it's encrypted from
      // creation. New accounts always have a retrievable token on first
      // dashboard load.
      //
      // We deliberately do NOT auto-create a business here — the MCP
      // layer handles the "no businesses" case with a structured
      // `no_businesses` error that points Claude at `create_business`,
      // and auto-seeding a placeholder like "Aditya's Business" tends to
      // leak onto a real invoice when the user forgets to rename it.
      await createToken({ createdByUserId: user.id, name: "Default" });
    },
  },
});
