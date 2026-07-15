import { z } from "zod";
import { PixelOrchestrator, evaluatePixelEvent } from "./orchestrator.js";
import { listProviders } from "./providers.js";
import { evaluationRequestSchema } from "./schema.js";
import type { PixelDispatcher } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface PixelsApiOptions {
  dispatcher?: PixelDispatcher;
  authorize?: (request: Request) => boolean | Promise<boolean>;
  corsOrigin?: string;
}

function responseHeaders(options: PixelsApiOptions): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...(options.corsOrigin ? { "Access-Control-Allow-Origin": options.corsOrigin, Vary: "Origin" } : {}),
  };
}

function json(value: unknown, status: number, options: PixelsApiOptions): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(options) });
}

async function readRequestJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
    throw new Error("request body exceeds 64 KiB");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("request body exceeds 64 KiB");
  }
  if (!text.trim()) throw new Error("request body must contain JSON");
  return JSON.parse(text) as unknown;
}

function invalidInput(error: unknown, options: PixelsApiOptions): Response {
  if (error instanceof z.ZodError) {
    return json({
      ok: false,
      error: "invalid_input",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }, 400, options);
  }
  return json({
    ok: false,
    error: "invalid_input",
    message: error instanceof Error ? error.message : "invalid request",
  }, 400, options);
}

export function createPixelsHttpHandler(options: PixelsApiOptions = {}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, name: "pixels", dispatchConfigured: Boolean(options.dispatcher) }, 200, options);
    }
    if (request.method === "GET" && url.pathname === "/v1/providers") {
      return json({ ok: true, providers: listProviders() }, 200, options);
    }
    if (request.method === "OPTIONS" && options.corsOrigin) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": options.corsOrigin,
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          Vary: "Origin",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/evaluate") {
      try {
        const input = evaluationRequestSchema.parse(await readRequestJson(request));
        return json({ ok: true, result: evaluatePixelEvent(input) }, 200, options);
      } catch (error) {
        return invalidInput(error, options);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/events") {
      if (!options.dispatcher || !options.authorize) {
        return json({ ok: false, error: "dispatch_not_configured" }, 503, options);
      }
      let authorized = false;
      try {
        authorized = await options.authorize(request);
      } catch {
        return json({ ok: false, error: "authorization_unavailable" }, 503, options);
      }
      if (!authorized) {
        return json({ ok: false, error: "unauthorized" }, 401, options);
      }
      try {
        const input = evaluationRequestSchema.parse(await readRequestJson(request));
        const orchestrator = new PixelOrchestrator({ policy: input.policy, providers: input.providers });
        const result = await orchestrator.dispatch({ event: input.event, consent: input.consent, signals: input.signals }, options.dispatcher);
        const publicResult = {
          ...result,
          failed: result.failed.map((failure) => ({ provider: failure.provider, message: "provider dispatch failed" })),
        };
        return json({ ok: result.failed.length === 0, result: publicResult }, result.failed.length === 0 ? 202 : 207, options);
      } catch (error) {
        return invalidInput(error, options);
      }
    }
    return json({ ok: false, error: "not_found" }, 404, options);
  };
}

export function startPixelsApi(options: PixelsApiOptions & { hostname?: string; port?: number; log?: (message: string) => void } = {}): ReturnType<typeof Bun.serve> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8891;
  const server = Bun.serve({ hostname, port, fetch: createPixelsHttpHandler(options) });
  options.log?.(`pixels API listening on http://${hostname}:${server.port}`);
  return server;
}
