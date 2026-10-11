/**
 * `widget-lab` — an offline harness for the nine `insight` dashboard widgets
 * (ticket: widget-lab).
 *
 * The dashboard widget kit lives in the `insight` repo
 * (`web/src/widgets/index.ts` + `web/src/widgets/registry.ts`) and is split in
 * two layers: a pure, DOM-free `WidgetCore` carrying all the interesting
 * behaviour, and a thin `<HTMLElement>` wrapper. This module is the *third*
 * piece — a little bench on which a widget can be mounted, bound to a variable
 * and handed values, with the result recorded, **without importing the other
 * repository** and without a browser.
 *
 * Three design rules shape everything below:
 *
 *   1. **Self-contained.** Nothing here imports across repos; the nine widget
 *      kinds, their tags and their default bindings are mirrored from the
 *      `insight` catalog (see {@link WIDGET_CATALOG}) so `bun test` on this
 *      repo alone exercises the whole harness.
 *   2. **Deterministic.** No clock reads, no `Math.random()`. The chart stamps
 *      a bare reading with its series index; the id factory draws from an
 *      injected monotonic counter. The same script therefore always produces
 *      the same recording, byte for byte.
 *   3. **Observable.** Every render is appended to a history and exposed as a
 *      plain, JSON-serialisable value, so the tests assert on what a widget
 *      *did* rather than on private state.
 */

/* -------------------------------------------------------------------------- */
/* Catalog (mirrored from `insight/web/src/widgets/registry.ts`)               */
/* -------------------------------------------------------------------------- */

/** The nine widget kinds the dashboard ships, in palette order. */
export const WIDGET_TYPES = Object.freeze([
  "value",
  "gauge",
  "chart",
  "map",
  "toggle",
  "push",
  "slider",
  "color",
  "percent",
]);

/**
 * One entry of the widget catalog.
 *
 * @typedef {object} WidgetDescriptor
 * @property {string} type          Widget kind; also the catalog key.
 * @property {string} tag           Custom-element tag (`ins-<type>`).
 * @property {string} label         Human-readable palette label.
 * @property {string|null} defaultBinding Variable bound to when first placed.
 * @property {boolean} bindable     Whether the widget accepts a binding.
 * @property {string} valueKind     Shape the widget reads (`number`, `point`,
 *   `marker`, `boolean`, `string`).
 */

/**
 * The nine widgets, mirroring the `insight` catalog field for field.
 *
 * Kept in sync by hand on purpose: the harness must build on a repo with no
 * `insight` checkout, and the acceptance suite pins this order and these
 * bindings so drift shows up as a red test rather than a silent mismatch.
 *
 * @type {readonly WidgetDescriptor[]}
 */
export const WIDGET_CATALOG = Object.freeze(
  [
    {
      type: "value",
      tag: "ins-value",
      label: "Value",
      defaultBinding: "temperature",
      bindable: true,
      valueKind: "number",
    },
    {
      type: "gauge",
      tag: "ins-gauge",
      label: "Gauge",
      defaultBinding: "humidity",
      bindable: true,
      valueKind: "number",
    },
    {
      type: "chart",
      tag: "ins-chart",
      label: "Chart",
      defaultBinding: "temperature",
      bindable: true,
      valueKind: "point",
    },
    {
      type: "map",
      tag: "ins-map",
      label: "Map",
      defaultBinding: "location",
      bindable: true,
      valueKind: "marker",
    },
    {
      type: "toggle",
      tag: "ins-toggle",
      label: "Toggle",
      defaultBinding: "relay",
      bindable: true,
      valueKind: "boolean",
    },
    {
      type: "push",
      tag: "ins-push",
      label: "Push button",
      defaultBinding: null,
      bindable: false,
      valueKind: "boolean",
    },
    {
      type: "slider",
      tag: "ins-slider",
      label: "Slider",
      defaultBinding: "setpoint",
      bindable: true,
      valueKind: "number",
    },
    {
      type: "color",
      tag: "ins-color",
      label: "Colour",
      defaultBinding: "led",
      bindable: true,
      valueKind: "string",
    },
    {
      type: "percent",
      tag: "ins-percent",
      label: "Percent",
      defaultBinding: "battery",
      bindable: true,
      valueKind: "number",
    },
  ].map((entry) => Object.freeze(entry)),
);

