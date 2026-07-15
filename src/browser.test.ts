import { describe, expect, test } from "bun:test";
import { BrowserPixelClient, BrowserPixelDispatcher, readBrowserPrivacySignals } from "./browser.js";

function fakeEnvironment(options: { failLoads?: number } = {}) {
  const globals: Record<string, unknown> = {};
  const scripts: Array<Record<string, unknown>> = [];
  const images: Array<Record<string, unknown>> = [];
  let remainingFailures = options.failLoads ?? 0;
  const document = {
    scripts,
    head: {
      append(script: Record<string, unknown>) {
        scripts.push(script);
        const listeners = script["listeners"] as Record<string, () => void>;
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          listeners["error"]?.();
        } else {
          listeners["load"]?.();
        }
      },
    },
    body: { append(image: Record<string, unknown>) { images.push(image); } },
    createElement(tag: string) {
      const listeners: Record<string, () => void> = {};
      const element = {
        tag,
        dataset: {},
        style: {},
        listeners,
        addEventListener(name: string, callback: () => void) { listeners[name] = callback; },
        remove() {
          const index = scripts.indexOf(element);
          if (index >= 0) scripts.splice(index, 1);
        },
      };
      return element;
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

  test("does not bootstrap or load TikTok before advertising consent", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    const client = new BrowserPixelClient({
      environment,
      policy: { enabled: true, allowedProviders: ["tiktok"] },
      providers: [{ provider: "tiktok", enabled: true, pixelId: "TTPIXEL1234" }],
    });

    const result = await client.track({ name: "page_view" }, { analytics: false, advertising: false });

    expect(result.dispatched).toEqual([]);
    expect(scripts).toHaveLength(0);
    expect(globals["TiktokAnalyticsObject"]).toBeUndefined();
    expect(globals["ttq"]).toBeUndefined();
  });

  test("bootstraps the official TikTok queue and dispatches page and custom events once", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    const dispatcher = new BrowserPixelDispatcher(environment);
    const provider = { provider: "tiktok", enabled: true, pixelId: "TTPIXEL1234" } as const;

    await dispatcher.dispatch(provider, { name: "page_view" });
    await dispatcher.dispatch(provider, { name: "newsletter_signup", properties: { placement: "footer" } });

    expect(globals["TiktokAnalyticsObject"]).toBe("ttq");
    const queue = globals["ttq"] as unknown[] & {
      _i: Record<string, unknown[]>;
      _o: Record<string, Record<string, unknown>>;
      _t: Record<string, number>;
      instance: (pixelId: string) => Record<string, unknown>;
    };
    expect(Array.isArray(queue)).toBeTrue();
    expect(queue._i[provider.pixelId]).toBeDefined();
    expect(queue._o[provider.pixelId]).toEqual({});
    expect(typeof queue._t[provider.pixelId]).toBe("number");
    const pixelInstance = queue.instance(provider.pixelId);
    expect(typeof pixelInstance["track"]).toBe("function");
    (pixelInstance["track"] as (name: string) => unknown)("instance_event");
    expect(queue._i[provider.pixelId]?.some((item) => Array.isArray(item) && item[0] === "track" && item[1] === "instance_event")).toBeTrue();
    expect(queue.some((item) => Array.isArray(item) && item[0] === "page")).toBeTrue();
    expect(queue.some((item) => Array.isArray(item) && item[0] === "track" && item[1] === "newsletter_signup")).toBeTrue();
    expect(scripts).toHaveLength(1);
    expect(dispatcher.initialized.has(`tiktok:${provider.pixelId}`)).toBeTrue();
  });

  test("evicts a failed TikTok script load so a later dispatch can retry", async () => {
    const { environment, scripts } = fakeEnvironment({ failLoads: 1 });
    const dispatcher = new BrowserPixelDispatcher(environment);
    const provider = { provider: "tiktok", enabled: true, pixelId: "TTPIXEL1234" } as const;

    await expect(dispatcher.dispatch(provider, { name: "page_view" })).rejects.toThrow("failed to load tiktok script");
    expect(dispatcher.initialized.has(`tiktok:${provider.pixelId}`)).toBeFalse();
    await dispatcher.dispatch(provider, { name: "page_view" });

    expect(scripts).toHaveLength(1);
    expect(dispatcher.initialized.has(`tiktok:${provider.pixelId}`)).toBeTrue();
  });
});
