"use client";

import Link from "next/link";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, KeyRound, Loader2, CheckCircle2 } from "lucide-react";

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token) {
      toast.error("Missing or invalid reset token");
    }
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    const newErrors: Record<string, string> = {};
    if (password.length < 8) newErrors.password = "Password must be at least 8 characters";
    else if (!/[A-Z]/.test(password)) newErrors.password = "Must contain an uppercase letter";
    else if (!/[a-z]/.test(password)) newErrors.password = "Must contain a lowercase letter";
    else if (!/[0-9]/.test(password)) newErrors.password = "Must contain a number";
    if (password !== confirm) newErrors.confirm = "Passwords don't match";
    if (Object.keys(newErrors).length) {
      setErrors(newErrors);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to reset password");
        return;
      }
      setSuccess(true);
      toast.success("Password updated", { description: "You can now sign in." });
      setTimeout(() => router.push("/login"), 2500);
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md relative z-10 shadow-xl border-slate-200/60 dark:border-slate-800/60 backdrop-blur-sm">
      <CardHeader className="text-center">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-lg shadow-emerald-500/25 mb-3">
          <KeyRound className="h-7 w-7 text-white" />
        </div>
        <CardTitle className="text-2xl">Set new password</CardTitle>
        <CardDescription>Choose a strong new password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        {success ? (
          <div className="text-center py-4 space-y-4">
            <div className="h-12 w-12 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Your password has been reset. Redirecting you to sign in…
            </p>
            <Link href="/login">
              <Button variant="outline" className="w-full">Go to sign in</Button>
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                aria-invalid={!!errors.password}
              />
              {errors.password && <p className="text-xs text-red-600">{errors.password}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                aria-invalid={!!errors.confirm}
              />
              {errors.confirm && <p className="text-xs text-red-600">{errors.confirm}</p>}
            </div>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-emerald-500 to-green-600"
              disabled={loading || !token}
            >
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
              Reset password
            </Button>
            <div className="text-center pt-2">
              <Link href="/login" className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-emerald-50/30 to-green-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 p-4 relative overflow-hidden">
      <div className="absolute top-0 -left-40 w-96 h-96 bg-emerald-400/20 dark:bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 -right-40 w-96 h-96 bg-green-400/20 dark:bg-green-500/10 rounded-full blur-3xl pointer-events-none" />
      <Suspense fallback={<div className="text-slate-400">Loading…</div>}>
        <ResetPasswordInner />
      </Suspense>
    </div>
  );
}
