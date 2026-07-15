import { describe, expect, test } from "bun:test";
import { listProviders, PROVIDERS } from "./providers.js";
import { PROVIDER_IDS } from "./types.js";

describe("provider definitions", () => {
  test("keeps exported provider invariants deeply immutable", () => {
    expect(Object.isFrozen(PROVIDER_IDS)).toBeTrue();
    expect(Object.isFrozen(PROVIDERS)).toBeTrue();
    for (const definition of Object.values(PROVIDERS)) {
      expect(Object.isFrozen(definition)).toBeTrue();
      expect(Object.isFrozen(definition.scriptOrigins)).toBeTrue();
    }

    expect(() => (PROVIDER_IDS as unknown as string[]).push("other")).toThrow();
    expect(() => (PROVIDERS.meta.scriptOrigins as string[]).push("https://evil.example")).toThrow();
  });

  test("returns mutable copies without exposing canonical origin arrays", () => {
    const providers = listProviders();
    const meta = providers.find((provider) => provider.id === "meta");
    expect(meta).toBeDefined();
    (meta?.scriptOrigins as string[]).push("https://consumer.example");

    expect(PROVIDERS.meta.scriptOrigins).toEqual(["https://connect.facebook.net"]);
  });
});
