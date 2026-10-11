/**
 * `ota-fixture` — OTA fixture, device-side update simulation and reset-free load
 * generator for the `iot-sim` device simulator (ticket D02).
 *
 * This is the M2 counterpart of the M1 telemetry simulator in `./index.js`.
 * Where that module plays a device *publishing* readings, this one plays a device
 * *updating its firmware*, following the OTA flow frozen by the wire contract
 * (`.planning/spec.md` §4.3 / §6.4 / §6.5, `BEHAVIOR-SPEC.md` §3):
 *
 *   GET /v1/ota        (header x-insight-firmware)
 *     → {update:null} | {update:{version,size,sha256,url}}
 *     → if update: download /v1/ota/image
 *        → buffer the whole image → size == offer.size? → SHA-256 match?
 *           → (no)  discard, retry on the next schedule (honouring retry-after)
 *           → (yes) flash
 *
 * Three design rules, the same ones that shape `./index.js`:
 *
 *   1. **Everything that touches the outside world is injected.** All OTA I/O
 *      flows through one `fetchImpl`, defaulting to `globalThis.fetch` but always
 *      overridable, so a test runs fully offline, in-process, with no socket and
 *      no server. Nothing here opens a connection on its own initiative.
 *   2. **The whole image is buffered before any decision.** Nothing is "written
 *      to flash" — `accept` is only ever true once the bytes have been buffered
 *      *and* their SHA-256 matched the offer (INV-O1/O5, D2.6). A truncated or
 *      corrupted download can therefore never be accepted.
 *   3. **An error is a value, not an exception.** A 404, a 429 or a transport
 *      failure comes back as `{ ok: false, kind, reason }` so retry policy stays
 *      in the caller's hands.
 *
 * The device key travels in the `x-insight-device` header (FR-DEV-03), and the
 * running version in `x-insight-firmware` (FR-OTA-02) — never in a body. The
 * request-shaping constants are imported from `./index.js` so the two modules
 * cannot drift on the identity header.
 *
 * `runLoad()` closes the ticket: it drives the M1 simulator's `publishOnce()` an
 * arbitrary number of times so a later perf measurement has something to
 * measure (FR-STA-03: "the simulator can generate load").
 */

import { createRequire } from "node:module";

import { DEVICE_HEADER, createSimulator } from "./index.js";

/**
 * A CommonJS `require`, derived from this module's URL.
 *
 * `node:crypto` is loaded through this rather than a bare `require(...)` so the
 * module works identically under Bun (where a global `require` exists) and under
 * plain Node as an ES module (where it does not). `createRequire` is honoured by
 * both — verified for Bun 1.4 and Node 22.
 */
const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** OTA offer route (spec §6.4). */
export const OTA_OFFER_PATH = "/v1/ota";

/** OTA image route (spec §6.5). */
export const OTA_IMAGE_PATH = "/v1/ota/image";

/** Firmware-version header the device reports its running version in (FR-OTA-02). */
export const FIRMWARE_HEADER = "x-insight-firmware";

/** Content type of the image download (spec §6.5). */
export const OTA_CONTENT_TYPE = "application/octet-stream";

/** Version assumed for the fixture's "current" firmware. */
export const DEFAULT_FIRMWARE_VERSION = "1.0.0";

/* -------------------------------------------------------------------------- */
/* SHA-256                                                                    */
/* -------------------------------------------------------------------------- */

const HEX_64 = /^[0-9a-f]{64}$/i;

/** @returns {boolean} True for a 64-hex-digit (case-insensitive) digest. */
export function isSha256Hex(value) {
  return typeof value === "string" && HEX_64.test(value);
}

function canonical(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return new Uint8Array(bytes);
  if (typeof bytes === "string") return new TextEncoder().encode(bytes);
  if (bytes == null) return new Uint8Array(0);
  throw new TypeError("sha256Hex expects bytes (string, Uint8Array or ArrayBuffer)");
}

