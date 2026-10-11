/**
 * `iot-sim` — the device simulator behind the M1 vertical slice (ticket D01).
 *
 * A simulator plays the part of real hardware in two directions:
 *
 *   uplink   — it batches sensor readings and sends them to the ingest route
 *              `POST /v1/telemetry` with a project token and an
 *              `x-insight-device` identity header (`.planning/spec.md` §6.1);
 *   downlink — it optionally opens the WS control channel `/v1/control/ws`,
 *              announces itself with a `hello` frame and receives
 *              `{ control: [ { id, variable, value } ] }` commands (spec §4.1).
 *
 * Two design rules shape everything below:
 *
 *   1. **Everything that touches the outside world is injected.** `fetchImpl`
 *      and `wsFactory` default to the platform globals but are always
 *      overridable, so a test runs fully offline, in-process, with no socket
 *      and no server. Nothing here opens a connection on its own initiative.
 *   2. **Connections are explicit.** `createSimulator()` is inert: it builds a
 *      request but sends nothing. Only `publishOnce()` and `connectControl()`
 *      perform I/O.
 *
 * A device-simulated timestamp is never sent. The server stamps every sample
 * with its own clock (spec §6.1); the only `ts` this module ever reports comes
 * back from the server in an error body.
 */

import { createSensors } from "./sensors.js";

/** Ingest route the simulator publishes to (spec §6.1). */
export const TELEMETRY_PATH = "/v1/telemetry";

/** Identity header carrying the device key (spec §6.1, `FR-DEV-03`). */
export const DEVICE_HEADER = "x-insight-device";

/** WS control channel (spec §4.1 / §5.2). */
export const CONTROL_WS_PATH = "/v1/control/ws";

/** Device key assumed when the caller supplies none. */
export const DEFAULT_DEVICE_KEY = "sim-01";

/**
 * Longest device key the server will persist. Mirrors the ingest route's own
 * defensive clamp on the attacker-controlled `x-insight-device` header
 * (`worker/src/domains/telemetry/telemetry.ts`). The simulator checks this
 * *before* transmitting, so a too-long key fails locally instead of being
 * silently truncated on arrival.
 */
export const MAX_DEVICE_KEY_LENGTH = 64;

/** Default firmware string announced in the WS `hello` frame. */
export const DEFAULT_FIRMWARE = "iot-sim-0.1.0";

/**
 * Join a base URL and an absolute path without doubling or dropping the slash.
 *
 * A `baseUrl` may legitimately carry a base path (e.g. `https://host/api/`), so
 * the two parts are trimmed and joined rather than blindly concatenated.
 *
 * @param {string} baseUrl
 * @param {string} path Absolute path such as `/v1/telemetry`.
 * @returns {string}
 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Convert an absolute HTTP(S) URL into the WS(S) control-channel URL.
 *
 * `http` → `ws`, `https` → `wss`; anything else (a bare `host:port`, a custom
 * scheme) is passed through untouched so an injected factory still gets a
 * usable string.
 *
 * @param {string} url Absolutely-qualified URL.
 * @returns {string}
 */
