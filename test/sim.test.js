/**
 * Offline tests for the `iot-sim` device simulator (ticket D01).
 *
 * Every test in this file runs in-process with no network and no server:
 *
 *   - the HTTP seam is a hand-written fake `fetchImpl` that records what it was
 *     given and replays a canned response;
 *   - the WS seam is a hand-written fake `wsFactory` returning a recording
 *     socket object.
 *
 * The assertions target the *observable contract* — URL, method, headers, body,
 * how statuses are classified, and how readings are derived from a seed — not
 * private internals, so a refactor that keeps the wire contract stays green.
 */

import { describe, expect, test } from "bun:test";

import {
  CONTROL_WS_PATH,
  DEFAULT_DEVICE_KEY,
  DEVICE_HEADER,
  MAX_DEVICE_KEY_LENGTH,
  TELEMETRY_PATH,
  buildPublishRequest,
  classifyStatus,
  createSimulator,
  joinUrl,
  toWebSocketUrl,
  validatePublishRequest,
} from "../src/iot-sim/index.js";
import {
  createGpsSensor,
  createRng,
  createSensors,
  createStatusSensor,
  createTemperatureSensor,
  readings,
} from "../src/iot-sim/sensors.js";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const BASE_URL = "http://collector.local";
const TOKEN = "pt_valid_token";
const DEVICE = "sim-test-01";

/** A Response-compatible stand-in: enough for `status`/`headers`/`json()`. */
function fakeResponse(status, body = null, headers = {}) {
  return {
    status,
    headers,
    json: async () => body,
    text: async () => (body === null ? "" : JSON.stringify(body)),
  };
}

/**
 * Record every request an injected fetch receives, and reply with a scripted
 * response. Never performs I/O.
 */
function makeFetchSpy(reply = () => fakeResponse(204)) {
  const calls = [];
  // Two declared parameters (no defaults, which would reduce `Function.length`):
  // this is the `(url, init)` shape the simulator recognises as a real fetch.
  const spy = async (url, init) => {
    const options = init ?? {};
    calls.push({
      url: typeof url === "string" ? url : url?.url,
      method: options.method,
      headers: options.headers ?? {},
      body: options.body,
    });
    return reply(url, options);
  };
  spy.calls = calls;
  return spy;
}

/**
 * A minimal WebSocket-like recorder. `handler` decides the URL that connects;
 * every other call is captured so the test can replay server frames.
 */