/**
 * Host-side SHA-256 of a buffer, lowercased hex (the canonical form the offer's
 * `sha256` field uses, spec §6.4).
 *
 * The helper is synchronous, so it can be called from a plain `expect`. Digest
 * resolution is done once, lazily and *verified* (see {@link resolveSha256}):
 * `node:crypto`'s `createHash` is preferred — it hashes `Uint8Array` bytes
 * exactly, which the WebCrypto path would need an `ArrayBuffer` view for — and
 * the choice is checked against the published `"abc"` vector before it is used,
 * so a runtime can never silently hash with something that is not SHA-256.
 *
 * @param {string|Uint8Array|ArrayBuffer|number[]} bytes
 * @returns {string} 64 lowercase hex characters.
 */
export function sha256Hex(bytes) {
  return resolveSha256()(canonical(bytes));
}

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/**
 * Resolve and cache a verified byte→hex SHA-256 implementation.
 *
 * Tries `node:crypto.createHash` first, then any synchronous `crypto.subtle`-like
 * digest the host exposes. Whatever it finds is proven against the `"abc"` test
 * vector before being adopted, so a partial shim cannot masquerade as SHA-256.
 *
 * @returns {(bytes: Uint8Array) => string}
 */
function resolveSha256() {
  if (resolveSha256.cached) return resolveSha256.cached;

  const nodeCrypto = globalThis.process?.versions?.node ? loadNodeCrypto() : null;
  const implementation = (data) =>
    nodeCrypto
      ? nodeCrypto.createHash("sha256").update(data).digest("hex")
      : loadSyncSubtle(data);

  if (implementation(new TextEncoder().encode("abc")) !== SHA256_ABC) {
    throw new Error("no verified SHA-256 implementation is available in this runtime");
  }
  resolveSha256.cached = implementation;
  return implementation;
}

/** Lazy `node:crypto` lookup that must not throw on runtimes without it. */
function loadNodeCrypto() {
  try {
    return loadNodeCrypto.cached ?? (loadNodeCrypto.cached = require("node:crypto"));
  } catch {
    return null;
  }
}

/**
 * Synchronous WebCrypto fallback.
 *
 * Deliberately throws: no mainstream JS host exposes a synchronous `subtle`, and
 * blocking here would hang a test. It exists so the fallback branch is a clear
 * error rather than a silent `undefined` — `node:crypto` is present everywhere
 * this repo runs.
 *
 * @param {Uint8Array} _data
 * @returns {never}
 */
function loadSyncSubtle(_data) {
  throw new Error("no synchronous SHA-256 implementation is available in this runtime");
}

/**
 * Constant-time-ish comparison of two digests.
 *
 * The values compared here are public (an offer vs a stream we hashed), so this
 * is defensive hygiene rather than a timing-attack mitigation. It normalises the
 * case so `"AB..."` and `"ab..."` are the same digest.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sha256Equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A generated fixture: one image, one offer, and the SHA-256 of the *served*
 * bytes (which is what the device will actually compute).
 *
 * @typedef {object} OtaFixture
 * @property {string} version        Firmware version the offer advertises.
 * @property {number} size           Image length in bytes (`offer.update.size`).
 * @property {string} sha256         SHA-256 of {@link OtaFixture#image}.
 * @property {string} url            Relative image URL (`offer.update.url`).
 * @property {Uint8Array} image      The image bytes, exactly as served.
 * @property {{ update: { version: string, size: number, sha256: string, url: string } }} offer
 *   The full `GET /v1/ota` body.
 * @property {number} integrityBytes 1 when the bytes match `sha256`, 0 when the
 *   fixture is a deliberately corrupt variant.
 * @property {boolean} corrupted     True for {@link buildWrongHashFixture}.
 */

