import { describe, expect, test } from "bun:test";
import { createPixelsHttpHandler } from "./api.js";

const payload = {
  event: { name: "page_view" },
  consent: { analytics: true, advertising: false },
  policy: { enabled: true, allowedProviders: ["google-analytics"] },
  providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
};

describe("pixels API", () => {
  test("reports fail-closed dispatch state", async () => {
    const response = await createPixelsHttpHandler()(new Request("http://local/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "pixels", dispatchConfigured: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("evaluates without dispatch", async () => {
    const response = await createPixelsHttpHandler()(new Request("http://local/v1/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { accepted: boolean } };
    expect(body.result.accepted).toBeTrue();
  });

  test("keeps side-effecting event route disabled without dispatcher and auth", async () => {
    const response = await createPixelsHttpHandler()(new Request("http://local/v1/events", {
      method: "POST",
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "dispatch_not_configured" });
  });

  test("requires authorization before configured dispatch", async () => {
    let calls = 0;
    const handler = createPixelsHttpHandler({
      dispatcher: { dispatch: () => { calls += 1; } },
      authorize: () => false,
    });
    const response = await handler(new Request("http://local/v1/events", { method: "POST", body: JSON.stringify(payload) }));
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("fails closed when authorization fails", async () => {
    const response = await createPixelsHttpHandler({
      dispatcher: { dispatch: () => {} },
      authorize: () => { throw new Error("auth backend detail"); },
    })(new Request("http://local/v1/events", { method: "POST", body: JSON.stringify(payload) }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("backend detail");
  });

  test("redacts dispatcher failures from API responses", async () => {
    const response = await createPixelsHttpHandler({
      dispatcher: { dispatch: () => { throw new Error("internal provider credential detail"); } },
      authorize: () => true,
    })(new Request("http://local/v1/events", { method: "POST", body: JSON.stringify(payload) }));
    expect(response.status).toBe(207);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("provider dispatch failed");
    expect(serialized).not.toContain("credential detail");
  });

  test("rejects malformed JSON and oversized bodies", async () => {
    const handler = createPixelsHttpHandler();
    const malformed = await handler(new Request("http://local/v1/evaluate", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
    const oversized = await handler(new Request("http://local/v1/evaluate", {
      method: "POST",
      headers: { "content-length": "70000" },
      body: "{}",
    }));
    expect(oversized.status).toBe(400);
  });

  test("rejects compact PII before evaluation or authorized dispatch", async () => {
    let dispatches = 0;
    for (const properties of [
      { billingcontactphone: 15551234567 },
      { cellNumber: 15551234567 },
      { cellularNumber: 15551234567 },
      { personalName: "Ada Lovelace" },
    ]) {
      const hostilePayload = {
        ...payload,
        event: { name: "lead", properties },
      };
      const evaluateResponse = await createPixelsHttpHandler()(new Request("http://local/v1/evaluate", {
        method: "POST",
        body: JSON.stringify(hostilePayload),
      }));
      expect(evaluateResponse.status).toBe(400);

      const eventResponse = await createPixelsHttpHandler({
        authorize: () => true,
        dispatcher: { dispatch: () => { dispatches += 1; } },
      })(new Request("http://local/v1/events", {
        method: "POST",
        body: JSON.stringify(hostilePayload),
      }));
      expect(eventResponse.status).toBe(400);
    }
    expect(dispatches).toBe(0);
  });
});