function makeWsRecorder(onOpen) {
  const instances = [];
  const factory = (...urls) => {
    const socket = {
      urls,
      url: urls[0],
      readyState: 1,
      sent: [],
      listeners: new Map(),
      send(data) {
        this.sent.push(data);
      },
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      },
      /** Test-side helper: drive a `message` event into the simulator. */
      emitMessage(data) {
        const message = { data };
        for (const listener of this.listeners.get("message") ?? []) listener(message);
      },
      /** Test-side helper: drive an `open` event into the simulator. */
      emitOpen() {
        for (const listener of this.listeners.get("open") ?? []) listener({});
      },
    };
    instances.push(socket);
    onOpen?.(socket);
    return socket;
  };
  factory.instances = instances;
  return factory;
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("url helpers", () => {
  test("joinUrl trims a trailing slash without doubling the path one", () => {
    expect(joinUrl("http://host", TELEMETRY_PATH)).toBe("http://host/v1/telemetry");
    expect(joinUrl("http://host/", TELEMETRY_PATH)).toBe("http://host/v1/telemetry");
    expect(joinUrl("http://host/api/", "v1/telemetry")).toBe("http://host/api/v1/telemetry");
  });

  test("toWebSocketUrl maps http→ws and https→wss", () => {
    expect(toWebSocketUrl("http://host/v1/control/ws")).toBe("ws://host/v1/control/ws");
    expect(toWebSocketUrl("https://host/v1/control/ws")).toBe("wss://host/v1/control/ws");
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe("sensors — determinism", () => {
  test("same seed produces an identical sequence", () => {
    const first = readings(8, { seed: 42 });
    const second = readings(8, { seed: 42 });

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  test("a different seed produces a different sequence", () => {
    const seeded = readings(8, { seed: 42 });
    const other = readings(8, { seed: 7 });

    expect(seeded).not.toEqual(other);
  });

  test("generators built from one seed walk in lockstep", () => {
    const a = createSensors({ seed: 1234 });
    const b = createSensors({ seed: 1234 });

    expect(a(5)).toEqual(b(5));
    expect(a.rng.count).toBe(b.rng.count);
    expect(a.rng.count).toBeGreaterThan(0);
  });

  test("the walk starts on trend and never leaves its bounds", () => {
    const readingsOut = readings(500, { seed: 3 });
    const temps = readingsOut.map((reading) => reading.metrics.temp);

    // The first value is drawn from the seeded stream, so it sits within one
    // step of the initial value rather than exactly on it.
    expect(Math.abs(temps[0] - 25)).toBeLessThanOrEqual(0.15);
    expect(Math.min(...temps)).toBeGreaterThanOrEqual(15);
    expect(Math.max(...temps)).toBeLessThanOrEqual(35);
    expect(new Set(temps).size).toBeGreaterThan(1); // it actually moves
  });

  test("re-centring the mean moves where the walk settles", () => {
    const warm = readings(200, { seed: 5, sensors: { temperature: { mean: 30 } } });
    const cold = readings(200, { seed: 5, sensors: { temperature: { mean: 20 } } });
    const settle = (batch) => batch.slice(100).reduce((sum, r) => sum + r.metrics.temp, 0) / 100;

    expect(settle(warm)).toBeGreaterThan(settle(cold) + 5);
  });

  test("createRng is reproducible and coerces awkward seeds to uint32", () => {
    const first = createRng(-1);
    const second = createRng(-1);
    const draws = [first(), first(), first()];

    expect(draws).toEqual([second(), second(), second()]);
    expect(createRng(4294967297).seed).toBe(createRng(1).seed);
    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Reading shapes                                                             */
/* -------------------------------------------------------------------------- */

describe("sensors — reading shapes", () => {
  test("a reading carries temp, ok and a GPS pair", () => {
    const batch = readings(6, { seed: 9 });

    for (const { metrics } of batch) {
      expect(typeof metrics.temp).toBe("number");
      expect(Number.isFinite(metrics.temp)).toBe(true);
      expect(typeof metrics.ok).toBe("boolean");
      expect(typeof metrics.lat).toBe("number");
      expect(typeof metrics.lon).toBe("number");
      expect(Math.abs(metrics.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(metrics.lon)).toBeLessThanOrEqual(180);
    }
  });

  test("the metrics object is JSON-safe: no NaN, Infinity or undefined", () => {
    const serialised = JSON.stringify(readings(300, { seed: 11 }));

    expect(serialised).not.toContain("NaN");
    expect(serialised).not.toContain("Infinity");
    expect(serialised).not.toContain("undefined");
  });

  test("status reports both states across a long run", () => {
    const seen = new Set(readings(200, { seed: 2 }).map((r) => r.metrics.ok));

    expect(seen).toEqual(new Set([true, false]));
  });

  test("the temperature sensor is mean-reverting rather than drifting away", () => {
    const sensor = createTemperatureSensor({ mean: 25 });
    const rng = createRng(17);
    const values = Array.from({ length: 400 }, () => sensor.read(rng));
    const tail = values.slice(-100);
    const tailMean = tail.reduce((sum, value) => sum + value, 0) / tail.length;

    expect(Math.abs(tailMean - 25)).toBeLessThan(1);
  });

  test("the status sensor holds each state for its configured run length", () => {
    const sensor = createStatusSensor({ initial: true, healthyRun: 3, downRun: 2 });
    const rng = createRng(1);

    expect([sensor.read(rng), sensor.read(rng), sensor.read(rng)]).toEqual([true, true, true]);
    expect([sensor.read(rng), sensor.read(rng)]).toEqual([false, false]);
    expect(sensor.read(rng)).toBe(true);
  });

  test("the GPS sensor stays near its anchor over a long walk", () => {
    const sensor = createGpsSensor({ lat: -6.2, lon: 106.8, stepMeters: 20 });
    const rng = createRng(21);
    let maxLatDelta = 0;

    for (let i = 0; i < 300; i += 1) {
      const { lat } = sensor.read(rng);
      maxLatDelta = Math.max(maxLatDelta, Math.abs(lat + 6.2));
    }
    // 20 m per step with reversion must never wander kilometres away.
    expect(maxLatDelta).toBeLessThan(0.02);
  });

  test("the batch API rejects a negative or fractional count", () => {
    const sensors = createSensors({ seed: 1 });

    expect(() => sensors(-1)).toThrow(TypeError);
    expect(() => sensors(1.5)).toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

describe("validatePublishRequest — pre-flight boundaries", () => {
  test("accepts a non-empty batch with a key exactly at the length limit", () => {
    expect(validatePublishRequest([{ metrics: { temp: 1 } }], "d".repeat(MAX_DEVICE_KEY_LENGTH))).toEqual({ ok: true });
  });

  test("rejects an empty batch and a blank or over-long device key", () => {
    expect(validatePublishRequest([], DEVICE)).toMatchObject({ ok: false, error: { code: "empty_batch" } });
    expect(validatePublishRequest([{ metrics: {} }], "   ")).toMatchObject({ ok: false, error: { code: "missing_device_key" } });
    expect(validatePublishRequest([{ metrics: {} }], "d".repeat(MAX_DEVICE_KEY_LENGTH + 1))).toMatchObject({ ok: false, error: { code: "invalid_device_key" } });
  });
});

describe("buildPublishRequest", () => {
  test("targets POST /v1/telemetry with bearer + device headers", () => {
    const request = buildPublishRequest({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      readings: [{ metrics: { temp: 25.4 } }],
    });

    expect(request.url).toBe("http://collector.local/v1/telemetry");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers[DEVICE_HEADER]).toBe(DEVICE);
    expect(JSON.parse(request.body)).toEqual({ metrics: { temp: 25.4 } });
  });

  test("a batch is merged into a single flat metrics object", () => {
    const request = buildPublishRequest({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      readings: [{ metrics: { temp: 25 } }, { metrics: { temp: 26, ok: true } }],
    });

    expect(JSON.parse(request.body).metrics).toEqual({ temp: 26, ok: true });
  });

  test("raw mode encodes the metrics map verbatim for contract checks", () => {
    const metrics = { temp: 25, ok: true, note: "x" };
    const request = buildPublishRequest({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, readings: metrics, raw: true });

    // Byte-for-byte the spec's form-A body (spec §6.1).
    expect(request.body).toBe('{"metrics":{"temp":25,"ok":true,"note":"x"}}');
  });

  test("merged mode collapses a batch to the newest value per metric key", () => {
    const batch = readings(5, { seed: 42 });
    const request = buildPublishRequest({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, readings: batch });
    const keys = Object.keys(JSON.parse(request.body).metrics);

    // temp + ok + lat + lon + duty for the five enabled components.
    expect(keys.sort()).toEqual(["duty", "lat", "lon", "ok", "temp"]);
  });
});

/* -------------------------------------------------------------------------- */
/* publishOnce — the HTTP uplink                                              */
/* -------------------------------------------------------------------------- */

describe("publishOnce — uplink", () => {
  test("sends the correct URL, method, headers and body", async () => {
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, seed: 42, fetchImpl });

    const result = await sim.publishOnce();

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe("http://collector.local/v1/telemetry");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers[DEVICE_HEADER]).toBe(DEVICE);
    expect(call.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(call.body);
    expect(body).toHaveProperty("metrics");
    expect(typeof body.metrics.temp).toBe("number");
    expect(result.ok).toBe(true);
  });

  test("an explicit batch controls the exact body transmitted", async () => {
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl });

    await sim.publishOnce([{ metrics: { temp: 25.4 } }]);

    expect(JSON.parse(fetchImpl.calls[0].body)).toEqual({ metrics: { temp: 25.4 } });
  });

  test("204 No Content is treated as success", async () => {
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl: makeFetchSpy(() => fakeResponse(204, null)) });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.kind).toBe("ok");
    expect(result.body).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("200 with a JSON body is also success", async () => {
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl: makeFetchSpy(() => fakeResponse(200, { stored: 1 })) });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ stored: 1 });
  });

  test("validates the device header against the server's field limits", async () => {
    const tooLong = "d".repeat(65); // one past MAX_DEVICE_KEY_LENGTH (64)
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: tooLong, fetchImpl });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, kind: "fatal", error: { code: "invalid_device_key" } });
  });

  test("an empty batch is rejected before any request is made", async () => {
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl });

    const result = await sim.publishOnce([]);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("empty_batch");
  });
});

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