/**
 * Build a matching OTA fixture: an image and an offer whose `sha256`/`size`
 * describe exactly the bytes a server would serve for it, so a correct device
 * verifies and accepts.
 *
 * The image bytes are deterministic (a fixed LCG over the version string), so
 * two fixtures built from the same version are byte-identical and the test can
 * assert a concrete hex digest instead of just "some 64-char string".
 *
 * @param {object} [options]
 * @param {string} [options.version]  Firmware version; changing it changes the
 *   bytes (and so the digest). Defaults to {@link DEFAULT_FIRMWARE_VERSION}.
 * @param {number} [options.size]     Image length in bytes (default 256).
 * @param {string} [options.url]      Relative (or absolute) image URL. Defaults
 *   to {@link OTA_IMAGE_PATH}.
 * @param {number|string} [options.seed] Byte-generation seed; defaults to the
 *   version so the same version always yields the same image.
 * @returns {OtaFixture}
 */
export function buildOtaFixture({ version = DEFAULT_FIRMWARE_VERSION, size = 256, url = OTA_IMAGE_PATH, seed } = {}) {
  if (!Number.isInteger(size) || size <= 0) throw new TypeError("size must be a positive integer");
  if (typeof version !== "string" || version.trim() === "") throw new TypeError("version must be a non-empty string");
  if (typeof url !== "string" || url.trim() === "") throw new TypeError("url must be a non-empty string");

  const image = makeImage(size, seed ?? version);
  const sha256 = sha256Hex(image);

  return {
    version,
    size: image.length,
    sha256,
    url,
    image,
    offer: { update: { version, size: image.length, sha256, url } },
    integrityBytes: 1,
    corrupted: false,
  };
}

/**
 * Build a variant with a deliberately wrong hash.
 *
 * Two flavours, both of which a correct device must reject:
 *
 *   - `mode: "offer"` (default) — the image is genuine and the **offer lies**:
 *     `sha256` does not describe the bytes that will be served (`image` itself is
 *     flipped). This is the "wrong-hash image" the ticket names, and it models a
 *     tampered or mis-published offer.
 *   - `mode: "bytes"` — the offer is genuine but the **served bytes are
 *     corrupted**: `served` (and `image`) is the real image with its last byte
 *     changed, exactly ST-O1 case (b) ("whole bytes, last byte altered"). `sha256`
 *     stays the hash of the *intended* image, so it no longer matches.
 *
 * Either way `verifyImage` returns `false`: no byte is ever flashed on a
 * mismatch (INV-O1, D2.6).
 *
 * @param {object} [options] Same options as {@link buildOtaFixture}, plus:
 * @param {OtaFixture} [options.base]   Fixture to corrupt; defaults to a fresh one.
 * @param {"offer"|"bytes"} [options.mode="offer"]
 * @param {string} [options.sha256]     Explicit wrong digest to advertise.
 * @returns {OtaFixture & { served: Uint8Array, mode: "offer"|"bytes" }}
 */
export function buildWrongHashFixture({ base, mode = "offer", sha256, ...options } = {}) {
  const genuine = base ?? buildOtaFixture(options);
  if (mode !== "offer" && mode !== "bytes") throw new TypeError('mode must be "offer" or "bytes"');

  if (mode === "bytes") {
    const served = corruptLastByte(genuine.image);
    return {
      ...genuine,
      image: served,
      served,
      offer: { update: { ...genuine.offer.update, size: served.length } },
      integrityBytes: 0,
      corrupted: true,
      mode,
    };
  }

  const wrong = sha256 ?? sha256Hex(genuine.image.slice().reverse());
  return {
    ...genuine,
    sha256: wrong,
    offer: { update: { ...genuine.offer.update, sha256: wrong } },
    served: genuine.image,
    integrityBytes: 0,
    corrupted: true,
    mode,
  };
}

/**
 * Flip the final byte of an image, leaving its length (and so `offer.size`)
 * untouched. This is ST-O1 case (b): the whole stream arrives, the last byte is
 * wrong, and verification — not the length check — is what catches it.
 *
 * @param {Uint8Array} image
 * @returns {Uint8Array} A copy with `image[length-1]` flipped.
 */