/**
 * Look up a catalog entry by kind or by tag name.
 *
 * @param {string} key Widget kind (`"gauge"`) or tag (`"ins-gauge"`).
 * @returns {WidgetDescriptor|undefined}
 */
export function getWidgetDescriptor(key) {
  if (key === null || key === undefined) return undefined;
  const normalized = String(key).trim().toLowerCase();
  return WIDGET_CATALOG.find(
    (widget) => widget.type === normalized || widget.tag === normalized,
  );
}

/**
 * The canonical custom-element tag for a widget kind.
 *
 * @param {string} type
 * @returns {string}
 * @throws {Error} When `type` is not one of the nine kinds.
 */
export function tagFor(type) {
  const descriptor = getWidgetDescriptor(type);
  if (!descriptor) throw new Error(`unknown widget type: ${type}`);
  return descriptor.tag;
}

/**
 * Trim a variable key; blank/absent becomes `null` (meaning "unbound").
 *
 * Mirrors `normalizeVariable` from the `insight` kit so a binding recorded by
 * the lab is spelled exactly like the one the dashboard would use.
 *
 * @param {unknown} variable
 * @returns {string|null}
 */
export function normalizeVariable(variable) {
  if (variable === null || variable === undefined) return null;
  const trimmed = String(variable).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Decimal places used when formatting numeric readings (matches the kit). */
const DECIMALS = 2;

/** Clamp `n` into `[min, max]`; a non-finite `n` collapses to `min`. */
function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Coerce a reading to a finite number, else `null`. */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce a reading to a boolean, else `null`. */
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "on") return true;
    if (v === "false" || v === "0" || v === "off") return false;
  }
  return null;
}

/** Format a scalar for display; `null` renders the placeholder. */
function format(value, placeholder = "—") {
  if (value === null || value === undefined) return placeholder;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return placeholder;
    return String(Math.round(value * 10 ** DECIMALS) / 10 ** DECIMALS);
  }
  return String(value);
}

/** Normalise a numeric reading onto `[0, 1]` given the widget's range. */
function ratio(value, min, max) {
  const n = toNumber(value);
  return n === null || max <= min ? null : clamp((n - min) / (max - min), 0, 1);
}

