import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

// Public client invoice portal: anyone can view these URLs
// so the emailed "Pay Now / View Invoice" link works without logging in.
//
// NOTE: /api/invoices is NOT listed here — list/create/mutate endpoints are
// protected with requireUser() inside their handlers. The single exception
// (GET /api/invoices/:id, used by the public /view/:id portal) performs its
// own auth check inside the handler.
const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/reset-password",
  "/forgot-password",
  "/view",
  "/portal",
  "/api/auth",
  "/api/register",
  "/api/public",
  "/api/webhooks",
  "/api/cron",
  "/api/site",
  "/_next",
  "/favicon.ico",
  "/og.png",
];

// Routes requiring authentication
const PROTECTED_PREFIXES = ["/dashboard", "/invoices", "/clients", "/settings", "/recurring", "/expenses"];

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

function isPublic(pathname: string) {
  // Root / is handled specially — redirects based on session
  if (pathname === "/") return true;
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // Apply security headers everywhere except NextAuth endpoints (which
  // manage their own cookies/redirects).
  if (!pathname.startsWith("/api/auth")) {
    applySecurityHeaders(response);
  }

  // Static assets — always allow
  if (
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|css|js|map|txt)$/.test(
      pathname
    ) ||
    pathname.startsWith("/_next")
  ) {
    return response;
  }

  if (isPublic(pathname)) {
    return response;
  }

  if (isProtected(pathname)) {
    const session = await auth();
    if (!session) {
      const url = new URL("/login", request.url);
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
  }

  return response;
}

function applySecurityHeaders(res: NextResponse) {
  const h = res.headers;
  h.set("X-DNS-Prefetch-Control", "off");
  h.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  );
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // External scripts: Razorpay Checkout (checkout.razorpay.com) and Stripe
      // Checkout (js.stripe.com) for client-side payment flows + Next.js HMR.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://js.stripe.com",
      "script-src-elem 'self' 'unsafe-inline' https://checkout.razorpay.com https://js.stripe.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      // Stripe & Razorpay host their Checkout UI in iframes.
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://api.razorpay.com https://checkout.razorpay.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ")
  );
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|css|js|map|txt)$).*)",
  ],
};