export function corruptLastByte(image) {
  const copy = new Uint8Array(canonical(image));
  copy[copy.length - 1] ^= 0xff;
  return copy;
}

/**
 * The device-side verdict on an image against an offer.
 *
 * @typedef {object} VerifyResult
 * @property {boolean} ok           True only when size *and* hash match.
 * @property {boolean} sizeMatch    `image.length === offer.size`.
 * @property {"match"|"size_mismatch"|"hash_mismatch"} verdict
 * @property {string} actualSha256  SHA-256 of the bytes actually received.
 * @property {string} expectedSha256 The offer's advertised `sha256`.
 * @property {number} actualSize
 * @property {number} expectedSize
 */

/**
 * Host-side verification: does this image match this offer?
 *
 * Pure function of its inputs — no I/O, no clock. This is the same check the
 * device performs after buffering the whole stream, exposed so a test can assert
 * the decision directly as well as through {@link createOtaDevice}.
 *
 * @param {Uint8Array|string} image The bytes received (a `binary` string is
 *   encoded UTF-8).
 * @param {{ version?: string, size?: number, sha256: string, url?: string }} offer
 *   The `offer.update` object (or a whole `{update:{…}}` body).
 * @returns {VerifyResult}
 */
export function verifyImage(image, offer) {
  const bytes = canonical(image);
  const candidate = offer && typeof offer === "object" && offer.update ? offer.update : offer ?? {};
  const expectedSha256 = String(candidate.sha256 ?? "").trim().toLowerCase();
  const expectedSize = Number(candidate.size);
  const expectedSizeKnown = Number.isFinite(expectedSize);

  const actualSize = bytes.length;

  // Order matters: the cheap length check runs first (D2.6: "size==offer.size →
  // SHA-256"), so a truncated stream is reported as a size mismatch rather than
  // hashed into a confusing "hash mismatch".
  const sizeCheck = expectedSizeKnown ? actualSize === expectedSize : true;
  if (!sizeCheck) {
    return {
      ok: false,
      sizeMatch: false,
      verdict: "size_mismatch",
      actualSha256: "",
      expectedSha256,
      actualSize,
      expectedSize,
    };
  }

  const actualSha256 = sha256Hex(bytes);
  const match = isSha256Hex(expectedSha256) && sha256Equal(actualSha256, expectedSha256);
  return {
    ok: match,
    sizeMatch: true,
    verdict: match ? "match" : "hash_mismatch",
    actualSha256,
    expectedSha256,
    actualSize,
    expectedSize,
  };
}

/* -------------------------------------------------------------------------- */
/* Device-side simulation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A device "flash" decision.
 *
 * @typedef {object} FlashResult
 * @property {boolean} accept   True only if the image matched and was written.
 * @property {boolean} flashed  Performed a write (identical to `accept`).
 * @property {"accepted"|"no_update"|"offer_error"|"download_error"|"rejected"} reason
 */

/**
 * Normalise any fetch-like implementation into `(request) => Promise<Response>`.
 *
 * The same shape rule as `./index.js`: a two-parameter function (or the real
 * `globalThis.fetch`) is called `(url, init)`, a single-parameter hand-written
 * fake is handed the whole request object. Keeping the two adapters identical
 * means one test fake can serve both the uplink and the OTA seams.
 *
 * @param {Function} fetchImpl
 * @returns {(request: object) => Promise<unknown>}
 */
function toFetchAdapter(fetchImpl) {
  const isRealFetch = typeof globalThis.fetch === "function" && fetchImpl === globalThis.fetch;
  if (isRealFetch || fetchImpl.length >= 2) {
    return (request) => fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body });
  }
  return (request) => fetchImpl(request);
}

