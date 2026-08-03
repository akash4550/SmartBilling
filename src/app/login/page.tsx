"use client";

import { FormEvent, useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Receipt, Loader2, AlertCircle, Sparkles, CheckCircle2 } from "lucide-react";

const DEMO_EMAIL = process.env.NODE_ENV === "development" ? "admin@smartbill.com" : "";
const DEMO_PASSWORD = process.env.NODE_ENV === "development" ? "password123" : "";

/**
 * Validate / sanitize the `callbackUrl` so it can't be abused for open-redirect
 * phishing (e.g. `?callbackUrl=https://evil.com`). Only same-origin relative
 * paths starting with `/` are allowed; protocol-relative URLs (`//evil.com`)
 * and fully-qualified external URLs are rejected.
 */
function safeCallbackUrl(raw: string | null, origin: string): string {
  const fallback = "/dashboard";
  if (!raw) return fallback;
  try {
    // Absolute URL on our own origin? Accept the pathname+search.
    const parsed = new URL(raw, origin);
    if (parsed.origin === origin) {
      return parsed.pathname + parsed.search + parsed.hash || fallback;
    }
  } catch {
    // Treat as a relative path.
  }
  // Relative path only — must start with a single `/` and not `//`.
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return fallback;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const err = searchParams.get("error");
      setError(err === "CredentialsSignin" ? "Invalid email or password." : err ? "Sign-in failed. Please try again." : null);
      const emailParam = searchParams.get("email");
      if (emailParam) { setEmail(emailParam); setPassword(""); }
    }, 0);
    return () => clearTimeout(timer);
  }, [searchParams]);

  const registered = searchParams.get("registered") === "1";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // Compute the safe redirect target at submit time so window.location.origin
    // is available (this is a client component but this function only runs
    // in the browser after user interaction).
    const rawCallback = searchParams.get("callbackUrl");
    const callbackUrl = safeCallbackUrl(rawCallback, window.location.origin);
    try {
      const res = await signIn("credentials", { email, password, redirect: false, callbackUrl });
      if (!res || res.error) { setError("Invalid email or password."); return; }
      // Validate the post-signIn URL too (NextAuth returns `url` which could be
      // influenced by the same query param), then route.
      const finalUrl = safeCallbackUrl(res.url ?? callbackUrl, window.location.origin);
      router.push(finalUrl);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 relative overflow-hidden">
      {/* Decorative elements */}
      <div className="absolute top-0 -left-40 w-96 h-96 bg-blue-400/20 dark:bg-blue-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -right-40 w-96 h-96 bg-indigo-400/20 dark:bg-indigo-500/10 rounded-full blur-3xl" />

      <div className="w-full max-w-md relative z-10">
        {/* Brand */}
        <Link href="/" className="flex items-center justify-center gap-3 mb-8">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Receipt className="h-6 w-6 text-white" />
          </div>
          <span className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">
            SmartBill
          </span>
        </Link>

        <Card className="shadow-xl shadow-slate-200/50 dark:shadow-black/20 border-slate-200/60 dark:border-slate-800/60 backdrop-blur-sm">
          <CardHeader className="text-center space-y-2">
            <CardTitle className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
              Welcome back
            </CardTitle>
            <CardDescription className="text-slate-500 dark:text-slate-400">
              Sign in to manage your invoices and clients
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {registered && (
                <div className="flex items-start gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>Account created — sign in to get started.</span>
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 p-3 text-sm text-red-700 dark:text-red-300">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-700 dark:text-slate-300 font-medium">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-700 dark:text-slate-300 font-medium">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11"
                />
              </div>

              <div className="rounded-lg bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 border border-blue-100 dark:border-blue-900/50 px-4 py-3 text-xs text-blue-700 dark:text-blue-300">
                <div className="flex items-center gap-1.5 font-semibold mb-1">
                  <Sparkles className="h-3.5 w-3.5" />
                  Demo credentials (pre-filled)
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 mt-1.5 font-mono">
                  <span className="text-blue-600/70 dark:text-blue-400/70">Email:</span>
                  <span>{DEMO_EMAIL}</span>
                  <span className="text-blue-600/70 dark:text-blue-400/70">Password:</span>
                  <span>{DEMO_PASSWORD}</span>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex flex-col gap-3 pt-2">
              <Button type="submit" className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 text-base font-medium" size="lg" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Signing in...
                  </>
                ) : "Sign In"}
              </Button>
              <div className="text-xs text-center text-slate-500 dark:text-slate-400 space-y-1">
                <p>
                  Don&apos;t have an account?{" "}
                  <Link href="/register" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                    Create one
                  </Link>
                </p>
                <p>
                  <Link href="/forgot-password" className="text-slate-500 hover:text-blue-600 dark:hover:text-blue-400">
                    Forgot your password?
                  </Link>
                </p>
              </div>
            </CardFooter>
          </form>
        </Card>

        <p className="text-center text-xs text-slate-400 dark:text-slate-500 mt-6">
          SmartBill — AI-powered billing for modern freelancers
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
