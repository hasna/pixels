import { describe, expect, test } from "bun:test";
import { BrowserPixelDispatcher, readBrowserPrivacySignals } from "./browser.js";

function fakeEnvironment() {
  const globals: Record<string, unknown> = {};
  const scripts: Array<Record<string, unknown>> = [];
  const images: Array<Record<string, unknown>> = [];
  const document = {
    scripts,
    head: {
      append(script: Record<string, unknown>) {
        scripts.push(script);
        const listeners = script["listeners"] as Record<string, () => void>;
        listeners["load"]?.();
      },
    },
    body: { append(image: Record<string, unknown>) { images.push(image); } },
    createElement(tag: string) {
      const listeners: Record<string, () => void> = {};
      return {
        tag,
        dataset: {},
        style: {},
        listeners,
        addEventListener(name: string, callback: () => void) { listeners[name] = callback; },
      };
    },
  };
  return {
    environment: {
      document: document as unknown as Document,
      global: globals as typeof globalThis & Record<string, unknown>,
      navigator: { doNotTrack: "1", globalPrivacyControl: true } as unknown as Navigator & { globalPrivacyControl?: boolean },
    },
    globals,
    scripts,
    images,
  };
}

describe("browser dispatcher", () => {
  test("reads browser privacy signals", () => {
    const { environment } = fakeEnvironment();
    expect(readBrowserPrivacySignals(environment)).toEqual({ globalPrivacyControl: true, doNotTrack: true });
  });

  test("uses a fixed allowlisted Google script and queues an event", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    const dispatcher = new BrowserPixelDispatcher(environment);
    await dispatcher.dispatch(
      { provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" },
      { name: "page_view", properties: { section: "news" } },
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.["src"]).toBe("https://www.googletagmanager.com/gtag/js?id=G-ABC12345");
    const dataLayer = globals["dataLayer"] as unknown[][];
    expect(dataLayer.some((entry) => entry[0] === "event" && entry[1] === "page_view")).toBeTrue();
  });

  test("generates LinkedIn conversion beacons only from mapped ids", async () => {
    const { environment, images } = fakeEnvironment();
    const dispatcher = new BrowserPixelDispatcher(environment);
    await dispatcher.dispatch(
      { provider: "linkedin", enabled: true, partnerId: "12345", conversionIds: { lead: "67890" } },
      { name: "lead" },
    );
    expect(images).toHaveLength(1);
    expect(String(images[0]?.["src"])).toStartWith("https://px.ads.linkedin.com/collect/");
  });
});