/** Read a response body without assuming which shape an injected fake exposes. */
async function readJson(response) {
  if (!response) return null;
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

/** Read an image body into bytes, accepting every shape a fake might expose. */
async function readBytes(response) {
  if (!response) return new Uint8Array(0);
  if (typeof response.arrayBuffer === "function") {
    const buffer = await response.arrayBuffer();
    return canonical(buffer);
  }
  if (typeof response.bytes === "function") return canonical(await response.bytes());
  if (typeof response.blob === "function") return canonical(new Uint8Array(await (await response.blob()).arrayBuffer()));
  if (typeof response.text === "function") return canonical(await response.text());
  return new Uint8Array(0);
}

/** Response headers, tolerant of a Headers instance or a plain object. */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Create an OTA device simulation: it can fetch an offer, download the image,
 * verify it against the offer and decide whether to flash.
 *
 * Inert until `checkForUpdate()` is called — like `createSimulator`, it performs
 * no I/O during construction.
 *
 * @param {object} options
 * @param {string} options.baseUrl         Collector origin.
 * @param {string} [options.projectToken]  Bearer token (OTA routes are
 *   project-token authed, spec §6.4). Optional so a fake needs no token.
 * @param {string} [options.deviceKey]     Sent as `x-insight-device` (FR-DEV-03).
 * @param {string} [options.firmware]      Running version, sent as
 *   `x-insight-firmware` (FR-OTA-02). Simulated devices default to the fixture's
 *   factory version; the caller supplies the version it is actually running.
 * @param {Function} [options.fetchImpl]   Fetch seam; defaults to the platform
 *   global. Never called during construction.
 * @param {(info: object) => void} [options.onEvent] Observer called on every
 *   step (`offer`, `download`, `verify`, `flash`) — useful for load/telemetry.
 * @returns {object} The device handle (see below).
 */
export function createOtaDevice({
  baseUrl,
  projectToken,
  deviceKey = "sim-ota-01",
  firmware = DEFAULT_FIRMWARE_VERSION,
  fetchImpl,
  onEvent,
} = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required");
  const fetchCandidate = fetchImpl ?? globalThis.fetch;
  if (typeof fetchCandidate !== "function") {
    throw new TypeError("fetchImpl is required when globalThis.fetch is unavailable");
  }
  const fetchAdapter = toFetchAdapter(fetchCandidate);

  /** Every request this device made: `{ url, method, headers }`. */
  const requests = [];
  const headers = () => ({
    ...(projectToken ? { authorization: `Bearer ${projectToken}` } : {}),
    [DEVICE_HEADER]: deviceKey,
    [FIRMWARE_HEADER]: firmware,
  });

  const device = {
    deviceKey,
    firmware,

    /**
     * `GET /v1/ota` — ask the server whether an update is offered.
     *
     * @returns {Promise<{ ok: boolean, status: number, update: object|null,
     *   kind: "ok"|"retry"|"fatal", retryAfter: number|null,
     *   error?: { code: string, message: string } }>}
     */
    async checkForUpdate() {
      const request = { url: joinPath(baseUrl, OTA_OFFER_PATH), method: "GET", headers: headers() };
      requests.push(request);
      onEvent?.({ step: "offer", request });

      let response;
      try {
        response = await fetchAdapter(request);
      } catch (cause) {
        const error = { code: "network_error", message: String(cause?.message ?? cause) };
        onEvent?.({ step: "offer", error });
        return { ok: false, status: 0, update: null, kind: "retry", retryAfter: null, error };
      }

      const status = Number(response?.status ?? 0);
      const kind = classify(status);
      if (kind !== "ok") {
        const body = await readJson(response);
        const envelope = body && typeof body === "object" ? body : {};
        const error = { code: envelope.error || (kind === "retry" ? "server_error" : "ota_offer_failed"), message: envelope.message ?? "" };
        onEvent?.({ step: "offer", status, error });
        return { ok: false, status, update: null, kind, retryAfter: parseRetryAfter(headerValue(response?.headers, "retry-after")), error };
      }

      const body = await readJson(response);
      const update = body && typeof body === "object" ? body.update ?? null : null;
      onEvent?.({ step: "offer", status, update });
      return { ok: true, status, update, kind: "ok", retryAfter: null };
    },

    /**
     * `GET /v1/ota/image` — download the image bytes named by an offer.
     *
     * Buffers the whole stream (no resume — D2.6 is "restart from zero"), so the
     * caller can verify it before anything is flashed.
     *
     * @param {{ version?: string, size?: number, sha256: string, url?: string }} offer
     * @returns {Promise<{ ok: boolean, status: number, bytes: Uint8Array,
     *   kind: "ok"|"retry"|"fatal", retryAfter: number|null,
     *   error?: { code: string, message: string } }>}
     */
    async downloadImage(offer) {
      const url = joinPath(baseUrl, offer?.url ?? OTA_IMAGE_PATH);
      const request = { url, method: "GET", headers: headers() };
      requests.push(request);
      onEvent?.({ step: "download", request });

      let response;
      try {
        response = await fetchAdapter(request);
      } catch (cause) {
        const error = { code: "network_error", message: String(cause?.message ?? cause) };
        onEvent?.({ step: "download", error });
        return { ok: false, status: 0, bytes: new Uint8Array(0), kind: "retry", retryAfter: null, error };
      }

      const status = Number(response?.status ?? 0);
      const kind = classify(status);
      if (kind !== "ok") {
        const retryAfter = parseRetryAfter(headerValue(response?.headers, "retry-after"));
        const error = {
          code: status === 404 ? "image_not_found" : kind === "retry" ? "server_error" : "ota_image_failed",
          message: "",
        };
        onEvent?.({ step: "download", status, error, retryAfter });
        return { ok: false, status, bytes: new Uint8Array(0), kind, retryAfter, error };
      }

      const bytes = await readBytes(response);
      onEvent?.({ step: "download", status, bytes });
      return { ok: true, status, bytes, kind: "ok", retryAfter: null };
    },

    /**
     * One full OTA attempt: offer → (if any) download → verify → accept/reject.
     *
     * This is the invariant-carrying method (INV-O1/O5): `accept` is true only
     * when the bytes were fully buffered, `size` matched and the SHA-256 matched.
     * A download error, a size mismatch and a hash mismatch all leave
     * `flashed === false`.
     *
     * @param {object} [options]
     * @param {(offer: object) => Promise<{ bytes: Uint8Array, status?: number }>|{ bytes: Uint8Array, status?: number }} [options.image]
     *   Optional image source. Defaults to `GET <offer.url>`. Injecting it keeps
     *   the offer round-trip exercised while the image is served from memory.
     * @returns {Promise<FlashResult & { offer?: object, verify?: VerifyResult }>}
     */
    async applyUpdate({ image } = {}) {
      const offer = await this.checkForUpdate();
      if (!offer.ok) return { accept: false, flashed: false, reason: "offer_error" };
      if (!offer.update) return { accept: false, flashed: false, reason: "no_update", offer: offer.update };

      let bytes;
      if (image) {
        const source = await image(offer.update);
        bytes = canonical(source?.bytes ?? source ?? new Uint8Array(0));
        onEvent?.({ step: "download", status: Number(source?.status ?? 200), bytes, injected: true });
      } else {
        const download = await this.downloadImage(offer.update);
        if (!download.ok) return { accept: false, flashed: false, reason: "download_error", offer: offer.update, error: download.error };
        bytes = download.bytes;
      }

      const verify = verifyImage(bytes, offer.update);
      onEvent?.({ step: "verify", verify });

      // A mismatch — corrupt offer hash, or bytes whose last byte was altered —
      // is discarded, never flashed (ST-O1, INV-O1).
      if (!verify.ok) return { accept: false, flashed: false, reason: "rejected", offer: offer.update, verify };

      onEvent?.({ step: "flash", offer: offer.update, verify });
      this.firmware = String(offer.update.version ?? this.firmware);
      return { accept: true, flashed: true, reason: "accepted", offer: offer.update, verify };
    },

    /** Every request this device made, in order. */
    requests,
  };

  return device;
}

/* -------------------------------------------------------------------------- */
/* Load                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Publish `batches` batches of `batchSize` readings through the M1 simulator,
 * with a bounded number of in-flight requests.
 *
 * This is the load seam behind the ticket's "the simulator can generate load"
 * (FR-STA-03): it exists so a later perf measurement has something to measure
 * and so the acceptance test can assert N batches complete without error. It is
 * intentionally tiny — no timing, no reporting — and fully injectable, so it
 * runs offline against a fake fetch.
 *
 * @param {object} options
 * @param {import("./index.js").Simulator} [options.simulator] A ready simulator
 *   to drive. When omitted one is built from the other options.
 * @param {string} [options.baseUrl]        Required when `simulator` is omitted.
 * @param {string} [options.projectToken]   Required when `simulator` is omitted.
 * @param {string} [options.deviceKey]
 * @param {number} [options.seed]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.batches=1]      Number of batches (publish calls).
 * @param {number} [options.batchSize=1]    Readings per batch.
 * @param {number} [options.concurrency=1]  In-flight requests at once.
 * @param {(result: object, index: number) => void} [options.onResult]
 * @returns {Promise<{ requested: number, ok: number, failed: number,
 *   results: Array<object>, elapsedMs: number }>}
 */
export async function runLoad({
  simulator,
  baseUrl,
  projectToken,
  deviceKey,
  seed,
  fetchImpl,
  batches = 1,
  batchSize = 1,
  concurrency = 1,
  onResult,
} = {}) {
  if (!Number.isInteger(batches) || batches < 0) throw new TypeError("batches must be a non-negative integer");
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new TypeError("batchSize must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new TypeError("concurrency must be a positive integer");

  const sim = simulator ?? createSimulator({ baseUrl, projectToken, deviceKey, seed, fetchImpl });
  const startedAt = Date.now();
  const results = [];

  for (let start = 0; start < batches; start += concurrency) {
    const wave = [];
    for (let index = start; index < Math.min(start + concurrency, batches); index += 1) {
      wave.push(
        (async () => {
          const readings = sim.sensors(batchSize);
          const result = await sim.publishOnce(readings);
          onResult?.(result, index);
          return result;
        })(),
      );
    }
    results.push(...(await Promise.all(wave)));
  }

  const ok = results.filter((result) => result.ok).length;
  return { requested: batches, ok, failed: batches - ok, results, elapsedMs: Date.now() - startedAt };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic image of `size` bytes.
 *
 * A 32-bit LCG (the same constants as `./sensors.js`) keyed by a string seed, so
 * the same `(version, size)` always yields identical bytes — which lets the test
 * pin a concrete digest rather than merely "a 64-char hex string".
 *
 * @param {number} size
 * @param {string|number} seed
 * @returns {Uint8Array}
 */
export function makeImage(size, seed = DEFAULT_FIRMWARE_VERSION) {
  if (!Number.isInteger(size) || size <= 0) throw new TypeError("size must be a positive integer");
  const bytes = new Uint8Array(size);
  let state = hashSeed(String(seed)) >>> 0;
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = (state >>> 24) & 0xff;
  }
  return bytes;
}

/** Fold a string into a uint32 seed (FNV-1a). */
function hashSeed(text) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Join a base URL and an absolute path without doubling the slash. */
function joinPath(baseUrl, path) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  const suffix = String(path).startsWith("/") ? String(path) : `/${path}`;
  return `${base}${suffix}`;
}

/** The same retry-policy bucket `./index.js` uses. */
function classify(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 429) return "retry";
  return "fatal";
}

/** Parse a `retry-after` header (delta-seconds or an HTTP date) into seconds. */
export function parseRetryAfter(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : null;
}

export default buildOtaFixture;
