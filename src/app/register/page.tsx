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

function safeCallbackUrl(raw: string | null, origin: string): string {
  const fallback = "/dashboard";
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin === origin) return parsed.pathname + parsed.search + parsed.hash || fallback;
  } catch { /* treat as relative */ }
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return fallback;
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const err = searchParams.get("error");
    if (err === "CredentialsSignin") setError("Sign-in failed. Try logging in.");
  }, [searchParams]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      // 1. Create the account
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.details && Array.isArray(data.details)) {
          const fe: Record<string, string> = {};
          for (const d of data.details as Array<{ field: string; message: string }>) {
            fe[d.field] = d.message;
          }
          setFieldErrors(fe);
        } else {
          setError(data.error || "Failed to create account");
        }
        return;
      }

      // 2. Auto sign-in
      const signInRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (!signInRes || signInRes.error) {
        // Account created but sign-in failed — send them to /login.
        router.push(`/login?email=${encodeURIComponent(email)}&registered=1`);
        return;
      }
      const cb = safeCallbackUrl(searchParams.get("callbackUrl"), window.location.origin);
      router.push(cb);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 relative overflow-hidden">
      <div className="absolute top-0 -left-40 w-96 h-96 bg-blue-400/20 dark:bg-blue-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 -right-40 w-96 h-96 bg-indigo-400/20 dark:bg-indigo-500/10 rounded-full blur-3xl" />

      <div className="w-full max-w-md relative z-10">
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
              Create your account
            </CardTitle>
            <CardDescription className="text-slate-500 dark:text-slate-400">
              Start invoicing in under a minute
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 p-3 text-sm text-red-700 dark:text-red-300">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="name" className="text-slate-700 dark:text-slate-300 font-medium">Full name</Label>
                <Input
                  id="name"
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  className="h-11"
                  aria-invalid={!!fieldErrors.name}
                />
                {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
              </div>

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
                  aria-invalid={!!fieldErrors.email}
                />
                {fieldErrors.email && <p className="text-xs text-red-600">{fieldErrors.email}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-700 dark:text-slate-300 font-medium">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="h-11"
                  aria-invalid={!!fieldErrors.password}
                />
                {fieldErrors.password ? (
                  <p className="text-xs text-red-600">{fieldErrors.password}</p>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Passwords are hashed with Argon2id and never stored in plain text.
                  </p>
                )}
              </div>

              <div className="rounded-lg bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 border border-blue-100 dark:border-blue-900/50 px-4 py-3 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2">
                <Sparkles className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  Every account gets its own isolated data — your clients, invoices, and branding stay private.
                </span>
              </div>
            </CardContent>

            <CardFooter className="flex flex-col gap-3 pt-2">
              <Button
                type="submit"
                className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 text-base font-medium"
                size="lg"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Create Account
                  </>
                )}
              </Button>
              <p className="text-xs text-center text-slate-500 dark:text-slate-400">
                Already have an account?{" "}
                <Link href="/login" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                  Sign in
                </Link>
              </p>
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

export default function RegisterPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    }>
      <RegisterForm />
    </Suspense>
  );
}
