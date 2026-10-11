import { describe, expect, test } from "bun:test";

import worker from "../src/index";
import {
  ALLOWED_FIELDS,
  MAX_PAYLOAD_BYTES,
  InMemoryStatsStore,
  parseIngestPayload,
} from "../src/ingest";

const INGEST_URL = "https://collector.local/ingest";

/** POST through the real Worker route and hand back the injected store. */
const postIngest = async (
  body: unknown,
  init: { headers?: Record<string, string>; raw?: string } = {},
): Promise<{ response: Response; store: InMemoryStatsStore }> => {
  const store = new InMemoryStatsStore();
  const request = new Request(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
  const response = await worker.fetch(request, { STATS_STORE: store });
  return { response, store };
};

describe("POST /ingest — happy path", () => {
  test("accepts an allow-listed payload and returns the aggregate", async () => {
    const { response } = await postIngest({
      event: "install",
      version: "1.2.3",
      platform: "esp32",
      arch: "xtensa",
      install_id: "abc",
      channel: "stable",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      aggregate: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.aggregate).toMatchObject({
      total: 1,
      install: 1,
      heartbeat: 0,
      byVersion: { "1.2.3": 1 },
      byPlatform: { esp32: 1 },
      uniqueInstalls: 1,
    });
  });

  test("optional fields may be omitted", async () => {
    const { response } = await postIngest({ event: "heartbeat" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { aggregate: { byVersion: unknown } };
    expect(body.aggregate.byVersion).toEqual({});
  });
});

describe("POST /ingest — IP is never stored (FR-STA-01, NFR-SEC-09)", () => {
  test("rejects a payload carrying an `ip` field", async () => {
    const { response, store } = await postIngest({
      event: "install",
      version: "1.0.0",
      ip: "203.0.113.7",
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ip");

    // Nothing reached the store, so no IP can be persisted.
    expect(store.recorded()).toHaveLength(0);
    expect(store.aggregate().total).toBe(0);
  });

  test("rejects other IP-bearing field names too", async () => {
    for (const field of ["ip_address", "x-forwarded-for", "remote_addr", "client_ip"]) {
      const { response, store } = await postIngest({
        event: "heartbeat",
        [field]: "203.0.113.7",
      });
      expect(response.status).toBe(422);
      expect(store.recorded()).toHaveLength(0);
    }
  });

  test("IP headers on the request never leak into the stored aggregate", async () => {
    const { response, store } = await postIngest(
      { event: "install", version: "2.0.0" },
      {
        headers: {
          "CF-Connecting-IP": "198.51.100.9",
          "X-Forwarded-For": "198.51.100.9, 10.0.0.1",
          "X-Real-IP": "198.51.100.9",
        },
      },
    );

    expect(response.status).toBe(200);

    const serialized = JSON.stringify(store.recorded());
    expect(serialized).not.toContain("198.51.100.9");
    expect(serialized).not.toContain("10.0.0.1");
    expect(serialized).not.toContain("ip");

    const aggregate = JSON.stringify(store.aggregate());
    expect(aggregate).not.toContain("198.51.100.9");
    expect(aggregate).not.toContain("ip");
  });

  test("the accepted payload has exactly the allow-listed keys", () => {
    const parsed = parseIngestPayload(
      JSON.stringify({ event: "install", version: "1.0.0" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    for (const key of Object.keys(parsed.payload)) {
      expect(ALLOWED_FIELDS as readonly string[]).toContain(key);
    }
    expect(parsed.payload).not.toHaveProperty("ip");
  });
});

describe("POST /ingest — allow-list enforcement", () => {
  test("rejects unknown fields", async () => {
    const { response } = await postIngest({
      event: "install",
      version: "1.0.0",
      secret_token: "leak",
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("secret_token");
  });

  test("rejects non-object payloads and invalid JSON", async () => {
    const array = await postIngest([1, 2, 3]);
    expect(array.response.status).toBe(400);

    const badJson = await postIngest(null, { raw: "{not json" });
    expect(badJson.response.status).toBe(400);
  });

  test("rejects a bad event name and non-string fields", async () => {
    const badEvent = await postIngest({ event: "delete" });
    expect(badEvent.response.status).toBe(422);

    const numericVersion = await postIngest({ event: "install", version: 42 });
    expect(numericVersion.response.status).toBe(422);
  });
});

describe("POST /ingest — 4 KB cap", () => {
  test("accepts a payload just under the cap", async () => {
    const padding = "a".repeat(MAX_PAYLOAD_BYTES - 64);
    const raw = JSON.stringify({ event: "install", channel: padding });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );

    const { response } = await postIngest(null, { raw });
    expect(response.status).toBe(200);
  });

  test("rejects a payload over the cap with 413", async () => {
    const padding = "a".repeat(MAX_PAYLOAD_BYTES + 1);
    const raw = JSON.stringify({ event: "install", channel: padding });

    const { response, store } = await postIngest(null, { raw });
    expect(response.status).toBe(413);
    expect(store.recorded()).toHaveLength(0);
  });
});

describe("POST /ingest — aggregate correctness", () => {
  test("folds many events into the right totals", async () => {
    const store = new InMemoryStatsStore();
    const send = (body: unknown) =>
      worker.fetch(
        new Request(INGEST_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { STATS_STORE: store },
      );

    await send({ event: "install", version: "1.0.0", platform: "esp32", install_id: "a" });
    await send({ event: "heartbeat", version: "1.0.0", platform: "esp32", install_id: "a" });
    await send({ event: "install", version: "2.0.0", platform: "esp8266", install_id: "b" });
    await send({ event: "install", version: "1.0.0", platform: "esp32", install_id: "a" });

    expect(store.aggregate()).toEqual({
      total: 4,
      install: 3,
      heartbeat: 1,
      byVersion: { "1.0.0": 3, "2.0.0": 1 },
      byPlatform: { esp32: 3, esp8266: 1 },
      uniqueInstalls: 2,
    });
  });

  test("the returned aggregate snapshot is not a live reference", () => {
    const store = new InMemoryStatsStore();
    store.record({ event: "install", version: "1.0.0" });
    const snapshot = store.aggregate();
    store.record({ event: "heartbeat", version: "1.0.0" });

    expect(snapshot.total).toBe(1);
    expect(store.aggregate().total).toBe(2);
  });
});

describe("routing", () => {
  test("GET /ingest is not allowed", async () => {
    const response = await worker.fetch(new Request(INGEST_URL));
    expect(response.status).toBe(404);
  });
});
