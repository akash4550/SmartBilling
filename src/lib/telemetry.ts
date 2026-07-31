/**
 * Lightweight OpenTelemetry-compatible tracing and structured logging.
 *
 * Design
 * ------
 * - Zero npm dependencies — uses only `node:crypto`, `node:async_hooks`,
 *   and `node:perf_hooks` (all in Node's standard library).
 * - W3C Trace Context compliant identifiers: 32-hex-char traceId
 *   (16 random bytes, non-zero), 16-hex-char spanId (8 random bytes,
 *   non-zero). Hex is lowercase to match the W3C traceparent spec.
 * - AsyncLocalStorage propagates the active SpanContext across async
 *   boundaries so helpers (Prisma calls, HTTP fetches, alert dispatchers)
 *   can call `getActiveSpan()?.setAttribute(...)` without prop-drilling.
 * - Each span lifecycle emits exactly one single-line JSON envelope on
 *   completion: stdout for OK, stderr for ERROR. The schema matches the
 *   OpenTelemetry Log Data Model and is ingestible by any OTel collector
 *   (Datadog, Honeycomb, Grafana Tempo, SigNoz, GCP Cloud Logging) via a
 *   trivial stdout/stderr receiver.
 *
 * This module is SERVER-ONLY. It imports node built-ins (crypto/
 * async_hooks/perf_hooks) that do not exist in the browser. Do not
 * import from a `"use client"` bundle.
 */
import "server-only";

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

// ============================================================
// Public types
// ============================================================

/** JSON-serializable attribute value types we accept. */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | Error
  | SpanAttributeValue[]
  | { [key: string]: SpanAttributeValue };

export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface SpanContext {
  /** W3C 32-hex-char lowercase trace ID (shared across a single trace). */
  readonly traceId: string;
  /** W3C 16-hex-char lowercase span ID (unique per span). */
  readonly spanId: string;
  /** Parent span ID, or null for root spans. */
  readonly parentSpanId: string | null;
  /** Span name, e.g. "reconciler.sweep_b". */
  readonly name: string;
  /** Monotonic start timestamp in ms (performance.now() anchor). */
  readonly startedAtPerf: number;
  /** Wall-clock start time as ISO-8601 (millisecond precision). */
  readonly startedAtIso: string;
  /** Set / overwrite a single attribute. Fluent return for chaining. */
  setAttribute(key: string, value: SpanAttributeValue): SpanContext;
  /** Merge multiple attributes at once. */
  setAttributes(attrs: SpanAttributes): SpanContext;
  /** Record an exception on the span without throwing (status stays OK
   *  unless the wrapper itself throws). Sets error.type/error.message
   *  attributes and increments `error.count`. */
  recordException(err: unknown): SpanContext;
  /** Read back an attribute (useful for testing / cross-cutting concerns). */
  getAttribute<T extends SpanAttributeValue>(key: string): T | undefined;
  /** Return a shallow clone of current attributes (snapshot, safe to read). */
  getAttributes(): SpanAttributes;
}

/** Minimal shape accepted as an explicit parent span (traceId/spanId). */
export type ParentSpanRef = Pick<SpanContext, "traceId" | "spanId">;

export interface WithSpanOptions {
  attributes?: SpanAttributes;
  /**
   * Explicit parent. If omitted, the span inherits from AsyncLocalStorage.
   * Accepts either a full SpanContext or the lightweight reference returned
   * by `parseTraceParent()` from an inbound W3C traceparent header.
   */
  parentSpan?: ParentSpanRef;
}

/** Emitted envelope — shape is fixed for log pipeline compatibility. */
export interface SpanEnvelope {
  timestamp: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  status: "OK" | "ERROR";
  durationMs: number;
  attributes: SpanAttributes;
  error?: { type: string; message: string; stack?: string };
}

// ============================================================
// W3C identifier generation
// ============================================================

/**
 * Generate a non-zero hex string of `byteLen` random bytes, lowercase.
 * W3C traceparent §2.2 forbids all-zero IDs (they mean "no trace"), so
 * we loop until we get non-zero bytes (probability ~1/2^128 — single
 * try in practice).
 */
function randomNonZeroHex(byteLen: number): string {
  for (;;) {
    const buf = crypto.randomBytes(byteLen);
    // Fast non-zero check: if every byte is zero, reject.
    let nonzero = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) {
        nonzero = true;
        break;
      }
    }
    if (nonzero) return buf.toString("hex");
  }
}

function generateTraceId(): string {
  return randomNonZeroHex(16); // 32 hex chars
}

function generateSpanId(): string {
  return randomNonZeroHex(8); // 16 hex chars
}

// ============================================================
// Attribute sanitization (BigInt/Date/Error/Decimal/cycle-safe)
// ============================================================