/** Deep-ish clone of a plain value, so recorded history cannot be mutated. */
function snapshot(value) {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = snapshot(value[key]);
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Lab widgets                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One mounted widget on the bench.
 *
 * The lab widget is the DOM-free analogue of an `insight` custom element: it
 * holds a binding, holds the latest reading and computes a *render* — the tiny
 * observable payload a host would paint. {@link LabWidget#bind} and
 * {@link LabWidget#update} record into {@link LabWidget#history}, which is what
 * makes a widget's behaviour assertable.
 */
export class LabWidget {
  /**
   * @param {string} type One of {@link WIDGET_TYPES}.
   * @param {string|null} [variable] Variable to pre-bind (defaults to the
   *   catalog's `defaultBinding` when omitted entirely).
   * @param {object} [options] Kind-specific knobs (`min`/`max` for the ranged
   *   widgets, `capacity` for the chart).
   */
  constructor(type, variable, options = {}) {
    const descriptor = getWidgetDescriptor(type);
    if (!descriptor) throw new Error(`unknown widget type: ${type}`);
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }

    /** @type {string} Widget kind. */
    this.type = descriptor.type;
    /** @type {string} Canonical custom-element tag. */
    this.tag = descriptor.tag;
    /** @type {string} Palette label. */
    this.label = descriptor.label;
    /** @type {boolean} Whether this kind accepts a binding. */
    this.bindable = descriptor.bindable;
    /** @type {string} Shape of reading this kind consumes. */
    this.valueKind = descriptor.valueKind;

    /** Lower bound of the widget's range (ranged kinds only). */
    this.min = typeof options.min === "number" ? options.min : 0;
    /** Upper bound of the widget's range (ranged kinds only). */
    this.max = typeof options.max === "number" ? options.max : 100;
    /** Maximum retained chart points (chart only). */
    this.capacity = Number.isInteger(options.capacity) && options.capacity >= 1
      ? options.capacity
      : 60;

    /** @type {string|null} Currently bound variable. */
    this.variable = null;
    /** @type {Array<{t: number, v: number}>} Chart series (chart only). */
    this.points = [];
    /** @type {Array<{device: string, lat: number, lon: number}>} Markers (map). */
    this.markers = [];
    /** @type {Array<object>} Every recorded event, oldest first. */
    this.history = [];
    /** @type {object} Latest render payload, or `null` before the first one. */
    this.lastRender = null;
    /** @type {boolean} Whether an `update` has been recorded for this binding. */
    this._hasUpdate = false;
    /** @type {*} The most recent value handed to {@link LabWidget#update}. */
    this._latestUpdate = null;

    // `undefined` means "adopt the catalog default"; an explicit `null` means
    // "deliberately left unbound" (which the `push` kind needs).
    const binding =
      variable === undefined
        ? descriptor.defaultBinding
        : descriptor.bindable
          ? variable
          : null;
    this.bind(binding);
  }

  /**
   * Bind the widget to `variable`.
   *
   * Re-binding resets the reading (and any accumulated series/markers) to the
   * kind's neutral default, so a stale value can never leak across bindings —
   * the same contract the `insight` cores honour.
   *
   * @param {string|null} [variable]
   * @returns {this}
   */
  bind(variable) {
    this.variable = normalizeVariable(variable);
    this.points = [];
    this.markers = [];
    this._hasUpdate = false;
    this._latestUpdate = null;
    this._record({ kind: "bind", variable: this.variable, value: this._defaultValue() });
    this._emit("bind");
    return this;
  }

  /**
   * Show a new reading.
   *
   * The reading is always recorded and always reflected — an ignored update is
   * a failure — and the render payload is appended to {@link LabWidget#history}.
   *
   * @param {*} value Scalar, `[t, v]` / `{t, v}` chart point, or `[lat, lon]` /
   *   `{lat, lon}` map marker, per the kind's {@link LabWidget#valueKind}.
   * @returns {this}
   */
  update(value) {
    if (this.valueKind === "point") this._pushPoint(value);
    else if (this.valueKind === "marker") this._pushMarker(value);
    this._record({ kind: "update", variable: this.variable, value: snapshot(value) });
    this._emit("update");
    return this;
  }

  /** Record a press on a momentary `push` widget (`update(true)`). */
  press() {
    return this.update(true);
  }

  /** Clear a press on a momentary `push` widget (`update(false)`). */
  release() {
    return this.update(false);
  }

  /**
   * The value as displayed: exactly what the last `update` was given, or the
   * kind's neutral default (a boolean widget starts `false`, every other kind
   * starts `null`) before any update.
   */
  get displayValue() {
    const last = this.history.filter((event) => event.kind === "update").at(-1);
    return last ? last.value : this._defaultValue();
  }

  /** Index of the newest render in {@link LabWidget#history}, or `-1`. */
  _lastRenderIndex() {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].text !== undefined) return i;
    }
    return -1;
  }

  /**
   * The newest render recorded *at or after* the most recent binding.
   *
   * A `bind` resets the reading, so a render recorded before it belongs to the
   * previous binding and must be ignored — this is the widget's own view of
   * "what do I show right now".
   *
   * @returns {object|null}
   */
  get render() {
    let lastBind = -1;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].kind === "bind") { lastBind = i; break; }
    }
    const index = this._lastRenderIndex();
    return index >= 0 && index > lastBind ? this.history[index] : null;
  }

  /** What this widget is showing: the value of {@link LabWidget#render}. */
  get shown() {
    const render = this.render;
    if (!render) return this._defaultValue();
    return render.value === null || render.value === undefined
      ? render.value ?? this._defaultValue()
      : render.value;
  }

  /** The neutral value shown before any update. */
  _defaultValue() {
    return this.type === "toggle" || this.type === "push" ? false : null;
  }

  /** Append a `bind`/`update` event to {@link LabWidget#history}. */
  _record(event) {
    this.history.push(Object.freeze({ ...event, seq: this.history.length }));
    if (event.kind === "update") {
      this._latestUpdate = event.value;
      this._hasUpdate = true;
    }
  }

  /** Compute the render payload for the current state and record it. */
  _emit(reason) {
    // The reading to show: the latest recorded update, or the kind's neutral
    // default (a boolean widget starts `false`, everything else `null`).
    // `bind` clears `_hasUpdate`, so a stale pre-bind reading can never leak
    // into the render for the new binding.
    const neutral = this.type === "toggle" || this.type === "push" ? false : null;
    const value = this._hasUpdate ? snapshot(this._latestUpdate) : neutral;
    const render = Object.freeze({
      seq: this.history.length,
      reason,
      type: this.type,
      tag: this.tag,
      variable: this.variable,
      value,
      text: this._text(),
      style: this._style(),
    });
    this.history.push(render);
    this.lastRender = render;
    return render;
  }

  /** The human-readable reading, per kind. */
  _text() {
    if (this.type === "chart") {
      const latest = this.latest;
      return latest === null ? "—" : format(latest);
    }
    if (this.type === "map") {
      const coordinates = this.coordinates;
      return coordinates ? `${format(coordinates[0])}, ${format(coordinates[1])}` : "—";
    }
    if (this.type === "toggle") return this._state() ? "on" : "off";
    if (this.type === "push") return this.displayValue === true ? "pressed" : "idle";

    const value = this.displayValue;
    if (this.type === "gauge" || this.type === "percent") {
      const pct = this.percent;
      return pct === null ? "—" : `${pct}%`;
    }
    if (this.type === "slider") {
      const position = this.position;
      return position === null ? "—" : format(position);
    }
    if (this.type === "color") {
      const hex = this.color;
      return hex === null ? "—" : hex;
    }
    return format(value);
  }

  /** The colour/style hint for the current reading, or `null`. */
  _style() {
    if (this.type === "chart") return `series:${this.points.length}`;
    if (this.type === "map") return this.coordinates ? "marker" : null;
    if (this.type === "toggle") return this._state() ? "on" : "off";
    if (this.type === "push") return this.displayValue === true ? "pressed" : "idle";
    if (this.type === "gauge" || this.type === "percent") {
      const pct = this.percent;
      return pct === null ? null : `${pct}%`;
    }
    if (this.type === "slider") {
      const position = this.position;
      return position === null ? null : String(position);
    }
    if (this.type === "color") return this.color;
    return null;
  }

  /** Boolean state of the `toggle`/`push` kinds. */
  _state() {
    return toBoolean(this.displayValue) ?? false;
  }

  /** The newest chart reading, or `null` while the series is empty. */
  get latest() {
    const last = this.points.at(-1);
    return last ? last.v : null;
  }

  /** The latest marker the map is showing, or `null`. */
  get marker() {
    if (this.variable === null) return undefined;
    return this.markers.find((m) => m.device === this.variable);
  }

  /** Coordinates of the last marker received, as `[lat, lon]`, or `null`. */
  get coordinates() {
    const m = this.marker ?? this.markers.at(-1);
    return m ? [m.lat, m.lon] : null;
  }

  /** Ranged numeric reading: `{min, max, raw, value, ratio, percent}`. */
  get numeric() {
    const raw = toNumber(this.displayValue);
    if (raw === null) {
      return { min: this.min, max: this.max, raw: null, value: null, ratio: null, percent: null };
    }
    const r = ratio(raw, this.min, this.max) ?? 0;
    return {
      min: this.min,
      max: this.max,
      raw,
      value: clamp(raw, this.min, this.max),
      ratio: Math.round(r * 1000) / 1000,
      percent: Math.round(r * 100),
    };
  }

  /** Percent reading as a 0–100 integer, or `null`. */
  get percent() {
    return ratio(this.displayValue, this.min, this.max) === null
      ? null
      : this.numeric.percent;
  }

  /** Slider set-point clamped into range, or `null`. */
  get position() {
    const n = toNumber(this.displayValue);
    return n === null ? null : clamp(n, this.min, this.max);
  }

  /** Colour reading as a CSS `#rrggbb`/`#rgb`, or `null` when invalid. */
  get color() {
    const value = this.displayValue;
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
      return `#${clamp(Math.round(value), 0, 0xffffff).toString(16).padStart(6, "0")}`;
    }
    const raw = String(value).trim();
    if (raw === "") return null;
    return /^#?[0-9a-f]{3,8}$/i.test(raw) ? (raw.startsWith("#") ? raw : `#${raw}`) : null;
  }

  /** Append a chart point; a bare number is stamped with the series index. */
  _pushPoint(value) {
    let point = null;
    if (typeof value === "number" && Number.isFinite(value)) {
      point = { t: this.points.length, v: value };
    } else if (Array.isArray(value) && value.length >= 2) {
      const [t, v] = value;
      if (Number.isFinite(t) && Number.isFinite(v)) point = { t, v };
    } else if (value && typeof value === "object") {
      if (Number.isFinite(value.t) && Number.isFinite(value.v)) {
        point = { t: value.t, v: value.v };
      }
    }
    if (point) {
      this.points.push(point);
      while (this.points.length > this.capacity) this.points.shift();
    }
  }

  /** Append/refresh a map marker; the bound variable names the device. */
  _pushMarker(value) {
    const device = this.variable ?? "unknown";
    let marker = null;
    if (Array.isArray(value) && value.length >= 2) {
      const [lat, lon] = value;
      if (Number.isFinite(lat) && Number.isFinite(lon)) marker = { device, lat, lon };
    } else if (value && typeof value === "object") {
      if (Number.isFinite(value.lat) && Number.isFinite(value.lon)) {
        marker = { device: value.device ?? device, lat: value.lat, lon: value.lon };
      }
    }
    if (!marker) return;
    const i = this.markers.findIndex((m) => m.device === marker.device);
    if (i >= 0) this.markers[i] = marker;
    else this.markers.push(marker);
  }
}

