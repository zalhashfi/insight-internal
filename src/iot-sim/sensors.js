/**
 * Pure sensor / controller / GPS reading generators for the `iot-sim` device
 * simulator (ticket D01).
 *
 * Everything here is a *pure function of its inputs*: no clock reads, no
 * `Math.random()`, no module-level mutable state. Randomness arrives only
 * through an injected `random()` seam, which is what makes a run reproducible —
 * the same seed yields the same sequence, a different seed yields another one.
 *
 * The shapes emitted here are the telemetry vocabulary already fixed by the
 * wire contract (`.planning/spec.md` §6.1): flat JSON scalars keyed by variable
 * name, encoded as `{"metrics":{"temp":25.4,"ok":true}}`. The device key is
 * deliberately *not* part of a reading — per `FR-DEV-03` it travels in the
 * `x-insight-device` header, never in the body.
 */

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                    */
/* -------------------------------------------------------------------------- */

/** Multiplier / increment of the 32-bit LCG (Numerical Recipes constants). */
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;

/** Uint32 mask, so every LCG step stays in 32-bit unsigned arithmetic. */
const UINT32 = 0xffffffff;

/**
 * Build a deterministic pseudo-random generator from a seed.
 *
 * A 32-bit linear congruential generator: identical seeds always produce an
 * identical stream, across runs and machines, because it uses only integer
 * arithmetic (`>>> 0` keeps every step in uint32 space).
 *
 * The returned function also carries the properties needed by the batch
 * helpers: `next()` for a raw float in `[0, 1)`, `seed` echoing the seed it was
 * built from, and `count` counting how many values have been drawn — so two
 * generators built from the same seed can be proven to have walked in lockstep
 * without leaking internal state into the test.
 *
 * @param {number} [seed=1] Any finite number; it is coerced to a uint32.
 * @returns {{ (): number, next: () => number, seed: number, count: number }}
 */
export function createRng(seed = 1) {
  // `>>> 0` normalises negatives, floats and >32-bit values to a uint32 seed.
  const initialSeed = Number.isFinite(seed) ? Number(seed) >>> 0 : 1;
  let state = initialSeed;
  let draws = 0;

  const next = () => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    draws += 1;
    return state / 4294967296;
  };

  // A plain callable is the primary interface; the properties are additive.
  const rng = () => next();
  rng.next = next;
  rng.seed = initialSeed;
  Object.defineProperty(rng, "count", { get: () => draws });

  return rng;
}

/**
 * Coerce a readings source into a drawn-value function.
 *
 * Accepts either a generator built by {@link createRng}, a raw seed number, or
 * a hand-written `batch => readings[]` function (useful for tests that want to
 * hand the simulator an exact, fixed reading).
 *
 * @param {number|Function|undefined} source
 * @param {number} fallbackSeed Used when `source` is `undefined`.
 * @returns {Function} Invoked as `f(batch, index) -> {metrics}`.
 */
function toReadingSource(source, fallbackSeed) {
  if (typeof source === "function") return source;
  if (source === undefined || source === null) return createSensors({ seed: fallbackSeed });
  if (typeof source === "number") return createSensors({ seed: source });
  throw new TypeError("sensors must be a seed, a generator, or a function");
}

/* -------------------------------------------------------------------------- */
/* Sensors                                                                     */
/* -------------------------------------------------------------------------- */

