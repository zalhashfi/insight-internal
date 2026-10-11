import { InMemoryStatsStore, handleIngest, type StatsStore } from "./ingest";

export type CollectorEnv = {
  /** Injected storage seam for anonymous stats. Defaults to an in-memory store. */
  STATS_STORE?: StatsStore;
};

export default {
  async fetch(request: Request, env: CollectorEnv = {}): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      // No IP is ever forwarded to the store (NFR-SEC-09).
      const store = env.STATS_STORE ?? new InMemoryStatsStore();
      return handleIngest(request, store);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;
