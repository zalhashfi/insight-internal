/**
 * Offline tests for the `widget-lab` harness (ticket: widget-lab).
 *
 * The suite runs in-process with no browser, no network and no clock:
 *
 *   - the unit under test is `src/widget-lab/index.js`, which mirrors the nine
 *     widgets of the `insight` catalog without importing it;
 *   - the storage seam is the in-memory `MemoryLayoutStorage` fake, so layout
 *     persistence is exercised without `localStorage` or the filesystem.
 *
 * The assertions target the *observable contract* the task spells out:
 *
 *   1. all nine widget types are present and spelled/tagged like the catalog;
 *   2. each one binds a variable and reflects an update;
 *   3. `save → load` preserves every widget's position and size;
 *   4. everything is deterministic — the same script yields the same recording.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GRID_SPEC,
  LAYOUT_WIRE_KEYS,
  LayoutError,
  LabWidget,
  MemoryLayoutStorage,
  WIDGET_CATALOG,
  WIDGET_LAB_LAYOUT_KEY,
  WIDGET_TYPES,
  WidgetLab,
  createGridModel,
  createLabWidget,
  createWidgetLab,
  deserializeLayout,
  getWidgetDescriptor,
  layoutFromJSON,
  layoutToJSON,
  layoutsEqual,
  loadLayout,
  makeSequentialIdFactory,
  normalizeVariable,
  placeWidget,
  roundTripLayout,
  saveLayout,
  serializeLayout,
  tagFor,
  widgetsById,
} from "../src/widget-lab/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The nine kinds, spelled out independently of the module. */
const EXPECTED_TYPES = [
  "value",
  "gauge",
  "chart",
  "map",
  "toggle",
  "push",
  "slider",
  "color",
  "percent",
];

/** One update per kind, chosen so the rendered text is unambiguous. */
const UPDATE_SCRIPTS = [
  { type: "value", binding: "temperature", value: 21.5, text: "21.5" },
  { type: "gauge", binding: "humidity", value: 30, text: "30%" },
  { type: "chart", binding: "temperature", value: 19.25, text: "19.25" },
  { type: "map", binding: "location", value: [1.25, 2.5], text: "1.25, 2.5" },
  { type: "toggle", binding: "relay", value: true, text: "on" },
  { type: "push", binding: null, value: true, text: "pressed" },
  { type: "slider", binding: "setpoint", value: 42, text: "42" },
  { type: "color", binding: "led", value: "#ff8800", text: "#ff8800" },
  { type: "percent", binding: "battery", value: 40, text: "40%" },
];

/** A three-widget layout with non-trivial positions and sizes. */
const LAYOUT_SCRIPT = [
  { id: "temp", type: "value", variable: "temperature", x: 0, y: 0, w: 3, h: 2 },
  { id: "hum", type: "gauge", variable: "humidity", x: 5, y: 1, w: 4, h: 3 },
  { id: "btn", type: "push", variable: null, x: 9, y: 4, w: 2, h: 1 },
];

