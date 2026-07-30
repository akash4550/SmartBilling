import NextAuth, { type DefaultSession, CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { prisma } from "@/lib/prisma";

export { type DefaultSession } from "next-auth";

// Extend the NextAuth types to include `id` and `sessionVersion`.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      sessionVersion: number;
    } & DefaultSession["user"];
  }
}

// Extend the JWT shape with sessionVersion so we can revoke tokens later.
declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    sessionVersion?: number;
    name?: string | null;
    email?: string | null;
  }
}

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
        throw new CredentialsSignin("Invalid email or password");
      }

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
        // Embed sessionVersion so downstream checks can revoke stale JWTs.
        sessionVersion: user.sessionVersion,
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
      // On first sign-in, embed user id + sessionVersion into the JWT.
      if (user) {
        token.id = (user as { id: string }).id;
        token.name = user.name;
        token.email = user.email;
        token.sessionVersion = (user as { sessionVersion?: number }).sessionVersion ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.name = token.name as string;
        session.user.email = token.email as string;
        session.user.sessionVersion = (token.sessionVersion as number) ?? 0;
      }
      return session;
    },
  },
});
