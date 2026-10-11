/**
 * `GET /stats` — bearer-gated statistics endpoint (FR-STA-02, D05).
 *
 * These tests drive the REAL worker route (`worker.fetch`) with a real
 * {@link InMemoryStatsStore} seeded through the real `POST /ingest` route, so
 * auth and aggregation are pinned end-to-end rather than against a stub.
 */

import { describe, expect, test } from "bun:test";

import worker from "../src/index";
import { InMemoryStatsStore } from "../src/ingest";
import {
  ACTIVE_WINDOW_MS,
  checkStatsAuth,
  handleStats,
  readBearerToken,
  summarize,
  utcDay,
  type StatsReport,
} from "../src/stats";

const INGEST_URL = "https://collector.local/ingest";
const STATS_URL = "https://collector.local/stats";

const TOKEN = "stats-token-9f2c";

const DAY_MS = 86_400_000;
/** A fixed Wednesday, so the expected `YYYY-MM-DD` keys are literals. */
const T0 = Date.UTC(2026, 6, 1, 10, 0, 0); // 2026-07-01T10:00:00Z

/**
 * A worker harness with a pinned clock: both the store (which stamps `ts`) and
 * the route (which reads `now` for active/day bucketing) share one advancing
 * counter, so a test can move days with a single assignment.
 *
 * `token` defaults to {@link TOKEN}; pass `null` to model an UNSET binding
 * (the `STATS_TOKEN` env key is omitted entirely, which is distinct from an
 * empty-string binding).
 */
