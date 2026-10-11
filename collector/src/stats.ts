/**
 * Statistics read endpoint — `GET /stats` (FR-STA-02).
 *
 * Rules enforced here:
 *  - the route is gated by a **bearer token** ({@link STATS_TOKEN_ENV}): a
 *    request with no `Authorization` header, or with a credential that is not
 *    the configured token, is answered `401` and never reaches the store;
 *  - the token is never echoed back, and the response carries only
 *    IP-free aggregates derived from D04's {@link StatsStore};
 *  - the reported shape is: `total`, `active`, `byVersion`, `byDay` — the
 *    three aggregate dimensions FR-STA-02 names (total / per version / per
 *    day) plus the derived active-install count.
 *
 * This module is pure policy over an injected {@link StatsStore} seam; it
 * touches no runtime binding of its own, so it is pinned in-process by tests.
 */

import { type IngestPayload, type StatsStore } from "./ingest";

/** Name of the env binding/seam that carries the stats token. */
export const STATS_TOKEN_ENV = "STATS_TOKEN" as const;

/** Milliseconds in one UTC day; day buckets are keyed by `YYYY-MM-DD`. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long after its last heartbeat a distinct install still counts as
 * `active`. The SDK heartbeats well inside this window, so a healthy device is
 * always active while a device that stopped reporting falls out of the count.
 */
export const ACTIVE_WINDOW_MS = MS_PER_DAY;

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** The statistics document `GET /stats` returns on success. */
export type StatsReport = {
  total: number;
  /** Distinct install ids seen within {@link ACTIVE_WINDOW_MS}, on a fixed clock. */
  active: number;
  /** Event count per firmware version (mirrors D04's aggregate). */
  byVersion: Record<string, number>;
  /** Event count per UTC day, keyed `YYYY-MM-DD`, every day ever seen. */
  byDay: Record<string, number>;
};

/** `YYYY-MM-DD` for an instant, in UTC (deterministic across hosts). */
export const utcDay = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 10);

const increment = (buckets: Record<string, number>, key: string): void => {
  buckets[key] = (buckets[key] ?? 0) + 1;
};

/**
 * Fold raw payloads (with server timestamps) into a {@link StatsReport}.
 *
 * Pure and total: it never throws and never mutates its input. `byVersion`
 * reuses D04's {@link Aggregate} — the store's version totals and the journal's
 * are the same number by construction. `byDay` and `active` additionally need
 * time, which is read from `payload.ts` (the server stamp D04 attaches) and
 * finally anchored to `now` for payloads that carry no stamp.
 */
export function summarize(
  recorded: readonly IngestPayload[],
  now: number = Date.now(),
): StatsReport {
  const byDay: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  let total = 0;
  let active = 0;

  /** Last-seen instant per distinct install id (latest stamp wins). */
  const lastSeen = new Map<string, number>();

  for (const payload of recorded) {
    const t = typeof payload.ts === "number" ? payload.ts : now;
    total += 1;
    increment(byDay, utcDay(t));
    if (payload.version) increment(byVersion, payload.version);

    if (payload.install_id) {
      const prev = lastSeen.get(payload.install_id);
      if (prev === undefined || t > prev) lastSeen.set(payload.install_id, t);
    }
  }

  for (const seen of lastSeen.values()) {
    if (now - seen <= ACTIVE_WINDOW_MS) active += 1;
  }

  return { total, active, byVersion, byDay };
}

/** Build the report from the store's aggregate plus its recording journal. */
export function buildReport(store: StatsStore, now: number = Date.now()): StatsReport {
  const aggregate = store.aggregate();
  const summary = summarize(store.recorded(), now);
  return {
    total: aggregate.total,
    active: summary.active,
    byVersion: aggregate.byVersion,
    byDay: summary.byDay,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Stable, machine-readable reasons a stats request was denied. */
export type AuthFailure = "missing_token" | "invalid_token";

/** Outcome of {@link checkStatsAuth}: a token to serve, or a denial reason. */
export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401; code: AuthFailure; message: string };

/**
 * Extract the bearer credential from `Authorization: Bearer <token>` using the
 * SHARED strict grammar (case-insensitive scheme, exactly one credential token,
 * no whitespace inside it). Anything else — including a bare token in place of
 * the scheme — is `null`, so the caller fails closed.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Constant-time string equality (length first, then an accumulating XOR), so a
 * wrong token cannot be distinguished from a right one by timing.
 *
 * In-memory {@link InMemoryStatsStore} tests run on the same thread, so this is
 * a hardening measure rather than a defence against a network observer; it is
 * deliberately not coupled to any runtime's crypto API.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Gate a request against the configured `STATS_TOKEN`.
 *
 * Absent token header → `401 missing_token`. A present-but-wrong credential
 * (bad scheme, or a string that is not the configured token) → `401
 * invalid_token`. When the binding itself is unset the route is
 * **fail-closed**: nobody can read stats, rather than everybody.
 */
export function checkStatsAuth(request: Request, expected: string | undefined): AuthResult {
  const presented = readBearerToken(request);
  if (presented === null) {
    return {
      ok: false,
      status: 401,
      code: "missing_token",
      message: "missing bearer token",
    };
  }

  if (typeof expected !== "string" || expected.length === 0) {
    // Unconfigured binding: refuse to serve (never "allow all").
    return {
      ok: false,
      status: 401,
      code: "invalid_token",
      message: "statistics endpoint is not configured",
    };
  }

  if (!timingSafeEqual(presented, expected)) {
    return { ok: false, status: 401, code: "invalid_token", message: "invalid token" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

type StatsErrorBody = { ok: false; error: string; code: AuthFailure };

/**
 * Handle `GET /stats`. Reads D04's store through the injected seam; the store's
 * aggregate supplies the totals and per-version counts, and the recording
 * journal supplies the per-day buckets and the active-install count.
 *
 * Every failure path is a `401` with `WWW-Authenticate: Bearer`; the token is
 * never reflected in the response.
 */
export function handleStats(
  request: Request,
  store: StatsStore,
  expected: string | undefined,
  now: number = Date.now(),
): Response {
  const auth = checkStatsAuth(request, expected);
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: auth.message, code: auth.code } satisfies StatsErrorBody,
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  }

  return Response.json({ ok: true, stats: buildReport(store, now) });
}
