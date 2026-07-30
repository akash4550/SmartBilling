import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Security & hygiene
  reactStrictMode: true,
  poweredByHeader: false,

  // Pin Turbopack's workspace root to this project directory so dev mode
  // doesn't warn about "multiple lockfiles" when there happens to be a
  // package-lock.json in a parent folder (common on Windows with OneDrive).
  turbopack: {
    root: import.meta.dirname,
  },

  // Only allow images from same-origin (public folder) by default.
  // Add external hostnames here (e.g. avatars, logos) as they are introduced.
  images: {
    remotePatterns: [],
  },

  // Application is fully routed through /(dashboard), /login, /view; ensure
  // trailing-slash behaviour is standard so links don't double-redirect.
  trailingSlash: false,

  // Note: We run `tsc --noEmit` separately for strict type-checking rather
  // than silencing typescript errors during `next build`.

  async headers() {
    // Security headers are also applied in middleware for dynamic routes, but
    // adding them here ensures they are set even for static/public assets.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
