import { describe, expect, test } from "bun:test";

import worker from "../src/index";

describe("GET /", () => {
  test("returns 200 with { ok: true }", async () => {
    const response = await worker.fetch(new Request("https://collector.local/"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });
});
