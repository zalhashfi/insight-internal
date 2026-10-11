/**
 * Offline tests for the `iot-sim` OTA fixture, device simulation and load helper
 * (ticket D02; M2 integration with B08).
 *
 * Every test runs in-process with no network and no server: the single HTTP seam
 * is a hand-written fake `fetchImpl` that records what it was given and replays a
 * scripted `Response`-compatible object. That one fake serves both the OTA routes
 * here and the telemetry uplink for the load helper, so the whole file is
 * hermetic.
 *
 * The assertions target the observable contract frozen by `.planning/spec.md`
 * §4.3/§6.4/§6.5 and `BEHAVIOR-SPEC.md` §3 — offer shape, the two OTA routes,
 * the `x-insight-firmware`/`x-insight-device` headers, and the accept/reject
 * decision of INV-O1/O5 (no byte is ever flashed without a size + SHA-256 match).
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FIRMWARE_VERSION,
  FIRMWARE_HEADER,
  OTA_CONTENT_TYPE,
  OTA_IMAGE_PATH,
  OTA_OFFER_PATH,
  buildOtaFixture,
  buildWrongHashFixture,
  corruptLastByte,
  createOtaDevice,
  isSha256Hex,
  makeImage,
  parseRetryAfter,
  runLoad,
  sha256Equal,
  sha256Hex,
  verifyImage,
} from "../src/iot-sim/ota-fixture.js";
import { DEVICE_HEADER, createSimulator } from "../src/iot-sim/index.js";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const BASE_URL = "http://collector.local";
const TOKEN = "pt_valid_token";
const DEVICE = "sim-ota-01";
const RUNNING_FIRMWARE = "1.0.0";

/** A Response-compatible stand-in: enough for `status`/`headers`/json/bytes. */
function fakeResponse(status, { json, bytes, text, headers = {} } = {}) {
  return {
    status,
    headers,
    json: async () => json ?? null,
    text: async () => (text === undefined ? (json === undefined ? "" : JSON.stringify(json)) : text),
    bytes: async () => bytes ?? new Uint8Array(0),
    arrayBuffer: async () => (bytes ?? new Uint8Array(0)).buffer,
  };
}

/**
 * Record every request an injected fetch receives and answer it from a router.
 * The spy declares exactly two parameters so the device recognises it as a real
 * `(url, init)` fetch — the same convention the uplink tests use.
 */
function makeFetchSpy(route) {
  const calls = [];
  const spy = async (url, init) => {
    const options = init ?? {};
    const call = {
      url: typeof url === "string" ? url : url?.url,
      method: options.method,
      headers: options.headers ?? {},
      body: options.body,
    };
    calls.push(call);
    return route(call);
  };
  spy.calls = calls;
  return spy;
}

/** A shared fake route table for the two OTA endpoints plus the uplink. */
function otaRouter({ offer, image, offerStatus = 200, offerHeaders = {}, imageStatus = 200, imageHeaders = {} }) {
  return (call) => {
    if (call.url === `${BASE_URL}${OTA_OFFER_PATH}`) {
      return fakeResponse(offerStatus, { json: offerStatus === 200 ? offer : { error: "unauthorized" }, headers: offerHeaders });
    }
    if (call.url === `${BASE_URL}${OTA_IMAGE_PATH}`) {
      return fakeResponse(imageStatus, {
        bytes: image,
        headers: { "content-type": OTA_CONTENT_TYPE, ...imageHeaders },
      });
    }
    if (call.url === `${BASE_URL}/v1/telemetry`) return fakeResponse(204);
    throw new Error(`unexpected request: ${call.url}`);
  };
}

/* -------------------------------------------------------------------------- */
/* SHA-256 — the reference vectors and the helper                             */
/* -------------------------------------------------------------------------- */