/**
 * Mount a widget on the bench.
 *
 * @param {string} type One of {@link WIDGET_TYPES}.
 * @param {string|null} [variable] Variable to bind; omitted → the catalog
 *   default, explicit `null` → left unbound.
 * @param {object} [options] Kind-specific knobs (`min`, `max`, `capacity`).
 * @returns {LabWidget}
 */
export function createLabWidget(type, variable, options) {
  return new LabWidget(type, variable, options);
}

/* -------------------------------------------------------------------------- */
/* The bench                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A widget bench: a registry of mounted widgets plus the script of readings
 * they have been handed.
 *
 * The lab is deliberately dumb — it mounts, binds, feeds and records; it holds
 * no clock and no RNG, so replaying the same calls always yields the same
 * recording.
 */
export class WidgetLab {
  /**
   * @param {object} [options]
   * @param {readonly string[]} [options.types] Kinds to accept. Defaults to the
   *   whole catalog; a smaller set makes a focused bench.
   * @param {() => string} [options.idFactory] Seam for widget ids. The default
   *   is a counter (`w1`, `w2`, …) — deterministic by construction.
   */
  constructor({ types = WIDGET_TYPES, idFactory } = {}) {
    /** @type {readonly string[]} Kinds this bench accepts. */
    this.types = Object.freeze([...types]);
    for (const type of this.types) {
      if (!getWidgetDescriptor(type)) throw new Error(`unknown widget type: ${type}`);
    }
    /** @type {() => string} */
    this.idFactory =
      typeof idFactory === "function" ? idFactory : makeSequentialIdFactory();
    /** @type {Map<string, LabWidget>} */
    this.widgets = new Map();
    /** @type {Array<object>} */
    this.log = [];
  }