/** Integer in `[lo, hi]` (inclusive), drawn from `rng`. */
function intBetween(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Float in `[lo, hi)` rounded to `digits` decimals, drawn from `rng`. */
function floatBetween(rng, lo, hi, digits) {
  const scale = 10 ** digits;
  return Math.round((lo + rng() * (hi - lo)) * scale) / scale;
}

/** The smallest representable step of a value rounded to `digits` decimals. */
function step(digits) {
  return 10 ** -digits;
}

/** Keep `value` inside `[lo, hi]`. */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * A 1-D random walk whose result is rounded to fixed precision.
 *
 * `state` is a plain number, which is what lets a reading be dropped straight
 * into JSON without a custom serializer.
 *
 * @param {object} [opts]
 * @param {number} [opts.initial=0]     Starting value.
 * @param {number} [opts.min=-Infinity] Lower bound (walk reflects here).
 * @param {number} [opts.max=Infinity]  Upper bound (walk reflects here).
 * @param {number} [opts.step=1]        Magnitude of one full step.
 * @param {number} [opts.digits=2]      Decimals kept on `value`.
 */
export function createRandomWalk({ initial = 0, min = -Infinity, max = Infinity, step: stepSize = 1, digits = 2 } = {}) {
  if (!Number.isFinite(initial)) throw new TypeError("initial must be finite");
  if (!Number.isFinite(stepSize) || stepSize <= 0) throw new TypeError("step must be > 0");
  // A walk with an inverted or empty window cannot move without leaving bounds.
  if (!(min < max)) throw new TypeError("requires min < max");
  let current = clamp(initial, min, max);

  return {
    /** The value most recently produced. */
    get value() {
      return current;
    },
    /**
     * Advance one step and return the new value.
     *
     * `drift` biases the direction (a slow trend), `turbulence` scales the
     * noise. Bounds are respected by *reflecting* the step that overshoots,
     * which keeps the walk away from pinning against an edge over long runs.
     *
     * @param {() => number} rng
     * @param {{ drift?: number, turbulence?: number }} [opts]
     */
    next(rng, { drift = 0, turbulence = 1 } = {}) {
      const magnitude = stepSize * turbulence * (0.5 + rng());
      const direction = rng() < 0.5 ? -1 : 1;
      let candidate = current + direction * magnitude + drift;
      if (candidate > max) candidate = max - (candidate - max);
      if (candidate < min) candidate = min + (min - candidate);
      const quantized = Math.round(candidate * 10 ** digits) / 10 ** digits;
      if (quantized > min && quantized < max) current = quantized;
      return current;
    },
  };
}

/**
 * Snap a fresh walk onto a value that is genuinely reachable from `initial`,
 * so a caller who pins `initial` to a bound still gets a walk that can move.
 */
function reachableInitial(initial, min, max, stepSize) {
  if (initial > min && initial < max) return initial;
  const inward = initial <= min ? min + stepSize : max - stepSize;
  return clamp(inward, min + Number.EPSILON, max - Number.EPSILON);
}

/**
 * Temperature sensor: a random walk around a comfortable room value.
 *
 * Defaults to ~25 °C, the figure used in the M1 demo narrative
 * (`{"metrics":{"temp":25.4}}`, `.planning/ROADMAP.md` §2).
 *
 * @param {object} [opts]
 * @param {number} [opts.initial=25] Start value; pinned to the default mean
 *   when only `mean` is given, so a re-centred sensor still starts on trend.
 * @param {number} [opts.mean=25]    Comfort value the walk reverts toward.
 * @param {number} [opts.min=15]     Floor.
 * @param {number} [opts.max=35]     Ceiling.
 * @param {number} [opts.step=0.15]  One-step magnitude.
 * @param {number} [opts.reversion=0.3] Pull strength toward `mean` (0..1).
 * @param {number} [opts.digits=2]   Decimals kept.
 * @param {string} [opts.key="temp"] Variable name in the emitted metrics.
 */
export function createTemperatureSensor({
  initial = 25,
  mean = 25,
  min = 15,
  max = 35,
  step: stepSize = 0.15,
  reversion = 0.3,
  digits = 2,
  key = "temp",
} = {}) {
  const start = reachableInitial(initial, min, max, stepSize);
  const walk = createRandomWalk({ initial: start, min, max, step: stepSize, digits });

  /** Mean reversion: the further from `mean`, the stronger the corrective drift. */
  const driftFor = (value) => (mean - value) * reversion;

  return {
    /** @returns {number} The next temperature reading. */
    read(rng) {
      return walk.next(rng, { drift: driftFor(walk.value), turbulence: 1 });
    },
    /** @returns {{ [key: string]: number }} `{ [key]: value }`. */
    sample(rng) {
      return { [key]: this.read(rng) };
    },
    /** Current reading, without advancing the walk. */
    get value() {
      return walk.value;
    },
  };
}

/**
 * Boolean "device ok" sensor: a two-state Markov chain.
 *
 * `healthyRun` / `downRun` are the number of consecutive readings spent in each
 * state, so the healthy periods are long and the outages are short — which is
 * what makes this usable as the `ok` metric in a demo.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.initial=true]  Starting state.
 * @param {number}  [opts.healthyRun=12] Readings spent healthy per cycle.
 * @param {number}  [opts.downRun=2]     Readings spent down per cycle.
 * @param {string}  [opts.key="ok"]      Variable name in the emitted metrics.
 */
export function createStatusSensor({ initial = true, healthyRun = 12, downRun = 2, key = "ok" } = {}) {
  let current = Boolean(initial);
  let remaining = healthyRun;

  return {
    /**
     * @param {() => number} _rng Kept for interface symmetry; the chain is
     *   driven by its run lengths rather than by chance, so it is stable.
     * @returns {boolean} The next status reading.
     */
    read(_rng) {
      if (remaining <= 0) {
        current = !current;
        remaining = current ? healthyRun : downRun;
      }
      remaining -= 1;
      return current;
    },
    sample(rng) {
      return { [key]: this.read(rng) };
    },
    get value() {
      return current;
    },
  };
}

/**
 * GPS sensor: a slow, correlated 2-D walk producing a `lat,lon` pair.
 *
 * Steps are expressed in metres and converted to degrees, so a caller can pick
 * a plausible walking speed without reasoning in decimal degrees.
 *
 * @param {object} [opts]
 * @param {number} [opts.lat=0]            Start latitude.
 * @param {number} [opts.lon=0]            Start longitude.
 * @param {number} [opts.stepMeters=15]    One-step ground displacement.
 * @param {number} [opts.reversion=0.1]    Pull toward the origin of the walk.
 * @param {number} [opts.digits=6]         Decimals kept (~0.11 m precision).
 * @param {string} [opts.latKey="lat"]     Latitude variable name.
 * @param {string} [opts.lonKey="lon"]     Longitude variable name.
 */
export function createGpsSensor({ lat = 0, lon = 0, stepMeters = 15, reversion = 0.1, digits = 6, latKey = "lat", lonKey = "lon" } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new TypeError("lat/lon must be finite");
  if (!Number.isFinite(stepMeters) || stepMeters <= 0) throw new TypeError("stepMeters must be > 0");

  // 1 degree of latitude is ~111.32 km; longitude shrinks with cos(latitude).
  const metersPerLatDegree = 111_320;
  const metersPerLonDegree = Math.max(metersPerLatDegree * Math.cos((lat * Math.PI) / 180), 1);
  const degreeStepLat = stepMeters / metersPerLatDegree;
  const degreeStepLon = stepMeters / metersPerLonDegree;
  const precision = 10 ** digits;

  let currentLat = lat;
  let currentLon = lon;
  // The point the walk is tethered to, so it wanders without drifting away.
  const anchorLat = lat;
  const anchorLon = lon;

  const quantize = (value) => Math.round(value * precision) / precision;

  return {
    /** @returns {{ lat: number, lon: number }} The next position. */
    read(rng) {
      const etaLat = Math.sin(2 * Math.PI * rng());
      const etaLon = Math.sin(2 * Math.PI * rng());
      currentLat = quantize(
        currentLat + degreeStepLat * etaLat + (anchorLat - currentLat) * reversion,
      );
      currentLon = quantize(
        currentLon + degreeStepLon * etaLon + (anchorLon - currentLon) * reversion,
      );
      return { lat: currentLat, lon: currentLon };
    },
    /** @returns {{ [latKey: string]: number, [lonKey: string]: number }} */
    sample(rng) {
      const { lat: nextLat, lon: nextLon } = this.read(rng);
      return { [latKey]: nextLat, [lonKey]: nextLon };
    },
    get value() {
      return { lat: currentLat, lon: currentLon };
    },
  };
}

/**
 * Controller actuator: an integer duty/output level responding to commands.
 *
 * Wired to the control channel: `set()` is what the simulator calls when a
 * command arrives over `GET /v1/control` or the WS control channel. The level
 * is clamped to `[min, max]` so an out-of-range command cannot corrupt the
 * emitted telemetry.
 *
 * @param {object} [opts]
 * @param {number} [opts.initial=0] Start level.
 * @param {number} [opts.min=0]     Lowest level.
 * @param {number} [opts.max=100]   Highest level.
 * @param {number} [opts.step=5]    One-step magnitude while free-running.
 * @param {string} [opts.key="duty"] Variable name in the emitted metrics.
 */
export function createControllerSensor({ initial = 0, min = 0, max = 100, step: stepSize = 5, key = "duty" } = {}) {
  if (!(min < max)) throw new TypeError("requires min < max");
  let current = Math.round(clamp(initial, min, max));

  return {
    /**
     * Apply an operator command (the downlink path).
     *
     * @param {unknown} level Requested level. Non-finite input is ignored.
     * @returns {number} The level actually held.
     */
    set(level) {
      const numeric = Number(level);
      if (Number.isFinite(numeric)) current = Math.round(clamp(numeric, min, max));
      return current;
    },
    /** Free-run a random step when no command is active. */
    read(rng) {
      const delta = intBetween(rng, -stepSize, stepSize);
      current = Math.round(clamp(current + delta, min, max));
      return current;
    },
    sample(rng) {
      return { [key]: this.read(rng) };
    },
    get value() {
      return current;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Batch                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic reading generator: `batch(n)` → `n` readings, each of
 * the shape `{ metrics: { ...flat scalars } }`.
 *
 * The same seed always walks the same path; a different seed walks a different
 * one. Every generator starts from the same initial conditions, so the very
 * first reading for a given `initial` is repeated across seeds (the sensors'
 * starting states are real, not random) — divergence begins at the first
 * stochastic step.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=1]            Seed for the internal RNG.
 * @param {object} [opts.sensors]           Component overrides (temperature /
 *   status / gps / controller maker options). Any key whose value is `false`
 *   disables that component.
 * @param {(rng: Function) => object} [opts.extra] Optional extra metrics hook,
 *   merged *after* the built-ins so it may intentionally override a key.
 * @returns {{ (batch?: number): Array<{ metrics: object }>, rng: Function, next: () => { metrics: object }, extend: Function }}
 */
export function createSensors({ seed = 1, sensors = {}, extra } = {}) {
  const rng = createRng(seed);
  const { temperature = {}, status = {}, gps = {}, controller = {} } = sensors;

  const temperatureSensor = temperature === false ? null : createTemperatureSensor(temperature);
  const statusSensor = status === false ? null : createStatusSensor(status);
  const gpsSensor = gps === false ? null : createGpsSensor(gps);
  const controllerSensor = controller === false ? null : createControllerSensor(controller);

  const next = () => {
    const metrics = {};
    if (temperatureSensor) Object.assign(metrics, temperatureSensor.sample(rng));
    if (statusSensor) Object.assign(metrics, statusSensor.sample(rng));
    if (gpsSensor) Object.assign(metrics, gpsSensor.sample(rng));
    if (controllerSensor) Object.assign(metrics, controllerSensor.sample(rng));
    // A null is a *legitimate* value on the wire (`spec.md` §6.1: "an honest way
    // to report a dead sensor"), so the hook is free to emit one.
    if (extra) Object.assign(metrics, extra(rng) ?? {});
    return { metrics };
  };

  const generate = (batch = 1) => {
    if (!Number.isInteger(batch) || batch < 0) throw new TypeError("batch must be a non-negative integer");
    return Array.from({ length: batch }, next);
  };

  generate.rng = rng;
  generate.next = next;
  generate.extend = (options) => createSensors({ seed, sensors, extra, ...options });
  // Exposed so a control-channel command can be applied to the actuator that
  // actually produces the `duty` metric.
  generate.controller = controllerSensor;

  return generate;
}

/**
 * Convenience wrapper: `readings(n, { seed })` → a batch of `n` readings.
 *
 * Note the batch-vs-single distinction: `readings(3)` returns an **array** of
 * three readings (the shape `publishOnce()` consumes), whereas `sensors(3)`
 * also returns an array — use `sensors()`/`next()` for one-at-a-time use.
 *
 * @param {number} [batch=1]
 * @param {object} [opts] Forwarded to {@link createSensors}.
 * @returns {Array<{ metrics: object }>}
 */
export function readings(batch = 1, opts) {
  return createSensors(opts)(batch);
}

/**
 * Default metric vocabulary, exported so the simulator (and its tests) can
 * assert against names rather than repeat string literals.
 */
export const DEFAULT_METRIC_KEYS = Object.freeze(["temp", "ok", "lat", "lon", "duty"]);
