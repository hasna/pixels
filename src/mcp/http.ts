import { healthPayload } from "@hasna/mcp-harness";
import { handleMcpHttpRequest as handleHarnessRequest } from "@hasna/mcp-harness/bun";
import { buildPixelsMcpServer } from "./server.js";

export async function handlePixelsMcpHttpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(healthPayload("pixels"), {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (url.pathname === "/mcp") return handleHarnessRequest(request, buildPixelsMcpServer);
  return new Response("Not Found", { status: 404 });
}

export function startPixelsMcpHttpServer(options: { hostname?: string; port?: number; log?: (message: string) => void } = {}): ReturnType<typeof Bun.serve> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8892;
  const server = Bun.serve({ hostname, port, fetch: handlePixelsMcpHttpRequest });
  options.log?.(`pixels-mcp HTTP listening on http://${hostname}:${server.port}/mcp`);
  return server;
}
