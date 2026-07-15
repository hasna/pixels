import { isIP } from "node:net";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readBoundedRequestBody } from "../http-body.js";
import { buildPixelsMcpServer } from "./server.js";

export interface PixelsMcpHttpOptions {
  allowedOrigins?: readonly string[];
  authorize?: (request: Request) => boolean | Promise<boolean>;
  bodyReadTimeoutMs?: number;
}

export interface PixelsMcpHttpServerOptions extends PixelsMcpHttpOptions {
  hostname?: string;
  port?: number;
  log?: (message: string) => void;
}

export interface PixelsMcpHttpServer {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): void;
}

const MAX_MCP_HTTP_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function securityResponse(status: number, error: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: error }, id: null }, {
    status,
    headers: SECURITY_HEADERS,
  });
}

async function requestWithBoundedBody(
  request: Request,
  timeoutMs: number | undefined,
): Promise<Request | Response> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: MAX_MCP_HTTP_BODY_BYTES,
    timeoutMs,
  });
  if (!bounded.ok) return securityResponse(bounded.status, bounded.message);
  if (request.body === null) return request;
  const headers = new Headers(request.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(bounded.body.byteLength));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bounded.body.buffer.slice(
      bounded.body.byteOffset,
      bounded.body.byteOffset + bounded.body.byteLength,
    ) as ArrayBuffer,
    signal: request.signal,
  });
}

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname).toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return false;
}

function normalizeConfiguredOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password || parsed.origin === "null") return undefined;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function originAllowed(origin: string | null, configured: readonly string[]): boolean {
  if (origin === null) return true;
  const normalized = normalizeConfiguredOrigin(origin);
  if (!normalized) return false;
  const parsed = new URL(normalized);
  if (isLoopbackHostname(parsed.hostname)) return true;
  return configured.some((allowed) => normalizeConfiguredOrigin(allowed) === normalized);
}

export async function handlePixelsMcpHttpRequest(
  request: Request,
  options: PixelsMcpHttpOptions = {},
): Promise<Response> {
  if (request.signal.aborted) return securityResponse(408, "request aborted");
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", name: "pixels" }, {
      headers: SECURITY_HEADERS,
    });
  }
  if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
  if (!originAllowed(request.headers.get("origin"), options.allowedOrigins ?? [])) {
    return securityResponse(403, "origin not allowed");
  }
  if (options.authorize) {
    try {
      if (!await options.authorize(request)) return securityResponse(401, "unauthorized");
    } catch {
      return securityResponse(503, "authorization unavailable");
    }
  }

  try {
    const boundedRequest = await requestWithBoundedBody(request, options.bodyReadTimeoutMs);
    if (boundedRequest instanceof Response) return boundedRequest;
    const server = buildPixelsMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return await transport.handleRequest(boundedRequest);
  } catch {
    return securityResponse(500, "internal server error");
  }
}

export function startPixelsMcpHttpServer(options: PixelsMcpHttpServerOptions = {}): PixelsMcpHttpServer {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8892;
  if (!isLoopbackHostname(hostname) && !options.authorize) {
    throw new Error("non-loopback MCP HTTP binding requires an explicit authorize policy");
  }
  const server = Bun.serve({ hostname, port, fetch: (request) => handlePixelsMcpHttpRequest(request, options) });
  options.log?.(`pixels-mcp HTTP listening on http://${hostname}:${server.port}/mcp`);
  return server;
}
