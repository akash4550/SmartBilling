"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  User,
  Mail,
  Lock,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
  ArrowLeft,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { accountSchema, type AccountInput } from "@/lib/validations";

interface MeResponse {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [initial, setInitial] = useState<{ name: string; email: string } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors },
  } = useForm<AccountInput>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: "",
      email: "",
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const newPassword = watch("newPassword");
  const currentName = watch("name");
  const currentEmail = watch("email");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/users/me", { cache: "no-store" });
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (!res.ok) throw new Error("Failed to load account");
        const data: MeResponse = await res.json();
        if (!active) return;
        const seed = {
          name: data.name,
          email: data.email,
          currentPassword: "",
          newPassword: "",
          confirmPassword: "",
        };
        reset(seed);
        setInitial({ name: data.name, email: data.email });
      } catch (err) {
        if (active) setFetchError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reset, router]);

  async function onSubmit(values: AccountInput) {
    setSaving(true);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {};
      if (initial && values.name?.trim() !== initial.name) {
        payload.name = values.name;
      }
      const nextEmail = (values.email ?? "").toLowerCase().trim();
      if (initial && nextEmail !== initial.email.toLowerCase()) {
        payload.email = nextEmail;
      }
      if (values.newPassword) {
        payload.currentPassword = values.currentPassword;
        payload.newPassword = values.newPassword;
        payload.confirmPassword = values.confirmPassword;
      }
      if (Object.keys(payload).length === 0) {
        toast.info("No changes to save");
        setSaving(false);
        return;
      }

      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.details && Array.isArray(data.details)) {
          for (const d of data.details as Array<{ field: string; message: string }>) {
            setError(d.field as keyof AccountInput, { type: "server", message: d.message });
          }
        }
        throw new Error(data.error || "Failed to save changes");
      }
      const passwordChanged = Boolean(data.passwordChanged);
      setSuccess(data.message || "Profile updated");
      toast.success(passwordChanged ? "Password changed" : "Profile updated", {
        description: passwordChanged
          ? "Please sign in again with your new password."
          : "Your account has been updated.",
      });
      const newInitial = {
        name: (data.user?.name as string) ?? (values.name as string),
        email: (data.user?.email as string) ?? nextEmail,
      };
      setInitial(newInitial);
      reset(
        {
          name: newInitial.name,
          email: newInitial.email,
          currentPassword: "",
          newPassword: "",
          confirmPassword: "",
        },
        { keepDirty: false }
      );
      if (passwordChanged) {
        setTimeout(() => signOut({ callbackUrl: "/login" }), 1500);
      } else {
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const phrase = "DELETE";
    const input = prompt(
      `Are you absolutely sure you want to delete your account? This will permanently erase all your clients, invoices, and settings.\n\nType "${phrase}" to confirm.`
    );
    if (input !== phrase) return;
    const password = prompt("Please enter your password to confirm deletion:");
    if (!password) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/users/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to delete account");
        return;
      }
      toast.success("Account deleted", {
        description: "We're sorry to see you go.",
      });
      await signOut({ callbackUrl: "/login" });
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 max-w-2xl">
        <CardContent className="py-10 text-center text-red-700 dark:text-red-300">
          <AlertCircle className="h-8 w-8 mx-auto mb-2" />
          <p className="font-medium">{fetchError}</p>
          <Button variant="outline" className="mt-4" onClick={() => router.refresh()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/settings">
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Account Settings</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">
            Manage your profile, password, and account
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Profile card */}
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="h-7 w-7 rounded-lg bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
                <User className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </span>
              Profile Information
            </CardTitle>
            <CardDescription>Update your display name and login email.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-slate-700 dark:text-slate-300 font-medium">
                  Full Name
                </Label>
                <Input id="name" {...register("name")} className="h-11" />
                {errors.name && (
                  <p className="text-xs text-red-600 dark:text-red-400">{errors.name.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-700 dark:text-slate-300 font-medium">
                  Email address
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <Input id="email" type="email" {...register("email")} className="h-11 pl-9" />
                </div>
                {errors.email && (
                  <p className="text-xs text-red-600 dark:text-red-400">{errors.email.message}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Password card */}
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
                <Lock className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              Change Password
            </CardTitle>
            <CardDescription>
              Leave blank to keep your current password. Passwords must be at least 8 characters
              and include an uppercase letter, lowercase letter, and a number.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword" className="text-slate-700 dark:text-slate-300 font-medium">
                Current password
              </Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                {...register("currentPassword")}
                className="h-11"
                placeholder="Required only if changing password"
              />
              {errors.currentPassword && (
                <p className="text-xs text-red-600 dark:text-red-400">{errors.currentPassword.message}</p>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword" className="text-slate-700 dark:text-slate-300 font-medium">
                  New password
                </Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  {...register("newPassword")}
                  className="h-11"
                />
                {errors.newPassword && (
                  <p className="text-xs text-red-600 dark:text-red-400">{errors.newPassword.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-slate-700 dark:text-slate-300 font-medium">
                  Confirm new password
                </Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  {...register("confirmPassword")}
                  className="h-11"
                  disabled={!newPassword}
                />
                {errors.confirmPassword && (
                  <p className="text-xs text-red-600 dark:text-red-400">{errors.confirmPassword.message}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Submission */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            {success && (
              <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> {success}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link href="/settings">
              <Button type="button" variant="ghost">Cancel</Button>
            </Link>
            <Button
              type="submit"
              disabled={saving}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" /> Save Changes
                </>
              )}
            </Button>
          </div>
        </div>
      </form>

      <Separator className="my-6" />

      {/* Danger zone */}
      <Card className="border-red-200/60 dark:border-red-900/50 bg-red-50/40 dark:bg-red-950/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-red-700 dark:text-red-400">
            <span className="h-7 w-7 rounded-lg bg-red-100 dark:bg-red-900/50 flex items-center justify-center">
              <Shield className="h-4 w-4 text-red-600 dark:text-red-400" />
            </span>
            Danger Zone
          </CardTitle>
          <CardDescription className="text-red-700/80 dark:text-red-400/80">
            Deleting your account is permanent and cannot be undone. All clients, invoices, and settings will be erased.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-2" />
            )}
            Delete Account
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