  /**
   * Register (mount) a widget.
   *
   * @param {string} type One of {@link WIDGET_TYPES}.
   * @param {string} [id] Explicit id; a counter id is minted when omitted.
   * @param {object} [options] Kind-specific knobs (`variable`, `min`, `max`,
   *   `capacity`). `variable` omitted → catalog default; `variable: null` →
   *   unbound.
   * @returns {LabWidget}
   */
  register(type, id, options = {}) {
    const descriptor = getWidgetDescriptor(type);
    if (!descriptor) throw new Error(`unknown widget type: ${type}`);
    if (!this.types.includes(descriptor.type)) {
      throw new Error(`widget type "${descriptor.type}" is not registered on this bench`);
    }
    const widget = createLabWidget(descriptor.type, options.variable, options);
    const wid = id ?? this.idFactory();
    if (typeof wid !== "string" || wid.trim() === "") {
      throw new Error("widget id must be a non-empty string");
    }
    if (this.widgets.has(wid)) throw new Error(`duplicate widget id: ${wid}`);
    this.widgets.set(wid, widget);
    this._emit({ kind: "register", id: wid, type: widget.type, variable: widget.variable });
    return widget;
  }

  /** Mount one widget of every kind in the catalog, in palette order. */
  registerAll(options = {}) {
    for (const descriptor of WIDGET_CATALOG) {
      const id = options.ids?.[descriptor.type] ?? `w-${descriptor.type}`;
      this.register(descriptor.type, id, options[descriptor.type] ?? {});
    }
    return this;
  }