export function toWebSocketUrl(url) {
  return String(url).replace(/^http(s?):\/\//i, (_match, secure) => (secure ? "wss://" : "ws://"));
}

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a transport adapter is asked to do by {@link Simulator#publishOnce}.
 *
 * It is built before any I/O happens, so it doubles as the inspectable
 * description of the request in tests and in `--dry-run`-style callers.
 *
 * @typedef {object} PublishRequest
 * @property {string} url     Fully-qualified ingest URL.
 * @property {string} method  Always `POST`.
 * @property {Record<string,string>} headers Includes `authorization` and
 *   {@link DEVICE_HEADER}.
 * @property {string} body    JSON string with a top-level `metrics` object.
 * @property {{ metrics: Record<string, unknown> }} payload The body, unparsed.
 */

/**
 * Outcome of one ingest attempt.
 *
 * `status` is `0` when the connection never produced an HTTP response, which is
 * the `network_error` case. `kind` is the retry policy bucket: `ok` needs no
 * action, `retry` should be re-sent later, `fatal` means the payload or token
 * is wrong and re-sending is pointless.
 *
 * @typedef {object} PublishResult
 * @property {boolean} ok     True for any 2xx, including `204 No Content`.
 * @property {number} status  HTTP status, or `0` for a transport failure.
 * @property {"ok"|"retry"|"fatal"} kind
 * @property {unknown} body   Parsed response body, or `null` when empty.
 * @property {{ code: string, message: string, ts?: number }} [error] Present
 *   only when `ok` is false.
 */

/**
 * The object returned by {@link createSimulator}.
 *
 * @typedef {object} Simulator
 * @property {(batch?: number) => Array<{ metrics: object }>} sensors Seeded
 *   reading generator.
 * @property {Map<string, unknown>} commands Newest command value per variable.
 * @property {string} deviceKey Device identity sent as {@link DEVICE_HEADER}.
 * @property {unknown} controlSocket The connected control socket, if any.
 * @property {(readings?: unknown) => PublishRequest} publishRequest Build the
 *   request without sending it.
 * @property {(batch?: Array<{ metrics: object }>) => Promise<PublishResult>} publishOnce
 *   Send one batch to `POST /v1/telemetry`.
 * @property {(handlers?: object) => unknown} connectControl Open the WS control
 *   channel through the injected factory.
 * @property {(handlers?: object) => unknown} createWebSocket Alias kept public
 *   for callers that want to own the socket's handlers.
 * @property {(message: unknown) => Array<object>} handleControlMessage Decode a
 *   control frame and apply its commands.
 */

/**
 * Build the `POST /v1/telemetry` request for a batch readings.
 *
 * Kept separate from {@link Simulator#publishOnce} so "what would be sent" is
 * observable and testable without performing any I/O.
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.projectToken
 * @param {string} options.deviceKey
 * @param {Array<{ metrics: object }>|object} options.readings One reading, a
 *   batch of them, or (in `raw` mode) the metrics map itself.
 * @param {boolean} [options.raw] Treat `readings` as the metrics map verbatim
 *   instead of merging a batch of `{ metrics }` readings. Used by contract
 *   tests that must assert the exact encoded body.
 * @returns {PublishRequest}
 */
export function buildPublishRequest({ baseUrl, projectToken, deviceKey, readings, raw = false }) {
  let metrics;
  if (raw) {
    // Caller hands over the metrics map directly.
    metrics = readings;
  } else {
    const batch = Array.isArray(readings) ? readings : [readings];
    if (batch.length === 0) throw new TypeError("publish requires at least one reading");
    // Merge the batch into one `metrics` object. The wire contract carries a
    // flat `{k: v}` map with no per-sample timestamp, so the newest value per
    // key wins.
    metrics = batch.reduce((acc, reading) => {
      if (!reading || typeof reading !== "object" || !reading.metrics) {
        throw new TypeError("each reading must be shaped { metrics: {...} }");
      }
      return Object.assign(acc, reading.metrics);
    }, {});
  }

  const payload = { metrics };
  return {
    url: joinUrl(baseUrl, TELEMETRY_PATH),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${projectToken}`,
      [DEVICE_HEADER]: deviceKey,
    },
    body: JSON.stringify(payload),
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Check a batch and a device key against the wire contract's own limits
 * (spec §6.1: a blank key is refused, a key past {@link MAX_DEVICE_KEY_LENGTH}
 * is refused, and the ingest route requires at least one metric).
 *
 * @param {Array<{ metrics: object }>} batch
 * @param {string} deviceKey
 * @returns {{ ok: true } | { ok: false, error: { code: string, message: string } }}
 */
export function validatePublishRequest(batch, deviceKey) {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { ok: false, error: { code: "empty_batch", message: "publish requires at least one reading" } };
  }
  const key = String(deviceKey ?? "").trim();
  if (key === "") {
    return { ok: false, error: { code: "missing_device_key", message: "device key must not be blank" } };
  }
  if (key.length > MAX_DEVICE_KEY_LENGTH) {
    return { ok: false, error: { code: "invalid_device_key", message: `device key exceeds ${MAX_DEVICE_KEY_LENGTH} characters` } };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Transport adapters                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalise any fetch-like implementation into `(request) => Promise<Response>`.
 *
 * `globalThis.fetch`, `Bun.fetch` and any real `Request`-accepting
 * implementation are handed straight through — a test that spies on
 * `(url, init)` keeps seeing that exact call shape. Only hand-written fakes
 * that declare a single parameter are adapted to the `(url, init)` style.
 *
 * @param {Function} fetchImpl
 * @returns {(request: PublishRequest) => Promise<Response>}
 */
function toFetchAdapter(fetchImpl) {
  const isRealFetch = typeof globalThis.fetch === "function" && fetchImpl === globalThis.fetch;
  if (isRealFetch || fetchImpl.length >= 2) {
    return (request) => fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body });
  }
  return (request) => fetchImpl(request);
}

/**
 * Read a response body without assuming which of the many body shapes an
 * injected fake (or a real platform response) exposes.
 *
 * @param {unknown} response
 * @returns {Promise<unknown>} Parsed JSON, raw text, or `null` for an empty
 *   body (a `204` legitimately has none).
 */
async function readResponseBody(response) {
  if (!response) return null;
  if (typeof response.json === "function") return response.json();
  if (typeof response.text === "function") {
    const text = await response.text();
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

/**
 * Classify an HTTP status the way the device-side reliability layer does.
 *
 * @param {number} status
 * @returns {"ok"|"retry"|"fatal"}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  // 5xx is a server fault and 429 is rate limiting: both are transient by
  // definition (the spec sends `retry-after` with 429), so both are retryable.
  // Every other 4xx is a client fault that retrying cannot fix.
  if (status >= 500 || status === 429) return "retry";
  return "fatal";
}

/**
 * Normalise one publish attempt into `{ ok, status, kind, body }`.
 *
 * `ok` is true for **any** 2xx — in particular for `204 No Content`, which is
 * what the ingest route actually returns on success (spec §6.1).
 *
 * @param {{ status: number, response: unknown }} attempt
 */
async function toPublishResult({ status, response }) {
  const kind = classifyStatus(status);
  const body = await readResponseBody(response).catch(() => null);

  /** @type {{ ok: boolean, status: number, kind: string, body: unknown, error?: { code: string, message: string, ts?: number } }} */
  const result = { ok: kind === "ok", status, kind, body };

  if (!result.ok) {
    // The contract's error body is `{error: <code>, message}` (spec §6.9), with
    // `ts` echoed on clock-related rejections. Fall back to a bucket-level code
    // when a proxy or transport produced no parseable body at all.
    const envelope = body && typeof body === "object" ? body : {};
    result.error = {
      code: envelope.error || (kind === "retry" ? "server_error" : "http_error"),
      message: envelope.message ?? "",
      ...(envelope.ts === undefined ? {} : { ts: envelope.ts }),
    };
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Simulator                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a device simulator.
 *
 * @param {object} options
 * @param {string} options.baseUrl        Collector origin, e.g. `http://localhost:8787`.
 * @param {string} options.projectToken   Project token sent as a bearer.
 * @param {number|Function} [options.seed] Seed (or reading source) for the
 *   deterministic sensor generators.
 * @param {object} [options.sensors]      Sensor component overrides.
 * @param {(rng: Function) => object} [options.extra] Extra metrics hook.
 * @param {string} [options.deviceKey]    Device identity; defaults to
 *   {@link DEFAULT_DEVICE_KEY}. An unnamed device would auto-register under the
 *   server's default key instead.
 * @param {string} [options.firmware]     Firmware string for the WS `hello`.
 * @param {string} [options.chip]         Chip string for the WS `hello`.
 * @param {Function} [options.fetchImpl]  Fetch implementation; defaults to
 *   `globalThis.fetch`. Never called during construction.
 * @param {Function} [options.wsFactory]  `(url, protocol?) => WebSocketLike`;
 *   required to use {@link Simulator#connectControl}. No real socket is opened
 *   unless this is called.
 * @param {boolean} [options.raw]         Encode readings verbatim (see
 *   {@link buildPublishRequest}).
 * @param {(cmd: object) => void} [options.onCommand] Called for every command
 *   received on the control channel.
 * @returns {Simulator}
 */
export function createSimulator({
  baseUrl,
  projectToken,
  seed = 1,
  sensors = {},
  extra,
  deviceKey = DEFAULT_DEVICE_KEY,
  firmware = DEFAULT_FIRMWARE,
  chip = "sim",
  fetchImpl,
  wsFactory,
  raw = false,
  onCommand,
} = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required");
  if (!projectToken) throw new TypeError("projectToken is required");
  if (!deviceKey) throw new TypeError("deviceKey must not be empty (an unnamed device defeats FR-DEV-03)");

  const generate = typeof seed === "function" ? seed : createSensors({ seed, sensors, extra });

  const fetchCandidate = fetchImpl ?? globalThis.fetch;
  if (typeof fetchCandidate !== "function") {
    throw new TypeError("fetchImpl is required when globalThis.fetch is unavailable");
  }
  const fetchAdapter = toFetchAdapter(fetchCandidate);

  const simulator = {
    /** Sensor generator, exposed for batch shaping and for tests. */
    sensors: generate,

    publishRequest(readings) {
      return buildPublishRequest({ baseUrl, projectToken, deviceKey, readings: raw ? readings : readings ?? generate(1), raw });
    },

    /**
     * Send one batch to `POST /v1/telemetry`.
     *
     * @param {Array<{ metrics: object }>} [batch] Readings to send; when
     *   omitted one fresh reading is generated from the seeded sensor stream.
     * @returns {Promise<PublishResult>} Never rejects on an HTTP error status —
     *   an error is a result, not an exception, so retry policy stays in the
     *   caller's hands.
     */
    async publishOnce(batch) {
      const readings = batch ?? generate(1);

      // Local pre-flight against the same rules the ingest route enforces, so a
      // caller learns about an unroutable request without a round trip. Raw
      // mode supplies a metrics map rather than a batch, so only the device key
      // is checked there.
      const verdict = raw ? validatePublishRequest([{}], deviceKey) : validatePublishRequest(Array.isArray(readings) ? readings : [readings], deviceKey);
      if (!verdict.ok) {
        return { ok: false, status: 0, kind: "fatal", body: null, error: verdict.error };
      }

      const request = buildPublishRequest({ baseUrl, projectToken, deviceKey, readings, raw });

      let response;
      try {
        response = await fetchAdapter(request);
      } catch (cause) {
        // A transport failure (DNS, refused connection, abort) is the 5xx of the
        // network: retryable, and reported rather than thrown.
        return { ok: false, status: 0, kind: "retry", body: null, error: { code: "network_error", message: String(cause?.message ?? cause) } };
      }

      return toPublishResult({
        status: Number(response?.status ?? 0),
        response,
      });
    },

    /**
     * Open the WS control channel via the injected factory.
     *
     * Inert before this point: no socket exists until `connectControl()` (or an
     * explicit {@link Simulator#createWebSocket}) is called. The factory is
     * called with the primaries first and `http(s)`-spelled fallbacks after, so
     * a URL-aware fake can register whichever it prefers.
     *
     * @param {{ onMessage?: (data: unknown, socket: unknown) => void, onOpen?: Function, onClose?: Function, onError?: Function, protocol?: string|string[] }} [handlers]
     * @returns {unknown} Whatever the factory returned (a `WebSocketLike`).
     */
    connectControl(handlers = {}) {
      if (typeof wsFactory !== "function") {
        throw new TypeError("wsFactory is required to connect the control channel");
      }
      const httpUrl = joinUrl(baseUrl, CONTROL_WS_PATH);
      const wsUrl = toWebSocketUrl(httpUrl);
      const candidates = [
        ...new Set([wsUrl, httpUrl, wsUrl.replace(/^wss:/, "ws:"), httpUrl.replace(/^https:/, "http:")]),
      ];
      const socket = wsFactory(...candidates);

      const sendHello = () => socket?.send?.(JSON.stringify({ type: "hello", device: deviceKey, chip, firmware }));
      // Some fakes hand back an already-open socket and never fire `open`; the
      // hello is sent either way, which keeps the assertion unambiguous.
      if (socket) {
        if (typeof socket.addEventListener === "function") socket.addEventListener("open", sendHello);
        else if (typeof socket.onopen !== "undefined" && socket.onopen !== null) {
          const previous = socket.onopen;
          socket.onopen = (event) => {
            previous?.call(socket, event);
            sendHello();
          };
        }
        if (socket.readyState === 1) sendHello();
      }

      const dispatcher = (data) => {
        const message = typeof data === "string" ? parseJson(data) : data;
        simulator.handleControlMessage(message);
        handlers.onMessage?.(message, socket);
      };

      if (socket) {
        if (typeof socket.addEventListener === "function") socket.addEventListener("message", (event) => dispatcher(event?.data ?? event));
        else if (typeof socket.onmessage !== "undefined" && socket.onmessage !== null) {
          const previous = socket.onmessage;
          socket.onmessage = (event) => {
            previous?.call(socket, event);
            dispatcher(event?.data ?? event);
          };
        }
        for (const [event, handler] of Object.entries(handlers)) {
          if (event === "onMessage" || typeof handler !== "function") continue;
          socket.addEventListener?.(event.replace(/^on/, "").toLowerCase(), handler);
        }
      }

      simulator.socket = socket;
      simulator.controlSocket = socket;
      return socket;
    },

    /**
     * Create (but do not use) a control-channel socket. Kept public so a caller
     * can hand the factory its own handlers and still exercise the same URL.
     */
    createWebSocket(handlers) {
      return simulator.connectControl(handlers);
    },

    /**
     * Handle one decoded control-channel message.
     *
     * The first successful connection is announced with `hello{device,chip,
     * firmware}` (spec §4.1); the server answers with `{control:[{id,variable,
     * value}]}`. This is where that downlink is unpacked: every command is
     * applied to the controller sensor and forwarded to `onCommand`.
     *
     * @param {unknown} message Parsed frame, or a raw JSON string.
     * @returns {Array<object>} The commands carried by the frame (possibly []).
     */
    handleControlMessage(message) {
      const frame = typeof message === "string" ? parseJson(message) : message;
      const commands = frame && Array.isArray(frame.control) ? frame.control : [];
      for (const command of commands) {
        if (!command || typeof command !== "object") continue;
        if (command.variable) simulator.commands.set(String(command.variable), command.value);
        if (command.variable === "duty") simulator.controller?.set?.(command.value);
        onCommand?.(command);
      }
      return commands;
    },

    /** Commands received so far, newest value per variable. */
    commands: new Map(),

    /** Default device key used when the server sees no `x-insight-device`. */
    deviceKey,
  };

  // The controller sensor is reachable for command application when enabled.
  simulator.controller = generate.controller ?? null;

  return simulator;
}

/** Parse JSON, returning `null` rather than throwing on malformed input. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default createSimulator;
