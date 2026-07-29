import NextAuth, { type DefaultSession, CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { prisma } from "@/lib/prisma";

export { type DefaultSession } from "next-auth";

// ---------------------------------------------------------------------------
// Extend the NextAuth type to include `id` on the session user
// ---------------------------------------------------------------------------
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

// ---------------------------------------------------------------------------
// NextAuth v5 configuration
// ---------------------------------------------------------------------------
const providers: Provider[] = [
  Credentials({
    name: "credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        throw new CredentialsSignin("Email and password are required");
      }

      const email = String(credentials.email).toLowerCase().trim();
      const password = String(credentials.password);

      if (password.length < 6) {
        throw new CredentialsSignin("Invalid email or password");
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        // Use a generic error to avoid user-enumeration.
        throw new CredentialsSignin("Invalid email or password");
      }

      // Lazy-load argon2 so that native module resolution only happens at
      // request time (avoids Next 16 Turbopack dev-server bundling issues
      // with native addons during SSR of unrelated pages).
      let valid = false;
      try {
        const argon2 = (await import("argon2")).default;
        valid = await argon2.verify(user.passwordHash, password);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new CredentialsSignin("Invalid email or password");
      }

      return {
        id: user.id,
        name: user.name,
        email: user.email,
      };
    },
  }),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      // On first sign-in, embed the user's id into the JWT.
      if (user) {
        token.id = (user as { id: string }).id;
        token.name = user.name;
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose id + name/email in the client-accessible session.
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.name = token.name as string;
        session.user.email = token.email as string;
      }
      return session;
    },
  },
});