  /**
   * Bind an already-registered widget to `variable` and record it.
   *
   * @param {string} id
   * @param {string|null} variable
   * @returns {LabWidget}
   */
  bind(id, variable) {
    const widget = this._get(id);
    widget.bind(variable);
    this._emit({ kind: "bind", id, variable: widget.variable });
    return widget;
  }

  /**
   * Hand a reading to a registered widget and record the render.
   *
   * @param {string} id
   * @param {*} value Scalar, chart point or map marker.
   * @returns {object} The widget's render payload.
   */
  update(id, value) {
    const widget = this._get(id);
    widget.update(value);
    const render = widget.render;
    this._emit({
      kind: "update",
      id,
      variable: widget.variable,
      value: snapshot(value),
      render: snapshot(render),
    });
    return render;
  }

  /** A registered widget, or `undefined`. */
  get(id) {
    return this.widgets.get(id);
  }

  /** The render the widget is showing now (at or after its last bind). */
  lastRender(id) {
    const widget = this.widgets.get(id);
    return widget ? widget.render : null;
  }

  /** Every registered widget, in registration order. */
  entries() {
    return [...this.widgets.entries()];
  }

  /** The ids currently registered, in registration order. */
  ids() {
    return [...this.widgets.keys()];
  }

  /** The whole run as a plain, JSON-serialisable object. */
  recording() {
    return {
      types: [...this.types],
      widgets: this.entries().map(([id, widget]) => ({
        id,
        type: widget.type,
        tag: widget.tag,
        variable: widget.variable,
        value: widget.displayValue,
        history: widget.history.map(snapshot),
      })),
      log: this.log.map(snapshot),
    };
  }

  _get(id) {
    const widget = this.widgets.get(id);
    if (!widget) throw new Error(`unknown widget id: ${id}`);
    return widget;
  }

  /** Append one line to {@link WidgetLab#log}. */
  _emit(event) {
    this.log.push(Object.freeze({ ...event, seq: this.log.length }));
  }
}

/**
 * Build a deterministic id factory: `w1`, `w2`, … in call order.
 *
 * @param {string} [prefix="w"]
 * @returns {() => string}
 */
