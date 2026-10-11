/**
 * Anonymous statistics ingest (FR-STA-01, NFR-SEC-09).
 *
 * Rules enforced here:
 *  - the payload MUST be an object whose keys are all in {@link ALLOWED_FIELDS};
 *    any extra field (including `ip`, `ip_address`, `x-forwarded-for`, ...) is
 *    rejected, so an IP can never reach the store;
 *  - the serialized payload is capped at {@link MAX_PAYLOAD_BYTES} (4 KB);
 *  - the request IP — however it is supplied (socket, `CF-Connecting-IP`,
 *    `X-Forwarded-For`, `Forwarded`) — is read solely to be DISCARDED and never
 *    copied into the stored aggregate.
 */

/** Fields we accept (allow-list). Anything not listed here is rejected. */
export const ALLOWED_FIELDS = [
  "event",
  "version",
  "platform",
  "arch",
  "install_id",
  "channel",
] as const;

export type AllowedField = (typeof ALLOWED_FIELDS)[number];

/** Static membership lookup for the allow-list (small, string-keyed table). */
const ALLOWED_FIELD_SET: Record<string, true> = Object.fromEntries(
  ALLOWED_FIELDS.map((field) => [field, true]),
);

/** Maximum accepted payload size, in bytes (4 KB). */
export const MAX_PAYLOAD_BYTES = 4 * 1024;

export type IngestEvent = "install" | "heartbeat";

/** A payload that passed the allow-list. Carries no IP, by construction. */
export type IngestPayload = {
  event: IngestEvent;
  version?: string;
  platform?: string;
  arch?: string;
  install_id?: string;
  channel?: string;
  /**
   * Server-side receipt time, in epoch milliseconds. NOT client-supplied: the
   * allow-list excludes any `ts` key on the wire, and the store stamps it on
   * `record` (so day buckets are anchored to server time, never a device
   * clock). Optional in the type so pure parse tests can build a bare payload.
   */
  ts?: number;
};

/** Aggregate totals kept by the store. Carries no IP, by construction. */
export type Aggregate = {
  total: number;
  install: number;
  heartbeat: number;
  byVersion: Record<string, number>;
  byPlatform: Record<string, number>;
  /** Distinct anonymous install ids seen (no IP, no device token). */
  uniqueInstalls: number;
};

export const emptyAggregate = (): Aggregate => ({
  total: 0,
  install: 0,
  heartbeat: 0,
  byVersion: {},
  byPlatform: {},
  uniqueInstalls: 0,
});

/**
 * Injected in-memory seam. Concrete storage (DO / KV / D1) can be swapped in
 * later without touching the route logic. The seam only ever receives
 * allow-listed, IP-free data.
 */
export interface StatsStore {
  /** Fold one accepted event into the anonymous aggregate. */
  record(payload: IngestPayload): void;
  /** Snapshot of the current aggregate (a copy, safe to mutate). */
  aggregate(): Aggregate;
  /** Every payload ever recorded, for tests/audit. Never contains an IP. */
  recorded(): readonly IngestPayload[];
}

const cloneAggregate = (agg: Aggregate): Aggregate => ({
  total: agg.total,
  install: agg.install,
  heartbeat: agg.heartbeat,
  byVersion: { ...agg.byVersion },
  byPlatform: { ...agg.byPlatform },
  uniqueInstalls: agg.uniqueInstalls,
});

/** In-memory {@link StatsStore} implementation. */
export class InMemoryStatsStore implements StatsStore {
  #agg: Aggregate = emptyAggregate();
  #seen = new Set<string>();
  #recorded: IngestPayload[] = [];
  readonly #now: () => number;

  /**
   * `now` is an injected clock (defaults to `Date.now`) so callers and tests
   * can pin the server-side receipt time stamped on each recorded payload —
   * the source of `GET /stats`' per-day/active aggregates — without waiting.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(payload: IngestPayload): void {
    this.#agg.total += 1;
    this.#agg.install += payload.event === "install" ? 1 : 0;
    this.#agg.heartbeat += payload.event === "heartbeat" ? 1 : 0;

    if (payload.version) {
      this.#agg.byVersion[payload.version] =
        (this.#agg.byVersion[payload.version] ?? 0) + 1;
    }
    if (payload.platform) {
      this.#agg.byPlatform[payload.platform] =
        (this.#agg.byPlatform[payload.platform] ?? 0) + 1;
    }
    if (payload.install_id && !this.#seen.has(payload.install_id)) {
      this.#seen.add(payload.install_id);
      this.#agg.uniqueInstalls = this.#seen.size;
    }

    // Store a fresh copy so callers can never smuggle extra keys in. `ts` is
    // stamped HERE (server clock), overwriting anything a caller passed — a
    // payload's day bucket can never be chosen by the device.
    this.#recorded.push({ ...payload, ts: this.#now() });
  }

  aggregate(): Aggregate {
    return cloneAggregate(this.#agg);
  }

  recorded(): readonly IngestPayload[] {
    return this.#recorded;
  }
}

export type ParseResult =
  | { ok: true; payload: IngestPayload }
  | { ok: false; status: number; error: string };

/** JSON `undefined` friendly string check used by the validator. */
const isNullableString = (value: unknown): value is string | undefined | null =>
  value === undefined || value === null || typeof value === "string";

/**
 * Parse and validate a raw request body into an IP-free {@link IngestPayload}.
 * Pure and total: it never throws and never mutates its input.
 */
export function parseIngestPayload(raw: string): ParseResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "payload must be a JSON object" };
  }

  const input = parsed as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !ALLOWED_FIELD_SET[key]);
  if (extra.length > 0) {
    // Covers `ip`, `ip_address`, `x-forwarded-for`, unknown fields, ...
    return {
      ok: false,
      status: 422,
      error: `field(s) outside allow-list: ${extra.join(", ")}`,
    };
  }

  for (const key of ALLOWED_FIELDS) {
    if (!isNullableString(input[key])) {
      return { ok: false, status: 422, error: `field "${key}" must be a string` };
    }
  }

  const event = input["event"];
  if (event !== "install" && event !== "heartbeat") {
    return {
      ok: false,
      status: 422,
      error: 'field "event" must be "install" or "heartbeat"',
    };
  }

  const stringField = (key: AllowedField): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  // Build an explicit, allow-listed payload — no spread, so an IP field can
  // never survive even if validation were bypassed.
  return {
    ok: true,
    payload: {
      event,
      version: stringField("version"),
      platform: stringField("platform"),
      arch: stringField("arch"),
      install_id: stringField("install_id"),
      channel: stringField("channel"),
    },
  };
}

type IngestResponseBody =
  | { ok: true; aggregate: Aggregate }
  | { ok: false; error: string };

/**
 * Handle `POST /ingest`. The request's client IP is deliberately dropped: it is
 * only ever read to prove the point in tests, never passed to the store.
 */
export async function handleIngest(
  request: Request,
  store: StatsStore,
): Promise<Response> {
  void readClientIp(request); // read-only; intentionally discarded.

  const raw = await request.text();
  const parsed = parseIngestPayload(raw);

  if (!parsed.ok) {
    return Response.json(
      { ok: false, error: parsed.error } satisfies IngestResponseBody,
      { status: parsed.status },
    );
  }

  store.record(parsed.payload);
  return Response.json({
    ok: true,
    aggregate: store.aggregate(),
  } satisfies IngestResponseBody);
}

/** Best-effort extraction of the caller's IP — used only to be discarded. */
export function readClientIp(request: Request): string | undefined {
  const headers = request.headers;
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}
