import { InMemoryStatsStore, handleIngest, type StatsStore } from "./ingest";
import { handleStats } from "./stats";

export type CollectorEnv = {
  /** Injected storage seam for anonymous stats. Defaults to an in-memory store. */
  STATS_STORE?: StatsStore;
  /**
   * Bearer token gating `GET /stats` (FR-STA-02). When unset the stats route
   * is fail-closed: every request is `401`, rather than open to the world.
   */
  STATS_TOKEN?: string;
};

/** Epoch-ms clock, injectable for deterministic day/active bucketing in tests. */
export type CollectorOptions = {
  now?: () => number;
};

export default {
  async fetch(
    request: Request,
    env: CollectorEnv = {},
    _ctx?: ExecutionContext,
    options: CollectorOptions = {},
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      // No IP is ever forwarded to the store (NFR-SEC-09).
      const store = env.STATS_STORE ?? new InMemoryStatsStore(options.now);
      return handleIngest(request, store);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      // Bearer-gated read of D04's anonymous aggregate (FR-STA-02). The token
      // is checked before the store is ever consulted.
      const store = env.STATS_STORE ?? new InMemoryStatsStore(options.now);
      return handleStats(request, store, env.STATS_TOKEN, options.now?.());
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