export function makeSequentialIdFactory(prefix = "w") {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/**
 * Mount a bench and register one widget of every kind.
 *
 * @param {object} [options] Passed through to {@link WidgetLab} /
 *   {@link WidgetLab#registerAll}.
 * @returns {WidgetLab}
 */
export function createWidgetLab(options) {
  return new WidgetLab(options).registerAll(options);
}

/* -------------------------------------------------------------------------- */
/* Grid layout save / load                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One placed widget in a saved layout.
 *
 * @typedef {object} LayoutWidget
 * @property {string} id
 * @property {string} type
 * @property {string|null} variable
 * @property {number} x Left column, 0-based.
 * @property {number} y Top row, 0-based.
 * @property {number} w Width in cells, `>= 1`.
 * @property {number} h Height in cells, `>= 1`.
 */

/** Canvas geometry of {@link DEFAULT_GRID_SPEC}. */
export const DEFAULT_GRID_SPEC = Object.freeze({ columns: 12, rows: 12 });

/** The seven wire keys, in order — shared by save and load. */
export const LAYOUT_WIRE_KEYS = Object.freeze([
  "id",
  "type",
  "variable",
  "x",
  "y",
  "w",
  "h",
]);

/** Thrown when a layout cannot be decoded. */
export class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutError";
  }
}

/** A fresh, empty layout model on the given spec. */
export function createGridModel(spec = DEFAULT_GRID_SPEC) {
  return {
    spec: { columns: spec.columns ?? DEFAULT_GRID_SPEC.columns, rows: spec.rows ?? DEFAULT_GRID_SPEC.rows },
    widgets: [],
  };
}

/** Integer coercion, or `null` when not an integer. */
function toInteger(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Append a widget to a layout model, clamped into the canvas and kept at
 * `>= 1 × >= 1`.
 *
 * Positions/sizes that would fall off the edge are pulled back inside rather
 * than rejected, so a decoded layout is always representable — and a round-trip
 * therefore always compares equal.
 *
 * @param {object} model
 * @param {object} widget `{id, type, variable?, x?, y?, w?, h?}`.
 * @returns {object} A new model; the input is not mutated.
 */
export function placeWidget(model, widget) {
  if (!widget || typeof widget !== "object") {
    throw new LayoutError("widget must be an object");
  }
  if (typeof widget.id !== "string" || widget.id.trim() === "") {
    throw new LayoutError("widget id must be a non-empty string");
  }
  const type = widget.type === undefined ? "value" : widget.type;
  if (typeof type !== "string" || type.trim() === "") {
    throw new LayoutError("widget type must be a non-empty string");
  }
  if (typeof widget.variable !== "string" && widget.variable !== null && widget.variable !== undefined) {
    throw new LayoutError("widget variable must be a string or null");
  }

  const { columns, rows } = model.spec;
  const w = Math.min(Math.max(toInteger(widget.w) ?? 1, 1), columns);
  const h = Math.min(Math.max(toInteger(widget.h) ?? 1, 1), rows);
  const x = clamp(toInteger(widget.x) ?? 0, 0, columns - w);
  const y = clamp(toInteger(widget.y) ?? 0, 0, rows - h);

  const placed = {
    id: widget.id,
    type,
    variable: normalizeVariable(widget.variable),
    x,
    y,
    w,
    h,
  };
  return { spec: model.spec, widgets: [...model.widgets, placed] };
}

/** The layout as wire JSON (`{columns, rows, widgets:[…]}`). */
export function serializeLayout(model) {
  if (!model || !Array.isArray(model.widgets)) {
    throw new LayoutError("model must be a grid model");
  }
  return {
    version: 1,
    columns: model.spec.columns,
    rows: model.spec.rows,
    widgets: model.widgets.map((widget) =>
      Object.fromEntries(LAYOUT_WIRE_KEYS.map((key) => [key, widget[key]])),
    ),
  };
}

/**
 * Decode wire JSON (or its string form) back into a layout model.
 *
 * @param {object|string} input The object from {@link serializeLayout}, or the
 *   JSON string of it (e.g. what came out of storage).
 * @returns {object} A layout model equal to the one that was saved.
 * @throws {LayoutError} On malformed input.
 */
export function deserializeLayout(input) {
  let wire = input;
  if (typeof wire === "string") {
    try {
      wire = JSON.parse(wire);
    } catch {
      throw new LayoutError("layout is not valid JSON");
    }
  }
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) {
    throw new LayoutError("layout must be an object");
  }
  if (!Array.isArray(wire.widgets)) throw new LayoutError("layout.widgets must be an array");

  let model = createGridModel({ columns: wire.columns, rows: wire.rows });
  for (const entry of wire.widgets) {
    if (!entry || typeof entry !== "object") {
      throw new LayoutError("layout widget must be an object");
    }
    model = placeWidget(model, entry);
  }
  return model;
}