describe("publishOnce — error handling", () => {
  test("401 is a fatal error carrying the server's code", async () => {
    const spy = makeFetchSpy(() => fakeResponse(401, { error: "unauthorized" }));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: "nope", deviceKey: DEVICE, fetchImpl: spy });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.kind).toBe("fatal");
    expect(result.error.code).toBe("unauthorized");
  });

  test("400 invalid_value surfaces the error code", async () => {
    const sim = createSimulator({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      fetchImpl: makeFetchSpy(() => fakeResponse(400, { error: "invalid_value", message: "NaN rejected" })),
    });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(result.kind).toBe("fatal");
    expect(result.error).toMatchObject({ code: "invalid_value", message: "NaN rejected" });
  });

  test("429 and 5xx are retryable", async () => {
    const retryable = [429, 500, 503];
    for (const status of retryable) {
      const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl: makeFetchSpy(() => fakeResponse(status, null, { "retry-after": "2" })) });

      const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

      expect(result.ok).toBe(false);
      expect(result.kind).toBe("retry");
    }
  });

  test("a transport failure is a retryable network_error, not a throw", async () => {
    const sim = createSimulator({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const result = await sim.publishOnce([{ metrics: { temp: 26 } }]);

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("retry");
    expect(result.status).toBe(0);
    expect(result.error.code).toBe("network_error");
  });

  test("classifyStatus buckets 2xx as ok, 5xx and 429 as retry, other 4xx as fatal", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(204)).toBe("ok");
    expect(classifyStatus(401)).toBe("fatal");
    expect(classifyStatus(413)).toBe("fatal");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(500)).toBe("retry");
  });
});

