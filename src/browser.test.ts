import { describe, expect, test } from "bun:test";
import { BrowserPixelClient, BrowserPixelDispatcher, readBrowserPrivacySignals } from "./browser.js";

function fakeEnvironment(options: {
  failLoads?: number;
  onScriptLoad?: (globals: Record<string, unknown>, script: Record<string, unknown>) => void;
} = {}) {
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
          options.onScriptLoad?.(globals, script);
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
    expect(dataLayer).toContainEqual([
      "event",
      "page_view",
      { section: "news", event_id: undefined, send_to: "G-ABC12345" },
    ]);
  });

  test("rejects compact PII before the browser can bootstrap or dispatch Google Analytics", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    environment.navigator.doNotTrack = "0";
    environment.navigator.globalPrivacyControl = false;
    const client = new BrowserPixelClient({
      environment,
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
    });

    for (const properties of [
      { primarycustomername: "Ada Lovelace" },
      { cellNumber: 15551234567 },
      { cellularNumber: 15551234567 },
      { personalName: "Ada Lovelace" },
    ]) {
      await expect(client.track({
        name: "lead",
        properties,
      }, { analytics: true, advertising: false })).rejects.toThrow();
    }
    expect(scripts).toHaveLength(0);
    expect(globals["gtag"]).toBeUndefined();
    expect(globals["dataLayer"]).toBeUndefined();
  });

  test("scopes Google Analytics events when two properties share gtag", async () => {
    const { environment, globals } = fakeEnvironment();
    const first = new BrowserPixelDispatcher(environment);
    const second = new BrowserPixelDispatcher(environment);

    await first.dispatch(
      { provider: "google-analytics", enabled: true, measurementId: "G-FIRST123" },
      { name: "page_view", eventId: "first-event" },
    );
    await second.dispatch(
      { provider: "google-analytics", enabled: true, measurementId: "G-SECOND12" },
      { name: "page_view", eventId: "second-event" },
    );

    const events = (globals["dataLayer"] as unknown[][]).filter((entry) => entry[0] === "event");
    expect(events).toEqual([
      ["event", "page_view", { event_id: "first-event", send_to: "G-FIRST123" }],
      ["event", "page_view", { event_id: "second-event", send_to: "G-SECOND12" }],
    ]);
  });

  test("dispatches Google Ads only through an explicit conversion mapping", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    const dispatcher = new BrowserPixelDispatcher(environment);
    await dispatcher.dispatch(
      {
        provider: "google-ads",
        enabled: true,
        conversionId: "AW-123456",
        conversionLabels: { newsletter_signup: "SignupLabel" },
      },
      { name: "newsletter_signup", eventId: "signup-1" },
    );

    const dataLayer = globals["dataLayer"] as unknown[][];
    expect(dataLayer).toContainEqual([
      "event",
      "conversion",
      { event_id: "signup-1", send_to: "AW-123456/SignupLabel" },
    ]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.["src"]).toBe("https://www.googletagmanager.com/gtag/js?id=AW-123456");
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

  test("does not bootstrap or load Meta before advertising consent", async () => {
    const { environment, globals, scripts } = fakeEnvironment();
    const client = new BrowserPixelClient({
      environment,
      policy: { enabled: true, allowedProviders: ["meta"] },
      providers: [{ provider: "meta", enabled: true, pixelId: "123456789" }],
    });

    const result = await client.track({ name: "page_view" }, { analytics: false, advertising: false });

    expect(result.dispatched).toEqual([]);
    expect(scripts).toHaveLength(0);
    expect(globals["fbq"]).toBeUndefined();
    expect(globals["_fbq"]).toBeUndefined();
  });

  test("hands the official Meta queue to callMethod and dispatches later events", async () => {
    const runtimeCalls: unknown[][] = [];
    const { environment, globals, scripts } = fakeEnvironment({
      onScriptLoad(currentGlobals) {
        const fbq = currentGlobals["fbq"] as ((...args: unknown[]) => unknown) & {
          callMethod?: (...args: unknown[]) => unknown;
          queue: unknown[][];
        };
        const queued = [...fbq.queue];
        fbq.callMethod = (...args: unknown[]) => runtimeCalls.push(args);
        fbq.queue.length = 0;
        for (const args of queued) fbq.callMethod(...args);
      },
    });
    const dispatcher = new BrowserPixelDispatcher(environment);
    const provider = { provider: "meta", enabled: true, pixelId: "123456789" } as const;

    await dispatcher.dispatch(provider, { name: "page_view", eventId: "page-1" });
    await dispatcher.dispatch(provider, {
      name: "newsletter_signup",
      eventId: "signup-1",
      properties: { placement: "footer" },
    });

    const fbq = globals["fbq"] as ((...args: unknown[]) => unknown) & {
      loaded: boolean;
      push: unknown;
      queue: unknown[][];
      version: string;
    };
    expect(globals["_fbq"]).toBe(fbq);
    expect(fbq.push).toBe(fbq);
    expect(fbq.loaded).toBeTrue();
    expect(fbq.version).toBe("2.0");
    expect(fbq.queue).toEqual([]);
    expect(runtimeCalls).toEqual([
      ["init", provider.pixelId],
      ["trackSingle", provider.pixelId, "PageView", {}, { eventID: "page-1" }],
      ["trackSingleCustom", provider.pixelId, "newsletter_signup", { placement: "footer" }, { eventID: "signup-1" }],
    ]);
    expect(scripts).toHaveLength(1);
  });

  test("retries a failed Meta load without duplicating initialization", async () => {
    const runtimeCalls: unknown[][] = [];
    const { environment, scripts } = fakeEnvironment({
      failLoads: 1,
      onScriptLoad(globals) {
        const fbq = globals["fbq"] as ((...args: unknown[]) => unknown) & {
          callMethod?: (...args: unknown[]) => unknown;
          queue: unknown[][];
        };
        const queued = [...fbq.queue];
        fbq.callMethod = (...args: unknown[]) => runtimeCalls.push(args);
        fbq.queue.length = 0;
        for (const args of queued) fbq.callMethod(...args);
      },
    });
    const dispatcher = new BrowserPixelDispatcher(environment);
    const provider = { provider: "meta", enabled: true, pixelId: "123456789" } as const;

    await expect(dispatcher.dispatch(provider, { name: "page_view" })).rejects.toThrow("failed to load meta script");
    await dispatcher.dispatch(provider, { name: "page_view" });

    expect(runtimeCalls.filter((call) => call[0] === "init")).toHaveLength(1);
    expect(runtimeCalls.filter((call) => call[0] === "trackSingle" && call[2] === "PageView")).toHaveLength(1);
    expect(scripts).toHaveLength(1);
  });

  test("scopes Meta events when two pixels share fbq", async () => {
    const runtimeCalls: unknown[][] = [];
    const { environment } = fakeEnvironment({
      onScriptLoad(currentGlobals) {
        const fbq = currentGlobals["fbq"] as ((...args: unknown[]) => unknown) & {
          callMethod?: (...args: unknown[]) => unknown;
          queue: unknown[][];
        };
        const queued = [...fbq.queue];
        fbq.callMethod = (...args: unknown[]) => runtimeCalls.push(args);
        fbq.queue.length = 0;
        for (const args of queued) fbq.callMethod(...args);
      },
    });
    const first = new BrowserPixelDispatcher(environment);
    const second = new BrowserPixelDispatcher(environment);

    await first.dispatch({ provider: "meta", enabled: true, pixelId: "111111111" }, { name: "page_view" });
    await second.dispatch({ provider: "meta", enabled: true, pixelId: "222222222" }, { name: "lead" });

    expect(runtimeCalls.filter((call) => call[0] === "track" || call[0] === "trackCustom")).toEqual([]);
    expect(runtimeCalls.filter((call) => String(call[0]).startsWith("trackSingle"))).toEqual([
      ["trackSingle", "111111111", "PageView", {}, { eventID: undefined }],
      ["trackSingle", "222222222", "Lead", {}, { eventID: undefined }],
    ]);
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
    expect(queue._i[provider.pixelId]?.some((item) => Array.isArray(item) && item[0] === "page")).toBeTrue();
    expect(queue._i[provider.pixelId]?.some((item) => Array.isArray(item) && item[0] === "track" && item[1] === "newsletter_signup")).toBeTrue();
    expect(queue.some((item) => Array.isArray(item) && (item[0] === "page" || item[0] === "track"))).toBeFalse();
    expect(scripts).toHaveLength(1);
    expect(dispatcher.initialized.has(`tiktok:${provider.pixelId}`)).toBeTrue();
  });

  test("hands TikTok events to the loaded per-pixel runtime without global fan-out", async () => {
    const callsByPixel = new Map<string, unknown[][]>();
    const globalCalls: unknown[][] = [];
    const { environment } = fakeEnvironment({
      onScriptLoad(globals) {
        const queue = globals["ttq"] as unknown[] & {
          instance: (pixelId: string) => Record<string, unknown>;
          page?: (...args: unknown[]) => unknown;
          track?: (...args: unknown[]) => unknown;
        };
        queue.page = (...args: unknown[]) => globalCalls.push(["page", ...args]);
        queue.track = (...args: unknown[]) => globalCalls.push(["track", ...args]);
        queue.instance = (pixelId) => ({
          page: (...args: unknown[]) => {
            const calls = callsByPixel.get(pixelId) ?? [];
            calls.push(["page", ...args]);
            callsByPixel.set(pixelId, calls);
          },
          track: (...args: unknown[]) => {
            const calls = callsByPixel.get(pixelId) ?? [];
            calls.push(["track", ...args]);
            callsByPixel.set(pixelId, calls);
          },
        });
      },
    });
    const first = new BrowserPixelDispatcher(environment);
    const second = new BrowserPixelDispatcher(environment);

    await first.dispatch({ provider: "tiktok", enabled: true, pixelId: "TTPIXEL1111" }, { name: "page_view" });
    await second.dispatch({ provider: "tiktok", enabled: true, pixelId: "TTPIXEL2222" }, { name: "lead" });

    expect(globalCalls).toEqual([]);
    expect(callsByPixel.get("TTPIXEL1111")).toEqual([["page"]]);
    expect(callsByPixel.get("TTPIXEL2222")).toEqual([["track", "lead", {}]]);
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