/** `serializeLayout` to a compact JSON string. */
export function layoutToJSON(model) {
  return JSON.stringify(serializeLayout(model));
}

/** `deserializeLayout` from a JSON string produced by {@link layoutToJSON}. */
export function layoutFromJSON(text) {
  return deserializeLayout(text);
}

/** Structural equality of two layouts, widget order included. */
export function layoutsEqual(a, b) {
  if (!a || !b) return false;
  if (a.spec.columns !== b.spec.columns || a.spec.rows !== b.spec.rows) return false;
  if (a.widgets.length !== b.widgets.length) return false;
  return a.widgets.every((widget, i) => {
    const other = b.widgets[i];
    return LAYOUT_WIRE_KEYS.every((key) => widget[key] === other[key]);
  });
}

/** A layout's widgets keyed by id, for order-independent assertions. */
export function widgetsById(model) {
  return new Map(model.widgets.map((widget) => [widget.id, widget]));
}

/**
 * Where a layout is saved; the seam a test fakes and a browser backs with
 * `localStorage`.
 *
 * @typedef {object} LayoutStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} [removeItem]
 */

/** Default storage key written by {@link saveLayout}. */
export const WIDGET_LAB_LAYOUT_KEY = "insight.widget-lab.layout.v1";

/** An in-memory {@link LayoutStorage} — the test fake, and the lab default. */
export class MemoryLayoutStorage {
  /** @type {Map<string, string>} */
  _entries = new Map();

  getItem(key) {
    return this._entries.has(key) ? this._entries.get(key) : null;
  }

  setItem(key, value) {
    this._entries.set(key, String(value));
  }

  removeItem(key) {
    this._entries.delete(key);
  }

  clear() {
    this._entries.clear();
  }

  get size() {
    return this._entries.size;
  }
}

/**
 * Persist a layout, preserving every widget's position and size.
 *
 * @param {object} model
 * @param {object} [options]
 * @param {LayoutStorage} [options.storage] Defaults to a fresh in-memory store.
 * @param {string} [options.key] Defaults to {@link WIDGET_LAB_LAYOUT_KEY}.
 * @returns {{storage: LayoutStorage, key: string, json: string, widgets: number}}
 */
export function saveLayout(model, { storage = new MemoryLayoutStorage(), key = WIDGET_LAB_LAYOUT_KEY } = {}) {
  if (!storage || typeof storage.setItem !== "function" || typeof storage.getItem !== "function") {
    throw new LayoutError("storage must implement getItem/setItem");
  }
  const json = layoutToJSON(model);
  storage.setItem(key, json);
  return { storage, key, json, widgets: model.widgets.length };
}

/**
 * Restore a layout previously written by {@link saveLayout}.
 *
 * @param {object} [options] Same `storage`/`key` as {@link saveLayout}.
 * @returns {object|null} The layout model, or `null` when nothing was saved.
 */
export function loadLayout({ storage = new MemoryLayoutStorage(), key = WIDGET_LAB_LAYOUT_KEY } = {}) {
  if (!storage || typeof storage.getItem !== "function") {
    throw new LayoutError("storage must implement getItem");
  }
  const json = storage.getItem(key);
  return json === null ? null : layoutFromJSON(json);
}

/**
 * Save a layout, then read it back from the same storage — the round-trip the
 * acceptance suite pins.
 *
 * @param {object} model
 * @param {object} [options] Same `storage`/`key` as {@link saveLayout}.
 * @returns {{json: string, saved: object, loaded: object, preserved: boolean}}
 */
export function roundTripLayout(model, options = {}) {
  const { json, storage, key } = saveLayout(model, options);
  const loaded = loadLayout({ storage, key });
  return { json, saved: serializeLayout(model), loaded, preserved: layoutsEqual(model, loaded) };
}

/** Default export: the catalog, so `import catalog from …` reads naturally. */
export default WIDGET_CATALOG;
