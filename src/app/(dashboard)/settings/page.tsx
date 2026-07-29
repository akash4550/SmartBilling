"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Building2,
  Mail,
  MapPin,
  Phone,
  Percent,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Globe,
  Receipt,
  UserCircle,
  ChevronRight,
  Palette,
  FileText,
  Calendar,
  Hash,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { settingsSchema, type SettingsInput } from "@/lib/validations";
import { LogoUploader } from "@/components/settings/logo-uploader";
import { BrandColorPicker } from "@/components/settings/brand-color-picker";
import { BrandingPreview } from "@/components/settings/branding-preview";

type SettingsResponse = SettingsInput & {
  id: number;
  updatedAt: string;
  hasLogo: boolean;
  logoUrl: string | null;
  defaultNotes?: string | null;
  defaultDueDays?: number;
};

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Branding state (lifted here because logo upload and the color picker
  // both mutate it independently of the main form submit).
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [brandColor, setBrandColor] = useState<string>("#2563eb");

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = useForm<SettingsInput>({
    resolver: zodResolver(settingsSchema) as any,
    defaultValues: {
      companyName: "",
      companyEmail: "",
      companyAddress: "",
      companyPhone: "",
      defaultTaxRate: 0,
      taxLabel: "GST",
      currency: "INR",
      brandColor: "#2563eb",
      defaultNotes: "",
      defaultDueDays: 30,
      invoicePrefix: "INV",
      invoiceSeparator: "-",
      invoicePad: 4,
    },
  });

  const companyName = watch("companyName");
  const previewPrefix = watch("invoicePrefix") || "INV";
  const previewSep = (watch("invoiceSeparator") ?? "-").toString();
  const previewPad = Number(watch("invoicePad")) || 4;
  const previewNumber = `${(previewPrefix || "INV").toUpperCase()}${previewSep}${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${previewSep}${"1".padStart(previewPad, "0")}`;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load settings");
        const data: SettingsResponse = await res.json();
        if (!active) return;
        reset({
          companyName: data.companyName,
          companyEmail: data.companyEmail,
          companyAddress: data.companyAddress ?? "",
          companyPhone: data.companyPhone ?? "",
          defaultTaxRate: Number(data.defaultTaxRate),
          taxLabel: (data as Partial<SettingsResponse> & { taxLabel?: string }).taxLabel ?? "GST",
          currency: data.currency,
          brandColor: data.brandColor ?? "#2563eb",
          defaultNotes: data.defaultNotes ?? "",
          defaultDueDays: typeof data.defaultDueDays === "number" ? data.defaultDueDays : 30,
          invoicePrefix: (data as Partial<SettingsResponse> & { invoicePrefix?: string }).invoicePrefix ?? "INV",
          invoiceSeparator: (data as Partial<SettingsResponse> & { invoiceSeparator?: string }).invoiceSeparator ?? "-",
          invoicePad: typeof (data as { invoicePad?: unknown }).invoicePad === "number" ? (data as { invoicePad: number }).invoicePad : 4,
        });
        setLogoUrl(data.logoUrl);
        setBrandColor(data.brandColor ?? "#2563eb");
      } catch (err) {
        if (active) setFetchError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [reset]);

  // Keep local brandColor in sync with the form (so the preview updates as
  // the user types in the hex field too).
  useEffect(() => {
    const sub = watch((val, { name }) => {
      if (name === "brandColor" && val.brandColor) {
        setBrandColor(String(val.brandColor));
      }
    });
    return () => sub.unsubscribe();
  }, [watch]);

  async function onSubmit(values: SettingsInput) {
    setSaving(true);
    setSuccess(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      const updated: SettingsResponse = await res.json();
      setLogoUrl(updated.logoUrl);
      setBrandColor(updated.brandColor ?? "#2563eb");
      setSuccess(true);
      toast.success("Settings saved", { description: "Your company profile is up to date." });
      // Sync reset so isDirty goes false without losing current values.
      reset(values);
      setTimeout(() => setSuccess(false), 3500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="text-center py-16">
        <AlertCircle className="h-10 w-10 mx-auto text-red-500 mb-3" />
        <p className="text-red-600">{fetchError}</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
            <Building2 className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
              Company Settings
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              These details appear on all your invoices, PDFs, and emails to clients.
            </p>
          </div>
        </div>
      </div>

      {success && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-950/40 dark:to-green-950/40 border border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300 animate-in fade-in">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Settings saved</p>
            <p className="text-xs text-emerald-600 dark:text-emerald-400">Your company profile has been updated successfully.</p>
          </div>
        </div>
      )}

      {/* Account shortcut card */}
      <Link href="/settings/account">
        <Card className="border-slate-200/60 dark:border-slate-800/60 hover:border-slate-300 dark:hover:border-slate-700 transition-colors cursor-pointer group">
          <CardContent className="py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <UserCircle className="h-5 w-5 text-slate-600 dark:text-slate-400" />
              </div>
              <div>
                <p className="font-semibold text-sm text-slate-900 dark:text-white">Account</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Update your name, email, password, or delete your account
                </p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors" />
          </CardContent>
        </Card>
      </Link>

      {/* Branding / Logo card */}
      <Card className="border-slate-200/60 dark:border-slate-800/60">
        <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-blue-600" />
            <CardTitle className="text-base">Branding</CardTitle>
          </div>
          <CardDescription>
            Upload your logo and pick an accent color to make invoices feel like your business.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          <LogoUploader
            logoUrl={logoUrl}
            onUploaded={(url) => setLogoUrl(url)}
            onRemoved={() => setLogoUrl(null)}
          />

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <BrandColorPicker
              value={brandColor}
              onChange={(hex) => {
                setBrandColor(hex);
                setValue("brandColor", hex, { shouldDirty: true });
              }}
            />
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                Preview
              </Label>
              <BrandingPreview
                companyName={companyName || "Your Business Name"}
                logoUrl={logoUrl}
                brandColor={brandColor}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Business Profile card */}
      <form onSubmit={handleSubmit(onSubmit)}>
        <Card className="border-slate-200/60 dark:border-slate-800/60">
          <CardHeader className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 rounded-t-xl">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-blue-600" />
              <CardTitle className="text-base">Business Profile</CardTitle>
            </div>
            <CardDescription>Update how your business appears to clients.</CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-5">
            <input type="hidden" {...register("brandColor")} />

            <div className="space-y-2">
              <Label htmlFor="companyName" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <Building2 className="h-3.5 w-3.5" /> Company Name <span className="text-red-500">*</span>
              </Label>
              <Input id="companyName" {...register("companyName")} placeholder="Acme Corp" className="h-11" />
              {errors.companyName && <p className="text-xs text-red-600 dark:text-red-400">{errors.companyName.message}</p>}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="companyEmail" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Mail className="h-3.5 w-3.5" /> Email <span className="text-red-500">*</span>
                </Label>
                <Input id="companyEmail" type="email" {...register("companyEmail")} placeholder="billing@acme.com" className="h-11" />
                {errors.companyEmail && <p className="text-xs text-red-600 dark:text-red-400">{errors.companyEmail.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyPhone" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Phone className="h-3.5 w-3.5" /> Phone
                </Label>
                <Input id="companyPhone" {...register("companyPhone")} placeholder="+91 98765 43210" className="h-11" />
                {errors.companyPhone && <p className="text-xs text-red-600 dark:text-red-400">{errors.companyPhone.message}</p>}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="companyAddress" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <MapPin className="h-3.5 w-3.5" /> Address
              </Label>
              <textarea
                id="companyAddress"
                {...register("companyAddress")}
                rows={3}
                className="flex w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-4 py-3 text-sm ring-offset-white dark:ring-offset-slate-950 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 focus-visible:ring-offset-2 resize-none text-slate-900 dark:text-slate-100"
                placeholder="Street address, city, state, ZIP, country"
              />
              {errors.companyAddress && <p className="text-xs text-red-600 dark:text-red-400">{errors.companyAddress.message}</p>}
            </div>

            <div className="rounded-lg border border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/20 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300">Invoice Number Preview</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">The next invoice will be numbered:</p>
              </div>
              <code className="font-mono text-sm sm:text-base font-semibold text-blue-700 dark:text-blue-300 bg-white dark:bg-slate-950/60 rounded px-3 py-1.5 border border-blue-200 dark:border-blue-900/40 whitespace-nowrap">
                {previewNumber}
              </code>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="defaultTaxRate" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Percent className="h-3.5 w-3.5" /> Default Tax Rate (%)
                </Label>
                <Input id="defaultTaxRate" type="number" step="0.01" min={0} max={100} {...register("defaultTaxRate")} className="h-11" />
                {errors.defaultTaxRate && <p className="text-xs text-red-600 dark:text-red-400">{errors.defaultTaxRate.message}</p>}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Pre-filled for new invoices (can be overridden per invoice).
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="taxLabel" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Receipt className="h-3.5 w-3.5" /> Tax Label
                </Label>
                <Input
                  id="taxLabel"
                  {...register("taxLabel")}
                  placeholder="GST"
                  className="h-11 font-semibold uppercase tracking-wide"
                  maxLength={12}
                />
                {errors.taxLabel && <p className="text-xs text-red-600 dark:text-red-400">{errors.taxLabel.message}</p>}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Shown next to the tax line (GST, VAT, IGST, TAX, etc.).
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="defaultDueDays" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Calendar className="h-3.5 w-3.5" /> Payment Terms (days)
                </Label>
                <Input id="defaultDueDays" type="number" min={0} max={365} step={1} {...register("defaultDueDays")} className="h-11" />
                {errors.defaultDueDays && <p className="text-xs text-red-600 dark:text-red-400">{errors.defaultDueDays.message}</p>}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Default due date for new invoices (0 = due on receipt).
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoicePrefix" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Hash className="h-3.5 w-3.5" /> Invoice Number Prefix
                </Label>
                <Input id="invoicePrefix" {...register("invoicePrefix")} placeholder="INV" className="h-11 font-mono uppercase" maxLength={12} />
                {errors.invoicePrefix && <p className="text-xs text-red-600 dark:text-red-400">{errors.invoicePrefix.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoiceSeparator" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  Separator
                </Label>
                <select
                  id="invoiceSeparator"
                  {...register("invoiceSeparator")}
                  className="flex h-11 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm font-mono"
                >
                  <option value="-">- dash</option>
                  <option value="_">_ underscore</option>
                  <option value=".">. dot</option>
                  <option value="/">/ slash</option>
                  <option value=" "> (space)</option>
                  <option value="">none</option>
                </select>
                {errors.invoiceSeparator && <p className="text-xs text-red-600 dark:text-red-400">{errors.invoiceSeparator.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoicePad" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  Number Padding
                </Label>
                <Input id="invoicePad" type="number" min={2} max={8} step={1} {...register("invoicePad")} className="h-11 font-mono" />
                {errors.invoicePad && <p className="text-xs text-red-600 dark:text-red-400">{errors.invoicePad.message}</p>}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Sequence digits (3 → 001).
                </p>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="currency" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Globe className="h-3.5 w-3.5" /> Currency
                </Label>
                <Input id="currency" {...register("currency")} placeholder="INR" className="h-11 font-mono uppercase" />
                {errors.currency && <p className="text-xs text-red-600 dark:text-red-400">{errors.currency.message}</p>}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  ISO code (INR, USD, EUR, etc.)
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="defaultNotes" className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <FileText className="h-3.5 w-3.5" /> Default Notes / Terms
              </Label>
              <Textarea
                id="defaultNotes"
                rows={4}
                placeholder={"Thank you for your business!\n\nPayment due within 30 days.\nBank: ACME Bank • A/C 1234567890 • IFSC ACME0001234"}
                {...register("defaultNotes")}
                className="resize-y min-h-[110px]"
                maxLength={2000}
              />
              {errors.defaultNotes && <p className="text-xs text-red-600 dark:text-red-400">{errors.defaultNotes.message}</p>}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Pre-filled on every new invoice (payment terms, bank details, thank-you note, etc.). You can edit per invoice.
              </p>
            </div>

            <Separator />

            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => reset()} disabled={saving || !isDirty}>
                Reset
              </Button>
              <Button type="submit" disabled={saving} className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 px-6">
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
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