/* -------------------------------------------------------------------------- */
/* WS control channel                                                         */
/* -------------------------------------------------------------------------- */

describe("control channel — injected WS factory", () => {
  test("the simulator is inert until connectControl is called", () => {
    const wsFactory = makeWsRecorder();
    createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, wsFactory });

    expect(wsFactory.instances).toHaveLength(0);
  });

  test("connectControl calls the factory and announces hello", () => {
    const wsFactory = makeWsRecorder();
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, wsFactory });

    const socket = sim.connectControl();

    expect(wsFactory.instances).toHaveLength(1);
    expect(socket.url).toBe(`ws://collector.local${CONTROL_WS_PATH}`);
    expect(socket.readyState).toBe(1);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "hello", device: DEVICE, chip: "sim", firmware: "iot-sim-0.1.0" });
  });

  test("the hello frame is sent when the socket opens later", () => {
    const wsFactory = makeWsRecorder((socket) => {
      socket.readyState = 0; // not open yet
    });
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, wsFactory });
    const socket = sim.connectControl();

    expect(socket.sent).toHaveLength(0);
    socket.readyState = 1;
    socket.emitOpen();
    expect(JSON.parse(socket.sent[0]).type).toBe("hello");
  });

  test("a control frame is parsed into commands and applied to the actuator", () => {
    const received = [];
    const wsFactory = makeWsRecorder();
    const sim = createSimulator({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      wsFactory,
      onCommand: (command) => received.push(command),
    });
    const socket = sim.connectControl();

    socket.emitMessage(JSON.stringify({ control: [{ id: "c_1", variable: "duty", value: 42 }] }));

    expect(received).toEqual([{ id: "c_1", variable: "duty", value: 42 }]);
    expect(sim.commands.get("duty")).toBe(42);
    expect(sim.controller.value).toBe(42);
  });

  test("commands are clamped to the actuator range", () => {
    const wsFactory = makeWsRecorder();
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, wsFactory });
    const socket = sim.connectControl();

    socket.emitMessage(JSON.stringify({ control: [{ id: "c_2", variable: "duty", value: 150 }] }));

    expect(sim.controller.value).toBe(100);
  });

  test("a malformed frame is ignored without throwing", () => {
    const wsFactory = makeWsRecorder();
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, wsFactory });
    const socket = sim.connectControl();

    expect(() => socket.emitMessage("{not json")).not.toThrow();
    expect(sim.handleControlMessage(null)).toEqual([]);
    expect(sim.handleControlMessage({ control: "nope" })).toEqual([]);
  });

  test("connectControl without a factory fails loudly rather than opening a real socket", () => {
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE });

    expect(() => sim.connectControl()).toThrow(/wsFactory/);
  });
});

/* -------------------------------------------------------------------------- */
/* Construction guards                                                        */
/* -------------------------------------------------------------------------- */

describe("createSimulator — guards", () => {
  test("requires a base URL and a project token", () => {
    expect(() => createSimulator({ projectToken: TOKEN })).toThrow(/baseUrl/);
    expect(() => createSimulator({ baseUrl: BASE_URL })).toThrow(/projectToken/);
  });

  test("defaults the device key when none is supplied", () => {
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, fetchImpl });

    expect(sim.deviceKey).toBe(DEFAULT_DEVICE_KEY);
  });

  test("supports a fixed reading source for exact-body assertions", async () => {
    const fetchImpl = makeFetchSpy(() => fakeResponse(204));
    const sim = createSimulator({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      fetchImpl,
      seed: () => [{ metrics: { temp: 25.4 } }],
    });

    const result = await sim.publishOnce();

    expect(result.ok).toBe(true);
    expect(JSON.parse(fetchImpl.calls[0].body)).toEqual({ metrics: { temp: 25.4 } });
  });
});
