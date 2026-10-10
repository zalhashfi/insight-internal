export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