/** Build the scripted layout model from {@link LAYOUT_SCRIPT}. */
function scriptedLayout(spec = DEFAULT_GRID_SPEC) {
  let model = createGridModel(spec);
  for (const widget of LAYOUT_SCRIPT) model = placeWidget(model, widget);
  return model;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

describe("widget-lab — catalog", () => {
  test("enumerates exactly the nine widget types, in palette order", () => {
    expect([...WIDGET_TYPES]).toEqual(EXPECTED_TYPES);
    expect(WIDGET_TYPES).toHaveLength(9);
    expect(new Set(WIDGET_TYPES).size).toBe(9);
  });

  test("catalog has one frozen entry per type, tagged `ins-<type>`", () => {
    expect(WIDGET_CATALOG).toHaveLength(9);
    expect(WIDGET_CATALOG.map((entry) => entry.type)).toEqual(EXPECTED_TYPES);
    for (const descriptor of WIDGET_CATALOG) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.tag).toBe(`ins-${descriptor.type}`);
      expect(tagFor(descriptor.type)).toBe(descriptor.tag);
      expect(typeof descriptor.label).toBe("string");
      expect(typeof descriptor.valueKind).toBe("string");
    }
  });

  test("every type resolves by kind and by tag", () => {
    for (const type of EXPECTED_TYPES) {
      expect(getWidgetDescriptor(type)?.type).toBe(type);
      expect(getWidgetDescriptor(`ins-${type}`)?.type).toBe(type);
      expect(getWidgetDescriptor(`  INS-${type.toUpperCase()}  `)?.type).toBe(type);
    }
    expect(getWidgetDescriptor("nope")).toBeUndefined();
    expect(() => tagFor("nope")).toThrow(/unknown widget type/);
  });

  test("mirrors the insight bindings: `push` is the only unbound, non-bindable widget", () => {
    const bindable = WIDGET_CATALOG.filter((entry) => entry.bindable);
    expect(bindable).toHaveLength(8);
    const unbound = WIDGET_CATALOG.filter((entry) => entry.defaultBinding === null);
    expect(unbound.map((entry) => entry.type)).toEqual(["push"]);
    expect(getWidgetDescriptor("push").bindable).toBe(false);
    expect(getWidgetDescriptor("temperature")).toBeUndefined();
    expect(getWidgetDescriptor("value").defaultBinding).toBe("temperature");
  });

  test("normalizeVariable trims and collapses blanks to null", () => {
    expect(normalizeVariable("  temperature  ")).toBe("temperature");
    expect(normalizeVariable("   ")).toBe(null);
    expect(normalizeVariable(undefined)).toBe(null);
    expect(normalizeVariable(null)).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Binding + update, one kind at a time                                        */
/* -------------------------------------------------------------------------- */

describe("widget-lab — every widget binds and reflects an update", () => {
  test("the acceptance scripts cover all nine types exactly once", () => {
    expect(UPDATE_SCRIPTS.map((s) => s.type)).toEqual(EXPECTED_TYPES);
  });

  for (const script of UPDATE_SCRIPTS) {
    test(`${script.type}: binds a variable and reflects the update`, () => {
      const widget = createLabWidget(script.type);
      expect(widget).toBeInstanceOf(LabWidget);

      // Bound to a chosen variable (the explicit binding, not just the default).
      const chosen = script.type === "push" ? null : `lab_${script.type}`;
      widget.bind(chosen);
      expect(widget.variable).toBe(chosen);

      widget.update(script.value);

      // The reading is recorded verbatim, and the render reflects it.
      expect(widget.displayValue).toEqual(script.value);
      expect(widget.render.value).toEqual(script.value);
      expect(widget.render.text).toBe(script.text);
      expect(widget.render.reason).toBe("update");

      // Recorded history: one bind, one update, one render — nothing dropped.
      expect(widget.history.some((event) => event.kind === "bind")).toBe(true);
      const updates = widget.history.filter((event) => event.kind === "update");
      expect(updates).toHaveLength(1);
      expect(widget.history.at(-1).text).toBe(script.text);
    });
  }

  test("rebinding resets the reading and the accumulated series/markers", () => {
    const chart = createLabWidget("chart", "temperature");
    chart.update(1).update(2).update(3);
    expect(chart.points).toHaveLength(3);
    chart.bind("humidity");
    expect(chart.variable).toBe("humidity");
    // The accumulated series and the shown reading are both reset by the bind.
    expect(chart.points).toHaveLength(0);
    expect(chart.shown).toBe(null);
    expect(chart.render.reason).toBe("bind");
    expect(chart.render.text).toBe("—");
    expect(chart.render.value).toBe(null);

    const map = createLabWidget("map", "location");
    map.update([1, 2]);
    expect(map.markers).toHaveLength(1);
    map.bind("other");
    expect(map.markers).toHaveLength(0);
    expect(map.coordinates).toBe(null);
    expect(map.shown).toBe(null);
  });

  test("toggle and push start neutral (`false`) and flip on update", () => {
    const toggle = createLabWidget("toggle", "relay");
    expect(toggle.displayValue).toBe(false);
    expect(toggle.render.text).toBe("off");
    toggle.update(true);
    expect(toggle.render.text).toBe("on");
    toggle.update("off");
    expect(toggle.render.text).toBe("off");

    const button = createLabWidget("push");
    expect(button.variable).toBe(null); // push needs no variable
    expect(button.render.text).toBe("idle");
    button.press();
    expect(button.render.text).toBe("pressed");
    button.release();
    expect(button.render.text).toBe("idle");
  });

  test("chart keeps a bounded, index-stamped series", () => {
    const chart = createLabWidget("chart", "temperature", { capacity: 3 });
    for (const v of [10, 20, 30, 40]) chart.update(v);
    expect(chart.points).toEqual([
      { t: 1, v: 20 },
      { t: 2, v: 30 },
      { t: 3, v: 40 },
    ]);
    expect(chart.latest).toBe(40);
    chart.update([7, 55]);
    expect(chart.latest).toBe(55);
    expect(chart.points.at(-1)).toEqual({ t: 7, v: 55 });
  });

  test("map keeps one marker per device, latest position wins", () => {
    const map = createLabWidget("map", "location");
    map.update([1.5, 2.5]);
    expect(map.coordinates).toEqual([1.5, 2.5]);
    map.update({ device: "location", lat: -6.2, lon: 106.8 });
    expect(map.markers).toHaveLength(1);
    expect(map.coordinates).toEqual([-6.2, 106.8]);
    expect(map.render.style).toBe("marker");
  });

  test("ranged kinds clamp and normalise onto `[min, max]`", () => {
    const gauge = createLabWidget("gauge", "humidity", { min: 0, max: 100 });
    gauge.update(150);
    expect(gauge.percent).toBe(100);
    expect(gauge.numeric.value).toBe(100);
    gauge.update(-5);
    expect(gauge.percent).toBe(0);
    gauge.update(null);
    expect(gauge.percent).toBe(null);
    expect(gauge.render.text).toBe("—");

    const slider = createLabWidget("slider", "setpoint", { min: 0, max: 50 });
    slider.update(75);
    expect(slider.position).toBe(50);
    expect(slider.render.text).toBe("50");

    const percent = createLabWidget("percent", "battery", { min: 0, max: 100 });
    percent.update("25");
    expect(percent.percent).toBe(25);
    expect(percent.render.text).toBe("25%");
  });

  test("color normalises to a `#rrggbb` swatch", () => {
    const color = createLabWidget("color", "led");
    color.update("ff8800");
    expect(color.color).toBe("#ff8800");
    color.update("#0f0");
    expect(color.color).toBe("#0f0");
    color.update(255);
    expect(color.color).toBe("#0000ff");
    color.update("not-a-colour");
    expect(color.color).toBe(null);
    expect(color.render.text).toBe("—");
  });

  test("an unknown type fails loudly", () => {
    expect(() => createLabWidget("hologram")).toThrow(/unknown widget type/);
    expect(() => createLabWidget(null)).toThrow(/unknown widget type/);
  });
});

/* -------------------------------------------------------------------------- */
/* The bench                                                                   */
/* -------------------------------------------------------------------------- */

describe("widget-lab — bench registers and drives every kind", () => {
  test("createWidgetLab mounts one widget of every type, with counter ids", () => {
    const lab = createWidgetLab();
    expect(lab.ids()).toEqual(EXPECTED_TYPES.map((type) => `w-${type}`));
    expect(lab.log.filter((line) => line.kind === "register")).toHaveLength(9);
    for (const [id, widget] of lab.entries()) {
      expect(widget.type).toBe(id.slice(2));
      expect(widget.tag).toBe(`ins-${widget.type}`);
    }
  });

  test("register/bind/update records a replayable run", () => {
    const lab = new WidgetLab();
    const widget = lab.register("gauge", "hall", { variable: "humidity", min: 0, max: 100 });
    expect(widget.variable).toBe("humidity");

    lab.bind("hall", "attic_humidity");
    expect(widget.variable).toBe("attic_humidity");

    const render = lab.update("hall", 75);
    expect(render.type).toBe("gauge");
    expect(render.variable).toBe("attic_humidity");
    expect(render.text).toBe("75%");
    expect(lab.lastRender("hall")).toEqual(render);

    expect(lab.log.map((line) => line.kind)).toEqual(["register", "bind", "update"]);
    expect(lab.log[2].render.text).toBe("75%");
  });

  test("register defaults to catalog bindings and rejects duplicate/blank ids", () => {
    const lab = new WidgetLab();
    expect(lab.register("value").variable).toBe("temperature");
    expect(lab.register("push").variable).toBe(null);
    lab.register("value", "explicit", { variable: null });
    expect(lab.get("explicit").variable).toBe(null);

    expect(() => lab.register("value", "explicit")).toThrow(/duplicate widget id/);
    expect(() => lab.register("value", "  ")).toThrow(/non-empty string/);
    expect(() => lab.register("hologram")).toThrow(/unknown widget type/);
    expect(() => lab.update("ghost", 1)).toThrow(/unknown widget id/);
  });

  test("a focused bench accepts only the types it was given", () => {
    const lab = new WidgetLab({ types: ["value", "toggle"] });
    lab.register("value");
    lab.register("toggle");
    // Registered kinds pass; a kind outside the bench is refused.
    expect(lab.get("w2").type).toBe("toggle");
    expect(() => lab.register("gauge")).toThrow(/is not registered on this bench/);
    expect(() => new WidgetLab({ types: ["value", "hologram"] })).toThrow(/unknown widget type/);
  });

  test("the recording is plain JSON and serialises cleanly", () => {
    const lab = createWidgetLab();
    for (const script of UPDATE_SCRIPTS) {
      lab.update(`w-${script.type}`, script.value);
    }
    const recording = lab.recording();
    expect(recording.widgets).toHaveLength(9);
    expect(recording.types).toEqual(EXPECTED_TYPES);
    expect(() => JSON.stringify(recording)).not.toThrow();
    expect(JSON.parse(JSON.stringify(recording))).toEqual(recording);
    const gauge = recording.widgets.find((w) => w.type === "gauge");
    expect(gauge.value).toBe(30);
    expect(gauge.history.at(-1).text).toBe("30%");
  });

  test("ids are a deterministic counter (no wall clock, no RNG)", () => {
    const factory = makeSequentialIdFactory();
    expect([factory(), factory(), factory()]).toEqual(["w1", "w2", "w3"]);
    expect(makeSequentialIdFactory("lab")()).toBe("lab1");
  });

  test("the same script yields an identical recording on every run", () => {
    const runOnce = () => {
      const lab = createWidgetLab();
      for (const script of UPDATE_SCRIPTS) {
        lab.update(`w-${script.type}`, script.value);
      }
      return JSON.stringify(lab.recording());
    };
    expect(runOnce()).toBe(runOnce());
  });
});

/* -------------------------------------------------------------------------- */
/* Grid layout save / load                                                     */
/* -------------------------------------------------------------------------- */

describe("widget-lab — grid layout round-trips", () => {
  test("save → load preserves every position and size", () => {
    const model = scriptedLayout();
    const storage = new MemoryLayoutStorage();

    const { json, widgets } = saveLayout(model, { storage });
    expect(widgets).toBe(3);
    expect(storage.getItem(WIDGET_LAB_LAYOUT_KEY)).toBe(json);

    // A *fresh* reader sees exactly what was written.
    const loaded = loadLayout({ storage });
    expect(loaded).not.toBeNull();
    expect(loaded.spec).toEqual({ columns: 12, rows: 12 });
    expect(loaded.widgets).toHaveLength(3);
    expect(layoutsEqual(model, loaded)).toBe(true);

    // Position/size/variable/type survive, widget for widget.
    const byId = widgetsById(loaded);
    for (const expected of LAYOUT_SCRIPT) {
      expect(byId.get(expected.id)).toEqual(expected);
    }
    expect(byId.get("temp")).toMatchObject({ x: 0, y: 0, w: 3, h: 2, variable: "temperature" });
    expect(byId.get("hum")).toMatchObject({ x: 5, y: 1, w: 4, h: 3, variable: "humidity" });
    expect(byId.get("btn")).toMatchObject({ x: 9, y: 4, w: 2, h: 1, variable: null });
  });

  test("the serialised wire shape is exactly the seven expected keys", () => {
    const wire = serializeLayout(scriptedLayout());
    expect(Object.keys(wire)).toEqual(["version", "columns", "rows", "widgets"]);
    for (const widget of wire.widgets) {
      expect(Object.keys(widget)).toEqual([...LAYOUT_WIRE_KEYS]);
    }
    expect(wire.widgets[2].variable).toBe(null);
  });

  test("roundTripLayout reports a preserved layout, and the JSON string reloads", () => {
    const model = scriptedLayout();
    const trip = roundTripLayout(model);
    expect(trip.preserved).toBe(true);
    expect(layoutsEqual(model, trip.loaded)).toBe(true);

    const fromString = layoutFromJSON(layoutToJSON(model));
    expect(layoutsEqual(model, fromString)).toBe(true);
  });

  test("a saved layout survives a storage round-trip through its JSON text", () => {
    const storage = new MemoryLayoutStorage();
    const model = scriptedLayout();
    saveLayout(model, { storage, key: "lab.keys.two" });

    // Simulate persistence: a second, independent store holding the same text.
    const rehydrated = new MemoryLayoutStorage();
    rehydrated.setItem("lab.keys.two", storage.getItem("lab.keys.two"));
    const loaded = loadLayout({ storage: rehydrated, key: "lab.keys.two" });
    expect(layoutsEqual(model, loaded)).toBe(true);
  });

  test("load returns null when nothing was saved", () => {
    expect(loadLayout({ storage: new MemoryLayoutStorage() })).toBe(null);
  });

  test("an empty layout round-trips too", () => {
    const empty = createGridModel();
    const trip = roundTripLayout(empty);
    expect(trip.preserved).toBe(true);
    expect(trip.loaded.widgets).toEqual([]);
  });

  test("non-default canvases are preserved across the round-trip", () => {
    const model = scriptedLayout({ columns: 6, rows: 4 });
    const loaded = roundTripLayout(model).loaded;
    expect(loaded.spec).toEqual({ columns: 6, rows: 4 });
    expect(layoutsEqual(model, loaded)).toBe(true);
  });

  test("out-of-bounds placements are clamped, so a decoded layout is representable", () => {
    let model = createGridModel({ columns: 12, rows: 12 });
    model = placeWidget(model, { id: "wide", type: "chart", x: 20, y: 20, w: 99, h: 99 });
    const [widget] = model.widgets;
    expect(widget).toMatchObject({ x: 0, y: 0, w: 12, h: 12 });
    expect(roundTripLayout(model).preserved).toBe(true);

    let edge = createGridModel({ columns: 12, rows: 12 });
    edge = placeWidget(edge, { id: "edge", type: "value", x: 10, y: 10, w: 4, h: 4 });
    expect(edge.widgets[0]).toMatchObject({ x: 8, y: 8, w: 4, h: 4 });
    expect(roundTripLayout(edge).preserved).toBe(true);
  });

  test("malformed input fails loudly and specifically", () => {
    expect(() => deserializeLayout("{not json")).toThrow(LayoutError);
    expect(() => deserializeLayout("[]")).toThrow(/layout must be an object/);
    expect(() => deserializeLayout({ columns: 12, rows: 12 })).toThrow(/widgets must be an array/);
    expect(() => deserializeLayout({ widgets: [null] })).toThrow(/widget must be an object/);
    expect(() => deserializeLayout({ widgets: [{ id: "" }] })).toThrow(/non-empty string/);
    expect(() => deserializeLayout({ widgets: [{ id: "a", w: "big" }] })).not.toThrow();
    expect(() => placeWidget(createGridModel(), { id: "x", variable: 42 })).toThrow(/string or null/);
    expect(() => saveLayout(createGridModel(), { storage: {} })).toThrow(/getItem\/setItem/);
    expect(() => loadLayout({ storage: {} })).toThrow(/must implement getItem/);
  });

  test("positions and sizes are deterministic across identical empty runs", () => {
    const build = () => {
      let model = createGridModel();
      for (const widget of LAYOUT_SCRIPT) model = placeWidget(model, widget);
      return layoutToJSON(model);
    };
    expect(build()).toBe(build());
  });
});
