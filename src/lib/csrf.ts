/**
 * Same-origin CSRF check for cookie-authenticated state-changing endpoints.
 *
 * Browser same-origin policy prevents simple cross-origin form submits from
 * setting a custom header or a non-simple Content-Type, and cross-site
 * requests (cross-site form POSTs) will have an Origin/Referer that differs
 * from the server's own origin. We check:
 *   1. If the Origin header is present, it must match the request origin
 *      (X-Forwarded-Host / Host, with https: assumed when behind a proxy).
 *   2. If Origin is not present (e.g. some older browsers), fall back to
 *      Referer.
 *   3. For GET/HEAD/OPTIONS, we always return true (no state change).
 *
 * Cron-secret-authenticated service calls do NOT send a browser Origin, so
 * this check is skipped for those paths by the callers (they authenticate
 * via a bearer token instead).
 */

function getRequestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function getServerOrigin(request: Request): string | null {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host");
  if (!host) return null;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  // X-Forwarded-Host may contain a comma-separated list; take the first.
  const firstHost = host.split(",")[0]?.trim();
  if (!firstHost) return null;
  return `${proto.split(",")[0]?.trim()}://${firstHost}`;
}

/**
 * Returns true if the request is a "simple" (safe) method or if the
 * request Origin matches the server's own origin. Cron/secret-authenticated
 * endpoints should NOT rely on this — they authenticate via bearer token
 * and should skip the check (since they come from schedulers with no
 * Origin at all).
 */
export function isSameOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const reqOrigin = getRequestOrigin(request);
  const serverOrigin = getServerOrigin(request);
  if (!serverOrigin) return false;
  if (!reqOrigin) {
    // No Origin/Referer → deny. Cron endpoints using Bearer should bypass
    // this helper explicitly; cookie-authed browser calls always send Origin.
    return false;
  }
  return reqOrigin === serverOrigin;
}