/**
 * Convert arbitrary JS values into JSON-safe primitives/arrays/objects.
 * - bigint → string (preserves precision; OTel recommends strings for int64)
 * - Date → ISO-8601 string
 * - Error → { name, message, stack? }
 * - Prisma.Decimal-like (has .toString()) → string
 * - Circular objects replaced with `"[Circular]"`
 * - Functions / Symbols dropped (undefined → stripped by JSON.stringify)
 */
function sanitizeAttribute(
  value: unknown,
  seen: WeakSet<object>
): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      // JSON.stringify drops NaN/Infinity to null; do it explicitly so
      // downstream parsers see a consistent shape.
      if (typeof value === "number" && !Number.isFinite(value)) return null;
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return undefined;
    case "object":
      break;
    default:
      return String(value);
  }

  // Non-null object.
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  // Prisma Decimal, Long, etc. — duck-type safe.
  if (
    typeof (value as { toString?: () => string }).toString === "function" &&
    typeof (value as { toFixed?: unknown }).toFixed === "function"
  ) {
    // Decimal / BigDecimal-like numeric object: stringify safely.
    try {
      return (value as { toString: () => string }).toString();
    } catch {
      return null;
    }
  }

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(sanitizeAttribute(item, seen));
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeAttribute(v, seen);
    if (sanitized !== undefined) out[k] = sanitized;
  }
  return out;
}

function sanitizeAttributes(attrs: SpanAttributes): SpanAttributes {
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const s = sanitizeAttribute(v, seen);
    if (s !== undefined) out[k] = s;
  }
  return out as SpanAttributes;
}

// ============================================================
// AsyncLocalStorage propagation
// ============================================================

const activeSpanStorage = new AsyncLocalStorage<SpanContext>();

/**
 * Return the currently-active SpanContext (from the nearest enclosing
 * `withSpan` on this async continuation chain), or `undefined` if no
 * span is active. Deep helpers can enrich the span without prop-drilling:
 *
 *   getActiveSpan()?.setAttribute("db.rowsScanned", n);
 */
export function getActiveSpan(): SpanContext | undefined {
  return activeSpanStorage.getStore();
}

/**
 * Inject a span context as "active" for the duration of `fn`. Most
 * callers should use `withSpan`; this escape hatch is for middleware
 * that needs to install a root span across many async operations.
 */
export function runWithSpan<T>(span: SpanContext, fn: () => T): T {
  return activeSpanStorage.run(span, fn);
}

// ============================================================
// SpanContext implementation
// ============================================================

interface InternalSpanContext extends SpanContext {
  /** Internal (mutable) attribute map; unsanitized until emit. */
  _attributes: Record<string, unknown>;
  _errorCount: number;
}

function makeSpanContext(
  name: string,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  initialAttributes: SpanAttributes
): InternalSpanContext {
  const span: InternalSpanContext = {
    traceId,
    spanId,
    parentSpanId,
    name,
    startedAtPerf: performance.now(),
    startedAtIso: new Date().toISOString(),
    _attributes: { ...initialAttributes },
    _errorCount: 0,

    setAttribute(key: string, value: SpanAttributeValue): SpanContext {
      this._attributes[key] = value;
      return this;
    },

    setAttributes(attrs: SpanAttributes): SpanContext {
      for (const [k, v] of Object.entries(attrs)) {
        this._attributes[k] = v;
      }
      return this;
    },

    recordException(err: unknown): SpanContext {
      this._errorCount++;
      this._attributes["error.count"] = this._errorCount;
      this._attributes["error.type"] =
        err instanceof Error ? err.name : typeof err;
      this._attributes["error.message"] =
        err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.stack) {
        this._attributes["error.stack"] = err.stack;
      }
      return this;
    },

    getAttribute<T extends SpanAttributeValue>(key: string): T | undefined {
      return this._attributes[key] as T | undefined;
    },

    getAttributes(): SpanAttributes {
      return { ...this._attributes } as SpanAttributes;
    },
  };
  return span;
}

// ============================================================
// Emit
// ============================================================

let emitHook: ((envelope: SpanEnvelope) => void) | null = null;

/**
 * Install a test/transport hook for capturing envelopes (useful for
 * vitest — see reconciler-alerts integration). Calling with `null`
 * restores default stdout/stderr emission.
 *
 * The hook fires for every span (OK + ERROR) AFTER the default
 * stdout/stderr write; it does NOT suppress logging.
 */
export function _setEmitHook(hook: ((e: SpanEnvelope) => void) | null): void {
  emitHook = hook;
}

