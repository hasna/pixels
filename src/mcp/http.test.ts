import { describe, expect, test } from "bun:test";
import { handlePixelsMcpHttpRequest, startPixelsMcpHttpServer } from "./http.js";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pixels-http-test", version: "1.0.0" },
  },
});

function initializeRequest(origin?: string): Request {
  return new Request("http://127.0.0.1:8892/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: initializeBody,
  });
}

describe("MCP HTTP transport", () => {
  test("exposes health and only the /mcp route", async () => {
    const health = await handlePixelsMcpHttpRequest(new Request("http://local/health"));
    expect(health.status).toBe(200);
    const body = await health.json() as { status: string; name: string };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("pixels");

    const missing = await handlePixelsMcpHttpRequest(new Request("http://local/other"));
    expect(missing.status).toBe(404);
  });

  test("rejects unapproved browser origins before invoking MCP", async () => {
    const response = await handlePixelsMcpHttpRequest(initializeRequest("https://evil.example"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const malformed = await handlePixelsMcpHttpRequest(initializeRequest("https://console.example/path"), {
      allowedOrigins: ["https://console.example"],
    });
    expect(malformed.status).toBe(403);
  });

  test("permits local, configured, and no-Origin clients", async () => {
    const [local, configured, noOrigin] = await Promise.all([
      handlePixelsMcpHttpRequest(initializeRequest("http://localhost:3000")),
      handlePixelsMcpHttpRequest(initializeRequest("https://console.example"), {
        allowedOrigins: ["https://console.example"],
      }),
      handlePixelsMcpHttpRequest(initializeRequest()),
    ]);
    expect(local.status).toBe(200);
    expect(configured.status).toBe(200);
    expect(noOrigin.status).toBe(200);
  });

  test("supports two concurrent no-Origin MCP clients", async () => {
    const responses = await Promise.all([
      handlePixelsMcpHttpRequest(initializeRequest()),
      handlePixelsMcpHttpRequest(initializeRequest()),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  test("rejects declared and streamed bodies over the transport budget", async () => {
    const declared = initializeRequest();
    declared.headers.set("content-length", String(2 * 1024 * 1024));
    const declaredResponse = await handlePixelsMcpHttpRequest(declared);
    expect(declaredResponse.status).toBe(413);

    const oversizedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "x".repeat(70 * 1024), version: "1.0.0" },
      },
    });
    const streamedResponse = await handlePixelsMcpHttpRequest(new Request("http://127.0.0.1:8892/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: oversizedBody,
    }));
    expect(streamedResponse.status).toBe(413);
  });

  test("fails closed when HTTP authentication rejects or is unavailable", async () => {
    const rejected = await handlePixelsMcpHttpRequest(initializeRequest(), { authorize: () => false });
    expect(rejected.status).toBe(401);
    const unavailable = await handlePixelsMcpHttpRequest(initializeRequest(), {
      authorize: () => { throw new Error("private backend detail"); },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private backend detail");
  });

  test("does not authorize or initialize a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    let authorizationCalls = 0;
    const base = initializeRequest();
    const aborted = new Request(base, { signal: controller.signal });

    const response = await handlePixelsMcpHttpRequest(aborted, {
      authorize: () => {
        authorizationCalls += 1;
        return true;
      },
    });

    expect(response.status).toBe(408);
    expect(authorizationCalls).toBe(0);
  });

  test("refuses non-loopback binding without an explicit authentication policy", () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      expect(() => {
        server = startPixelsMcpHttpServer({ hostname: "0.0.0.0", port: 0 });
      }).toThrow("non-loopback MCP HTTP binding requires an explicit authorize policy");
    } finally {
      server?.stop(true);
    }
  });
});