describe("sha256Hex — the digest the whole flow rests on", () => {
  test("matches the published NIST vectors", () => {
    // FIPS 180-2 sample vectors; pinned so a runtime swap cannot silently change
    // what "a matching hash" means.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  test("hashes byte buffers, not just strings", () => {
    // Same bytes through three shapes: an explicit Uint8Array, a subarray view
    // with an offset, and the equivalent string.
    const text = "firmware image payload";
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(sha256Hex(text));
    const padded = new Uint8Array([0x00, ...new TextEncoder().encode(text), 0xff]);
    const view = padded.subarray(1, padded.length - 1);
    expect(sha256Hex(view)).toBe(sha256Hex(text));
  });

  test("is deterministic and always 64 lowercase hex characters", () => {
    const first = sha256Hex(makeImage(64, "1.2.0"));
    const second = sha256Hex(makeImage(64, "1.2.0"));
    expect(first).toBe(second);
    expect(isSha256Hex(first)).toBe(true);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sha256Equal is case-insensitive and length-strict", () => {
    const digest = sha256Hex("abc");
    expect(sha256Equal(digest, digest.toUpperCase())).toBe(true);
    expect(sha256Equal(digest, digest.slice(0, -1))).toBe(false);
    expect(sha256Equal(digest, "z".repeat(64))).toBe(false);
    expect(sha256Equal(digest, null)).toBe(false);
    expect(isSha256Hex("not-a-hash")).toBe(false);
    expect(isSha256Hex(digest.slice(0, -1))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

describe("buildOtaFixture — a matching offer + image", () => {
  test("produces an offer shaped exactly like GET /v1/ota", () => {
    const fixture = buildOtaFixture({ version: "2.1.0" });

    expect(fixture.offer).toEqual({
      update: {
        version: "2.1.0",
        size: 256,
        sha256: expect.any(String),
        url: OTA_IMAGE_PATH,
      },
    });
    expect(JSON.parse(JSON.stringify(fixture.offer))).toEqual(fixture.offer); // wire-safe
    expect(isSha256Hex(fixture.offer.update.sha256)).toBe(true);
  });

  test("the offer's sha256 and size describe the image it ships", () => {
    const fixture = buildOtaFixture({ version: "2.1.0", size: 512 });

    expect(fixture.image).toBeInstanceOf(Uint8Array);
    expect(fixture.image.length).toBe(512);
    expect(fixture.offer.update.size).toBe(fixture.image.length);
    expect(fixture.offer.update.sha256).toBe(sha256Hex(fixture.image));
    expect(fixture.integrityBytes).toBe(1);
    expect(fixture.corrupted).toBe(false);
  });

  test("same version yields the same bytes; a different version yields others", () => {
    const a = buildOtaFixture({ version: "2.1.0" });
    const b = buildOtaFixture({ version: "2.1.0" });
    const c = buildOtaFixture({ version: "2.2.0" });

    expect(a.sha256).toBe(b.sha256);
    expect(a.image).toEqual(b.image);
    expect(a.sha256).not.toBe(c.sha256);
  });

  test("the default version is the one a simulated device reports", () => {
    expect(buildOtaFixture().version).toBe(DEFAULT_FIRMWARE_VERSION);
  });

  test("rejects a non-positive size and a blank version/url", () => {
    expect(() => buildOtaFixture({ size: 0 })).toThrow(TypeError);
    expect(() => buildOtaFixture({ size: -4 })).toThrow(TypeError);
    expect(() => buildOtaFixture({ version: "  " })).toThrow(TypeError);
    expect(() => buildOtaFixture({ url: "" })).toThrow(TypeError);
  });
});

describe("buildWrongHashFixture — a deliberately wrong hash", () => {
  test('mode "offer": the advertised digest does not match the served bytes', () => {
    const fixture = buildWrongHashFixture();
    const real = sha256Hex(fixture.image);

    expect(fixture.corrupted).toBe(true);
    expect(fixture.integrityBytes).toBe(0);
    expect(fixture.offer.update.sha256).not.toBe(real);
    expect(verifyImage(fixture.image, fixture.offer).ok).toBe(false);
  });

  test('mode "bytes": same length, last byte flipped (ST-O1 case b)', () => {
    const genuine = buildOtaFixture({ version: "3.0.0" });
    const tampered = buildWrongHashFixture({ base: genuine, mode: "bytes" });

    expect(tampered.image.length).toBe(genuine.image.length); // size still "matches"
    expect(tampered.offer.update.size).toBe(genuine.size);
    expect(tampered.image).not.toEqual(genuine.image);
    // The last byte is the only difference, and it is the hash — not the length —
    // that catches it.
    const verify = verifyImage(tampered.image, tampered.offer);
    expect(verify.sizeMatch).toBe(true);
    expect(verify.verdict).toBe("hash_mismatch");
    expect(verify.ok).toBe(false);
    expect(tampered.sha256).toBe(genuine.sha256); // the offer still describes the real image
  });

  test("an explicit wrong digest is honoured", () => {
    const fixture = buildWrongHashFixture({ sha256: "0".repeat(64) });
    expect(fixture.offer.update.sha256).toBe("0".repeat(64));
    expect(verifyImage(fixture.image, fixture.offer).ok).toBe(false);
  });

  test("rejects an unknown mode", () => {
    expect(() => buildWrongHashFixture({ mode: "nope" })).toThrow(TypeError);
  });
});

describe("corruptLastByte", () => {
  test("flips exactly the final byte and leaves a copy of the original", () => {
    const original = makeImage(8, "seed");
    const copy = original.slice();
    const flipped = corruptLastByte(original);

    expect(flipped.length).toBe(original.length);
    expect(flipped[flipped.length - 1]).toBe(original[original.length - 1] ^ 0xff);
    expect(original).toEqual(copy); // the input is not mutated
  });
});

describe("verifyImage — the device's own check, in isolation", () => {
  test("a genuine image verifies and reports the matching sizes/hashes", () => {
    const fixture = buildOtaFixture();
    const result = verifyImage(fixture.image, fixture.offer);

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("match");
    expect(result.sizeMatch).toBe(true);
    expect(result.actualSha256).toBe(fixture.sha256);
    expect(result.expectedSha256).toBe(fixture.sha256);
    expect(result.actualSize).toBe(result.expectedSize);
  });

  test("a truncated stream is a size mismatch, not a hash mismatch", () => {
    const fixture = buildOtaFixture({ size: 128 });
    const truncated = fixture.image.slice(0, 64);
    const result = verifyImage(truncated, fixture.offer);

    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("size_mismatch");
    expect(result.sizeMatch).toBe(false);
    expect(result.actualSize).toBe(64);
    expect(result.expectedSize).toBe(128);
  });

  test("a byte-corrupted stream of the right length is a hash mismatch", () => {
    const fixture = buildOtaFixture({ size: 128 });
    const result = verifyImage(corruptLastByte(fixture.image), fixture.offer);

    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("hash_mismatch");
    expect(result.sizeMatch).toBe(true);
  });

  test("accepts a whole { update } body as well as the inner offer", () => {
    const fixture = buildOtaFixture();
    expect(verifyImage(fixture.image, fixture.offer).ok).toBe(true);
    expect(verifyImage(fixture.image, fixture.offer.update).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Offer round-trip ∘ image download ∘ verify (the full device path)          */
/* -------------------------------------------------------------------------- */

describe("createOtaDevice — offer → download → verify → accept", () => {
  test("checkForUpdate round-trips the offer over GET /v1/ota", async () => {
    const fixture = buildOtaFixture({ version: "2.1.0" });
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: fixture.image }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const offer = await device.checkForUpdate();

    expect(offer.ok).toBe(true);
    expect(offer.status).toBe(200);
    expect(offer.update).toEqual(fixture.offer.update);
    // Round-trip: what came off the wire is exactly what the fixture built.
    expect(offer.update).toEqual(JSON.parse(JSON.stringify(fixture.offer)).update);

    const call = fetchImpl.calls[0];
    expect(call.url).toBe(`${BASE_URL}${OTA_OFFER_PATH}`);
    expect(call.method).toBe("GET");
    expect(call.headers[FIRMWARE_HEADER]).toBe(RUNNING_FIRMWARE); // FR-OTA-02
    expect(call.headers[DEVICE_HEADER]).toBe(DEVICE); // FR-DEV-03
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a correct-hash image is ACCEPTED and only after the bytes are buffered", async () => {
    const fixture = buildOtaFixture({ version: "2.1.0", size: 400 });
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: fixture.image }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate();

    expect(result.accept).toBe(true);
    expect(result.flashed).toBe(true);
    expect(result.reason).toBe("accepted");
    expect(result.verify.ok).toBe(true);
    expect(result.verify.actualSha256).toBe(fixture.sha256);
    expect(device.firmware).toBe("2.1.0"); // the running version advanced

    // Both OTA routes were used, in order: offer first, then image.
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([`${BASE_URL}${OTA_OFFER_PATH}`, `${BASE_URL}${OTA_IMAGE_PATH}`]);
  });

  test("a wrong-hash image (corrupt offer) is REJECTED and nothing is flashed", async () => {
    const fixture = buildWrongHashFixture({ version: "2.1.0" });
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: fixture.image }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate();

    expect(result.accept).toBe(false);
    expect(result.flashed).toBe(false);
    expect(result.reason).toBe("rejected");
    expect(result.verify.verdict).toBe("hash_mismatch");
    expect(device.firmware).toBe(RUNNING_FIRMWARE); // unchanged: nothing was written
  });

  test("a same-length byte-corrupted image is REJECTED (ST-O1 case b)", async () => {
    const genuine = buildOtaFixture({ version: "2.1.0" });
    const tampered = buildWrongHashFixture({ base: genuine, mode: "bytes" });
    // Serve the tampered bytes under the genuine offer: the size matches, so
    // only the SHA-256 can catch it.
    const fetchImpl = makeFetchSpy(otaRouter({ offer: genuine.offer, image: tampered.image }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate();

    expect(result.accept).toBe(false);
    expect(result.verify.sizeMatch).toBe(true);
    expect(result.verify.verdict).toBe("hash_mismatch");
  });

  test("a truncated image is REJECTED as a size mismatch (ST-O1 case a)", async () => {
    const fixture = buildOtaFixture({ version: "2.1.0", size: 512 });
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: fixture.image.slice(0, 200) }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate();

    expect(result.accept).toBe(false);
    expect(result.verify.verdict).toBe("size_mismatch");
  });

  test("an image can be injected while the offer still round-trips", async () => {
    const fixture = buildOtaFixture({ version: "9.9.9" });
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: new Uint8Array(0) }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate({ image: () => ({ bytes: fixture.image }) });

    expect(result.accept).toBe(true);
    // Only the offer was fetched; the image came from memory.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe(`${BASE_URL}${OTA_OFFER_PATH}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Endpoint correctness and error handling                                    */
/* -------------------------------------------------------------------------- */

describe("createOtaDevice — endpoint contract and errors", () => {
  test("the sim hits exactly /v1/ota and /v1/ota/image, with GET and no body", async () => {
    const fixture = buildOtaFixture();
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: fixture.image }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    await device.applyUpdate();

    expect(fetchImpl.calls).toHaveLength(2);
    for (const call of fetchImpl.calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
    }
    expect(fetchImpl.calls[0].url.endsWith(OTA_OFFER_PATH)).toBe(true);
    expect(fetchImpl.calls[1].url.endsWith(OTA_IMAGE_PATH)).toBe(true);
    expect(device.requests.map((request) => request.url)).toEqual([`${BASE_URL}${OTA_OFFER_PATH}`, `${BASE_URL}${OTA_IMAGE_PATH}`]);
  });

  test("{update:null} means no update, and nothing is downloaded", async () => {
    const fetchImpl = makeFetchSpy(makeFetchSpyRouterNull());
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const result = await device.applyUpdate();

    expect(result.accept).toBe(false);
    expect(result.reason).toBe("no_update");
    expect(fetchImpl.calls).toHaveLength(1); // only the offer, never the image
  });

  test("a 429 on the image is retryable and honours retry-after", async () => {
    const fixture = buildOtaFixture();
    const fetchImpl = makeFetchSpy(
      otaRouter({ offer: fixture.offer, image: new Uint8Array(0), imageStatus: 429, imageHeaders: { "retry-after": "3600" } }),
    );
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const download = await device.downloadImage(fixture.offer.update);

    expect(download.ok).toBe(false);
    expect(download.status).toBe(429);
    expect(download.kind).toBe("retry");
    expect(download.retryAfter).toBe(3600);

    // The full apply path surfaces it as a download_error and never flashes.
    const result = await device.applyUpdate();
    expect(result.accept).toBe(false);
    expect(result.reason).toBe("download_error");
  });

  test("a 404 on the image is fatal and named", async () => {
    const fixture = buildOtaFixture();
    const fetchImpl = makeFetchSpy(otaRouter({ offer: fixture.offer, image: new Uint8Array(0), imageStatus: 404 }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const download = await device.downloadImage(fixture.offer.update);

    expect(download.kind).toBe("fatal");
    expect(download.status).toBe(404);
    expect(download.error.code).toBe("image_not_found");
  });

  test("a 401 on the offer is fatal and carries the server's code", async () => {
    const fetchImpl = makeFetchSpy(otaRouter({ offer: null, image: new Uint8Array(0), offerStatus: 401 }));
    const device = createOtaDevice({ baseUrl: BASE_URL, projectToken: "bad", deviceKey: DEVICE, firmware: RUNNING_FIRMWARE, fetchImpl });

    const offer = await device.checkForUpdate();

    expect(offer.ok).toBe(false);
    expect(offer.kind).toBe("fatal");
    expect(offer.error.code).toBe("unauthorized");
  });

  test("a transport failure is a retryable network_error, not a throw", async () => {
    const device = createOtaDevice({
      baseUrl: BASE_URL,
      projectToken: TOKEN,
      deviceKey: DEVICE,
      firmware: RUNNING_FIRMWARE,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const offer = await device.checkForUpdate();

    expect(offer.ok).toBe(false);
    expect(offer.kind).toBe("retry");
    expect(offer.status).toBe(0);
    expect(offer.error.code).toBe("network_error");
    expect((await device.applyUpdate()).accept).toBe(false);
  });

  test("requires a baseUrl and a usable fetch", () => {
    expect(() => createOtaDevice({ projectToken: TOKEN })).toThrow(/baseUrl/);
    expect(() => createOtaDevice({ baseUrl: BASE_URL, fetchImpl: 42 })).toThrow(/fetchImpl/);
  });

  test("parseRetryAfter handles seconds, HTTP dates and absence", () => {
    expect(parseRetryAfter("60")).toBe(60);
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    const future = new Date(Date.now() + 120_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThanOrEqual(100);
    expect(parseRetryAfter("garbage")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Load helper                                                                */
/* -------------------------------------------------------------------------- */

describe("runLoad — publish N batches without error", () => {
  test("publishes N batches and reports every one as ok", async () => {
    const fetchImpl = makeFetchSpy(otaRouter({ offer: null, image: new Uint8Array(0) }));
    const summary = await runLoad({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, seed: 7, fetchImpl, batches: 25, batchSize: 4 });

    expect(summary.requested).toBe(25);
    expect(summary.ok).toBe(25);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(25);
    expect(fetchImpl.calls).toHaveLength(25);
    for (const call of fetchImpl.calls) {
      expect(call.url).toBe(`${BASE_URL}/v1/telemetry`);
      expect(call.method).toBe("POST");
      const body = JSON.parse(call.body);
      expect(typeof body.metrics.temp).toBe("number");
    }
    expect(typeof summary.elapsedMs).toBe("number");
  });

  test("drives a supplied simulator's publishOnce", async () => {
    const fetchImpl = makeFetchSpy(otaRouter({ offer: null, image: new Uint8Array(0) }));
    const simulator = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, seed: 1, fetchImpl });

    const summary = await runLoad({ simulator, batches: 5, batchSize: 2 });

    expect(summary.ok).toBe(5);
    expect(fetchImpl.calls).toHaveLength(5);
  });

  test("a bounded concurrency still publishes every batch exactly once", async () => {
    let concurrent = 0;
    let peak = 0;
    const spy = async (url, init) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
      return fakeResponse(204);
    };
    const simulator = createSimulator({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl: spy });

    const summary = await runLoad({ simulator, batches: 12, batchSize: 1, concurrency: 4 });

    expect(summary.ok).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // concurrency was actually exercised
  });

  test("counts failures without throwing when the uplink rejects", async () => {
    const spy = makeFetchSpy(() => fakeResponse(500));
    const summary = await runLoad({ baseUrl: BASE_URL, projectToken: TOKEN, deviceKey: DEVICE, fetchImpl: spy, batches: 3 });

    expect(summary.requested).toBe(3);
    expect(summary.ok).toBe(0);
    expect(summary.failed).toBe(3);
  });

  test("rejects a negative batch count", async () => {
    await expect(runLoad({ baseUrl: BASE_URL, projectToken: TOKEN, batches: -1 })).rejects.toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A router answering `{update:null}` for the offer (and nothing else). */
function makeFetchSpyRouterNull() {
  return (call) => {
    if (call.url === `${BASE_URL}${OTA_OFFER_PATH}`) return fakeResponse(200, { json: { update: null } });
    throw new Error(`unexpected request: ${call.url}`);
  };
}
