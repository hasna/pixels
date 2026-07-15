import { describe, expect, test } from "bun:test";
import { handlePixelsMcpHttpRequest } from "./http.js";

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
});
