import { handlers } from "@/lib/auth";

/**
 * Catch-all route handler for NextAuth (Auth.js v5).
 * GET and POST are required: NextAuth handles all auth flows at
 * /api/auth/signin, /api/auth/callback, /api/auth/session, /api/auth/signout, etc.
 */
export const { GET, POST } = handlers;
