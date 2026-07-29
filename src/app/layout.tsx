import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { auth } from "@/lib/auth";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "SmartBill — Billing & Invoicing Dashboard",
    template: "%s | SmartBill",
  },
  description:
    "SmartBill is a modern, AI-powered billing and invoicing dashboard for freelancers and small businesses. Create professional invoices, track payments, scan receipts with AI, and manage clients — all in one place.",
  applicationName: "SmartBill",
  authors: [{ name: "SmartBill" }],
  creator: "SmartBill",
  publisher: "SmartBill",
  keywords: [
    "invoicing",
    "billing",
    "invoice generator",
    "small business",
    "freelance",
    "receipt scanning",
    "AI OCR",
    "payment tracking",
    "GST billing",
  ],
  category: "finance",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: SITE_URL,
    siteName: "SmartBill",
    title: "SmartBill — Smart Billing & Invoicing Dashboard",
    description:
      "Create professional invoices, track payments, scan receipts with AI, and manage clients — all from one modern dashboard.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "SmartBill" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SmartBill — Smart Billing & Invoicing Dashboard",
    description:
      "Create professional invoices, track payments, scan receipts with AI, and manage clients — all from one modern dashboard.",
    images: ["/og.png"],
  },
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
  alternates: { canonical: SITE_URL },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2563eb" },
    { media: "(prefers-color-scheme: dark)", color: "#1e293b" },
  ],
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Pre-fetch the session on the server so the client is hydrated immediately
  // (avoids a flash of "Sign in" before the session loads).
  const session = await auth();

  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <SessionProvider session={session}>
          <ThemeProvider>
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col transition-colors">
              {children}
            </div>
            <ToasterProvider />
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