const harness = (token: string | null = TOKEN) => {
  let clock = T0;
  const store = new InMemoryStatsStore(() => clock);
  const now = () => clock;

  const env: { STATS_STORE: InMemoryStatsStore; STATS_TOKEN?: string } = {
    STATS_STORE: store,
  };
  if (token !== null) env.STATS_TOKEN = token;

  const ingest = (body: unknown): Promise<Response> =>
    worker.fetch(
      new Request(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { STATS_STORE: store },
      undefined,
      { now },
    );

  const stats = (init: { authorization?: string } = {}): Promise<Response> =>
    worker.fetch(
      new Request(STATS_URL, {
        headers:
          init.authorization === undefined
            ? {}
            : { authorization: init.authorization },
      }),
      env,
      undefined,
      { now },
    );

  return {
    store,
    ingest,
    stats,
    /** Advance the shared clock by `ms` and return the new instant. */
    advance: (ms: number): number => {
      clock += ms;
      return clock;
    },
    at: (): number => clock,
  };
};

const readStats = async (response: Response): Promise<StatsReport> => {
  const body = (await response.json()) as { ok: boolean; stats: StatsReport };
  expect(body.ok).toBe(true);
  return body.stats;
};

// ---------------------------------------------------------------------------

describe("GET /stats — bearer auth (FR-STA-02)", () => {
  test("no Authorization header → 401", async () => {
    const h = harness();
    const response = await h.stats();

    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("missing_token");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("wrong token → 401", async () => {
    const h = harness();
    const response = await h.stats({ authorization: "Bearer not-the-token" });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("invalid_token");
  });

  test("a malformed bearer scheme is a 401, not a pass", async () => {
    const h = harness();
    // Bare token, wrong scheme, empty credential, trailing junk.
    for (const header of [TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer ", `Bearer ${TOKEN} extra`]) {
      const response = await h.stats({ authorization: header });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("missing_token");
    }
  });

  test("a token-equal-but-differently-cased credential is accepted (scheme case-insensitive)", async () => {
    const h = harness();
    const response = await h.stats({ authorization: `bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });

  test("correct token → 200", async () => {
    const h = harness();
    const response = await h.stats({ authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });

  test("unset STATS_TOKEN binding is fail-closed (401 even with a token)", async () => {
    const h = harness(null);
    const response = await h.stats({ authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("invalid_token");
  });

  test("an empty STATS_TOKEN binding is fail-closed (never 'allow all')", async () => {
    const h = harness("");
    const response = await h.stats({ authorization: "Bearer " });
    expect(response.status).toBe(401);
  });

  test("the configured token is never reflected in the response body", async () => {
    const h = harness();
    const response = await h.stats({ authorization: `Bearer ${TOKEN}` });
    expect(await response.text()).not.toContain(TOKEN);
  });

  test("auth failures never consult the store (deny before read)", () => {
    // A store whose every access throws: a denial must still return 401.
    const explosive: Parameters<typeof handleStats>[1] = {
      record() {},
      aggregate() {
        throw new Error("store must not be read on a denied request");
      },
      recorded() {
        throw new Error("store must not be read on a denied request");
      },
    };

    const denied = handleStats(
      new Request(STATS_URL),
      explosive,
      TOKEN,
      T0,
    );
    expect(denied.status).toBe(401);

    const wrong = handleStats(
      new Request(STATS_URL, { headers: { authorization: "Bearer nope" } }),
      explosive,
      TOKEN,
      T0,
    );
    expect(wrong.status).toBe(401);
  });

  test("checkStatsAuth classifies missing vs invalid without a Request body", () => {
    expect(checkStatsAuth(new Request(STATS_URL), TOKEN)).toMatchObject({
      ok: false,
      code: "missing_token",
      status: 401,
    });
    expect(
      checkStatsAuth(
        new Request(STATS_URL, { headers: { authorization: "Bearer bad" } }),
        TOKEN,
      ),
    ).toMatchObject({ ok: false, code: "invalid_token", status: 401 });
    expect(
      checkStatsAuth(
        new Request(STATS_URL, { headers: { authorization: `Bearer ${TOKEN}` } }),
        TOKEN,
      ),
    ).toEqual({ ok: true });
  });
});

describe("readBearerToken — shared strict grammar", () => {
  test("extracts exactly the credential, or null", () => {
    const withHeader = (value?: string): Request =>
      new Request(
        STATS_URL,
        value === undefined ? {} : { headers: { authorization: value } },
      );

    expect(readBearerToken(withHeader())).toBeNull();
    expect(readBearerToken(withHeader(`Bearer ${TOKEN}`))).toBe(TOKEN);
    expect(readBearerToken(withHeader(`bearer\t${TOKEN}`))).toBe(TOKEN);
    expect(readBearerToken(withHeader(TOKEN))).toBeNull();
    expect(readBearerToken(withHeader("Bearer a b"))).toBeNull();
    expect(readBearerToken(withHeader("Bearer"))).toBeNull();
  });
});

describe("GET /stats — per-version & per-day aggregates (seeded via D04)", () => {
  test("folds seeded ingest into correct totals, versions, and days", async () => {
    const h = harness();
    const { advance } = h;

    // Day 1 (2026-07-01): two events for install "a" on version 1.0.0.
    await h.ingest({ event: "install", version: "1.0.0", install_id: "a" });
    advance(2 * 3600_000);
    await h.ingest({ event: "heartbeat", version: "1.0.0", install_id: "a" });

    // Day 2 (2026-07-02): one event for a new install on version 2.0.0.
    advance(DAY_MS);
    await h.ingest({ event: "install", version: "2.0.0", install_id: "b" });

    // Day 3 (2026-07-03): back to 1.0.0 with the first install again.
    advance(DAY_MS);
    await h.ingest({ event: "heartbeat", version: "1.0.0", install_id: "a" });

    const stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));

    expect(stats.total).toBe(4);
    expect(stats.byVersion).toEqual({ "1.0.0": 3, "2.0.0": 1 });
    expect(stats.byDay).toEqual({
      "2026-07-01": 2,
      "2026-07-02": 1,
      "2026-07-03": 1,
    });
    // Both installs were last seen on day 3 — inside the active window.
    expect(stats.active).toBe(2);
  });

  test("version totals match D04's own aggregate exactly", async () => {
    const h = harness();
    await h.ingest({ event: "install", version: "1.0.0" });
    await h.ingest({ event: "heartbeat", version: "1.0.0" });
    await h.ingest({ event: "install", version: "3.4.5" });

    const stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));
    expect(stats.byVersion).toEqual(h.store.aggregate().byVersion);
    expect(stats.total).toBe(h.store.aggregate().total);
  });

  test("an install that stops reporting falls out of `active` after the window", async () => {
    const h = harness();
    await h.ingest({ event: "install", version: "1.0.0", install_id: "gone" });

    // Just inside the window.
    h.advance(ACTIVE_WINDOW_MS - 1);
    let stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));
    expect(stats.active).toBe(1);

    // Just past it.
    h.advance(2);
    stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));
    expect(stats.active).toBe(0);
    // The event itself is still counted forever.
    expect(stats.total).toBe(1);
    expect(stats.byDay).toEqual({ "2026-07-01": 1 });
  });

  test("`active` counts distinct installs, not events", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await h.ingest({ event: "heartbeat", version: "1.0.0", install_id: "one" });
      h.advance(60_000);
    }

    const stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));
    expect(stats.total).toBe(5);
    expect(stats.active).toBe(1);
  });

  test("freshly-booted store reports zeros and empty buckets", async () => {
    const h = harness();
    const stats = await readStats(await h.stats({ authorization: `Bearer ${TOKEN}` }));

    expect(stats).toEqual({ total: 0, active: 0, byVersion: {}, byDay: {} });
  });

  test("byDay buckets by UTC, not local time", () => {
    // 2026-07-01T23:30:00Z — a late-day UTC instant that is already the next
    // day in any positive-offset local zone, so a local-time bucket would differ.
    const lateUtc = Date.UTC(2026, 6, 1, 23, 30, 0);
    const store = new InMemoryStatsStore(() => lateUtc);
    store.record({ event: "install", version: "1.0.0" });

    expect(store.recorded()[0]?.ts).toBe(lateUtc);
    expect(summarize(store.recorded(), lateUtc).byDay).toEqual({
      "2026-07-01": 1,
    });
    expect(utcDay(lateUtc)).toBe("2026-07-01");
  });
});

describe("summarize — pure aggregation", () => {
  test("stamps are optional in the fold and anchor to `now`", () => {
    const report = summarize(
      [{ event: "install", version: "1.0.0" }, { event: "heartbeat", version: "1.0.0" }],
      T0,
    );
    expect(report.total).toBe(2);
    expect(report.byDay).toEqual({ "2026-07-01": 2 });
    expect(report.byVersion).toEqual({ "1.0.0": 2 });
  });

  test("does not mutate its input", () => {
    const input = [{ event: "install" as const, ts: T0 }];
    const copy = structuredClone(input);
    summarize(input, T0);
    expect(input).toEqual(copy);
  });

  test("last heartbeat wins when an install reports on several days", () => {
    const report = summarize(
      [
        { event: "install", ts: T0, install_id: "a" },
        { event: "heartbeat", ts: T0 + 10 * DAY_MS, install_id: "a" },
      ],
      T0 + 11 * DAY_MS,
    );
    // Last seen one day before `now` → inside the window.
    expect(report.active).toBe(1);
  });
});

describe("routing", () => {
  test("POST /stats is not allowed", async () => {
    const response = await worker.fetch(
      new Request(STATS_URL, { method: "POST" }),
      { STATS_TOKEN: TOKEN },
    );
    expect(response.status).toBe(404);
  });

  test("GET /stats does not collide with GET /", async () => {
    const root = await worker.fetch(new Request("https://collector.local/"));
    expect(root.status).toBe(200);
    const body = (await root.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
