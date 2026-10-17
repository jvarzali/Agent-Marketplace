import { getWallet } from "@agent-wallet/core";
import { getDb } from "@agent-wallet/db";
import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";

const SIGN_IN_TTL_SECONDS = 10 * 60;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Email magic-link sign-in. The link goes out through the wallet's email sender: Resend when
// RESEND_API_KEY is set, otherwise it's printed to the server log (handy for local dev).
// Lazy config, so importing this (e.g. during `next build`) doesn't connect to the database.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // The generated Prisma 7 client is structurally what the adapter expects, but typed separately.
  adapter: PrismaAdapter(getDb() as unknown as Parameters<typeof PrismaAdapter>[0]),
  session: { strategy: "database" },
  pages: { signIn: "/login", verifyRequest: "/login", error: "/login" },
  providers: [
    {
      id: "email",
      type: "email",
      name: "Email",
      maxAge: SIGN_IN_TTL_SECONDS,
      async sendVerificationRequest({ identifier, url }) {
        await getWallet().deps.email.send({
          to: identifier,
          subject: "Your AgentMart sign-in link",
          text: `Sign in to AgentMart:\n${url}\n\nThe link works once and expires in 10 minutes. If you didn't ask for it, ignore this email.`,
          html: `<p><a href="${escapeHtml(url)}">Sign in to AgentMart</a></p><p>The link works once and expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
        });
      },
    },
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
}));