function emitEnvelope(env: SpanEnvelope): void {
  // Single-line JSON. toISOString already yields millisecond precision.
  const line = JSON.stringify(env);
  if (env.status === "ERROR") {
    // Write atomically to stderr (writeSync to avoid interleaving with
    // pending async logs during crash).
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
  if (emitHook) {
    try {
      emitHook(env);
    } catch {
      // Hook errors must never break user code path.
    }
  }
}

// ============================================================
// withSpan — public entry point
// ============================================================

/**
 * Execute `fn` within a new tracing span. The span is automatically
 * installed into AsyncLocalStorage so `getActiveSpan()` returns it
 * everywhere inside `fn` (and any async work kicked off by `fn` before
 * the returned promise resolves).
 *
 * On success  → emits { status: "OK", durationMs, attributes } to stdout.
 * On failure  → attaches error.type/error.message/stack, emits { status:
 *               "ERROR" } to stderr, then rethrows the original error.
 *
 * If no `parentSpan` option is passed, the span inherits from the
 * currently-active span (same traceId, parentSpanId = active.spanId).
 * Otherwise a new root span (new traceId) is started.
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: SpanContext) => Promise<T>,
  opts: WithSpanOptions = {}
): Promise<T> {
  const active = opts.parentSpan ?? activeSpanStorage.getStore();
  const traceId = active ? active.traceId : generateTraceId();
  const spanId = generateSpanId();
  const parentSpanId = active ? active.spanId : null;

  const span = makeSpanContext(
    spanName,
    traceId,
    spanId,
    parentSpanId,
    opts.attributes ?? {}
  );

  try {
    const result = await activeSpanStorage.run(span, () => fn(span));
    finalizeSpan(span, "OK", undefined);
    return result;
  } catch (err) {
    span.recordException(err);
    finalizeSpan(span, "ERROR", err);
    throw err;
  }
}

/**
 * Synchronous variant of withSpan — useful for short in-process work
 * where the wrapped function doesn't await. Same semantics; same output.
 */
export function withSpanSync<T>(
  spanName: string,
  fn: (span: SpanContext) => T,
  opts: WithSpanOptions = {}
): T {
  const active = opts.parentSpan ?? activeSpanStorage.getStore();
  const traceId = active ? active.traceId : generateTraceId();
  const spanId = generateSpanId();
  const parentSpanId = active ? active.spanId : null;

  const span = makeSpanContext(
    spanName,
    traceId,
    spanId,
    parentSpanId,
    opts.attributes ?? {}
  );

  try {
    const result = activeSpanStorage.run(span, () => fn(span));
    finalizeSpan(span, "OK", undefined);
    return result;
  } catch (err) {
    span.recordException(err);
    finalizeSpan(span, "ERROR", err);
    throw err;
  }
}

function finalizeSpan(
  span: InternalSpanContext,
  status: "OK" | "ERROR",
  thrownErr: unknown
): void {
  const endPerf = performance.now();
  const durationMs = Math.max(0, endPerf - span.startedAtPerf);
  // Round duration to 2 decimals to keep logs compact while preserving
  // sub-millisecond precision where available.
  const roundedDuration = Math.round(durationMs * 100) / 100;

  const attributes = sanitizeAttributes(span._attributes as SpanAttributes);

  const envelope: SpanEnvelope = {
    timestamp: span.startedAtIso,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    status,
    durationMs: roundedDuration,
    attributes,
  };

  if (status === "ERROR" && thrownErr instanceof Error) {
    envelope.error = {
      type: thrownErr.name,
      message: thrownErr.message,
      ...(thrownErr.stack ? { stack: thrownErr.stack } : {}),
    };
  } else if (status === "ERROR" && thrownErr !== null && thrownErr !== undefined) {
    envelope.error = {
      type: typeof thrownErr,
      message: String(thrownErr),
    };
  }

  emitEnvelope(envelope);
}

// ============================================================
// Convenience: traceparent header (W3C) for outbound HTTP calls
// ============================================================

/**
 * Build a W3C `traceparent` header value for the active span (or the
 * passed span), formatted: `00-{traceId}-{spanId}-01` (trace flags =
 * sampled, since we always sample). Returns `undefined` when no span is
 * active, so callers can fall back cleanly:
 *
 *   fetch(url, { headers: { traceparent: getTraceParent() ?? "" }});
 */
export function getTraceParent(span?: SpanContext): string | undefined {
  const s = span ?? activeSpanStorage.getStore();
  if (!s) return undefined;
  return `00-${s.traceId}-${s.spanId}-01`;
}

/**
 * Parse an incoming `traceparent` header and return a minimal
 * SpanContext-like object suitable for passing as `opts.parentSpan`
 * to withSpan. Returns undefined for malformed headers, in which case
 * a new root trace is started.
 */
export function parseTraceParent(header: string | null | undefined):
  | Pick<SpanContext, "traceId" | "spanId">
  | undefined {
  if (!header) return undefined;
  // W3C traceparent: version-traceId-spanId-flags
  const parts = header.trim().split("-");
  if (parts.length < 4) return undefined;
  const [, traceId, spanId] = parts;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(spanId)) return undefined;
  // Disallow all-zero IDs per spec.
  if (/^0{32}$/.test(traceId) || /^0{16}$/.test(spanId)) return undefined;
  return { traceId, spanId };
}
