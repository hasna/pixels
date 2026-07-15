import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, PixelOrchestrator, evaluatePixelEvent } from "./orchestrator.js";
import type { EvaluationRequest, ProviderConfig } from "./types.js";

const ga: ProviderConfig = { provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" };
const meta: ProviderConfig = { provider: "meta", enabled: true, pixelId: "123456789" };

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    event: { name: "page_view", properties: { section: "news" } },
    consent: { analytics: true, advertising: true },
    providers: [ga, meta],
    ...overrides,
  };
}

describe("evaluatePixelEvent", () => {
  test("is disabled and empty-allowlist by default", () => {
    expect(DEFAULT_POLICY.enabled).toBeFalse();
    expect(DEFAULT_POLICY.allowedProviders).toEqual([]);
    const output = evaluatePixelEvent(request());
    expect(output.accepted).toBeFalse();
    expect(output.decisions.every((decision) => decision.reason === "platform_disabled")).toBeTrue();
  });

  test("allows only explicitly allowlisted providers with purpose consent", () => {
    const output = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      consent: { analytics: true, advertising: false },
    }));
    expect(output.decisions).toEqual([
      { provider: "google-analytics", purpose: "analytics", allowed: true, reason: "allowed" },
      { provider: "meta", purpose: "advertising", allowed: false, reason: "consent_missing" },
    ]);
  });

  test("privacy signals override granted consent", () => {
    const gpc = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      signals: { globalPrivacyControl: true },
    }));
    expect(gpc.decisions.every((decision) => decision.reason === "global_privacy_control")).toBeTrue();

    const dnt = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      signals: { doNotTrack: true },
    }));
    expect(dnt.decisions.every((decision) => decision.reason === "do_not_track")).toBeTrue();
  });

  test("requires configured conversion mappings", () => {
    const output = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-ads", "linkedin"] },
      providers: [
        { provider: "google-ads", enabled: true, conversionId: "AW-123456", conversionLabels: {} },
        { provider: "linkedin", enabled: true, partnerId: "12345", conversionIds: {} },
      ],
    }));
    expect(output.decisions.every((decision) => decision.reason === "provider_event_unmapped")).toBeTrue();
  });

  test("rejects direct PII property names and duplicate providers", () => {
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { email: "person@example.test" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "person@example.test" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "+15551234567" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ providers: [ga, ga] }))).toThrow();
  });

  test("rejects unknown keys and over-broad property maps", () => {
    const properties = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`field_${index}`, index]));
    expect(() => evaluatePixelEvent(request({ event: { name: "wide", properties } }))).toThrow();
    expect(() => evaluatePixelEvent({ ...request(), extra: true } as EvaluationRequest)).toThrow();
  });
});

describe("PixelOrchestrator", () => {
  test("freezes policy and provider configuration after validation", () => {
    const orchestrator = new PixelOrchestrator({
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [ga],
    });
    expect(Object.isFrozen(orchestrator.policy)).toBeTrue();
    expect(Object.isFrozen(orchestrator.policy.allowedProviders)).toBeTrue();
    expect(Object.isFrozen(orchestrator.providers)).toBeTrue();
    expect(Object.isFrozen(orchestrator.providers[0])).toBeTrue();
    expect(() => orchestrator.policy.allowedProviders.push("meta")).toThrow();
  });

  test("dispatches allowed providers and contains provider failures", async () => {
    const orchestrator = new PixelOrchestrator({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      providers: [ga, meta],
    });
    const result = await orchestrator.dispatch({
      event: { name: "page_view" },
      consent: { analytics: true, advertising: true },
    }, {
      dispatch(provider) {
        if (provider.provider === "meta") throw new Error("test failure");
      },
    });
    expect(result.dispatched).toEqual(["google-analytics"]);
    expect(result.failed).toEqual([{ provider: "meta", message: "test failure" }]);
  });
});
