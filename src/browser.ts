import { PixelOrchestrator } from "./orchestrator.js";
import { PROVIDERS } from "./providers.js";
import type {
  ConsentState,
  DispatchResult,
  PixelDispatcher,
  PixelEvent,
  PixelPolicy,
  ProviderConfig,
  RuntimeSignals,
} from "./types.js";

type MutableGlobal = typeof globalThis & Record<string, unknown>;

type MetaPixelQueue = ((...args: unknown[]) => unknown) & {
  callMethod?: (...args: unknown[]) => unknown;
  loaded: boolean;
  push: MetaPixelQueue;
  queue: unknown[][];
  version: string;
};

type TikTokRuntime = Record<string, unknown> & {
  instance?: (pixelId: string) => TikTokRuntime;
  page?: () => unknown;
  track?: (name: string, properties?: Record<string, unknown>) => unknown;
};

type TikTokQueue = unknown[] & TikTokRuntime & {
  _i: Record<string, unknown[]>;
  _o: Record<string, Record<string, unknown>>;
  _t: Record<string, number>;
  methods: string[];
  instance: (pixelId: string) => TikTokRuntime;
  setAndDefer: (target: TikTokRuntime, method: string) => void;
};

const TIKTOK_METHODS = [
  "page",
  "track",
  "identify",
  "instances",
  "debug",
  "on",
  "off",
  "once",
  "ready",
  "alias",
  "group",
  "enableCookie",
  "disableCookie",
  "holdConsent",
  "revokeConsent",
  "grantConsent",
] as const;

export interface BrowserEnvironment {
  document: Document;
  global: MutableGlobal;
  navigator: Navigator & { globalPrivacyControl?: boolean };
}

export interface BrowserPixelClientOptions {
  policy?: Partial<PixelPolicy>;
  providers?: ProviderConfig[];
  environment?: BrowserEnvironment;
}

function defaultEnvironment(): BrowserEnvironment {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    throw new Error("browser pixel dispatch requires a browser environment");
  }
  return {
    document,
    global: globalThis as MutableGlobal,
    navigator: navigator as BrowserEnvironment["navigator"],
  };
}

export function readBrowserPrivacySignals(environment?: BrowserEnvironment): RuntimeSignals {
  const resolved = environment ?? defaultEnvironment();
  const navigatorDnt = resolved.navigator.doNotTrack;
  const windowDnt = resolved.global["doNotTrack"];
  const doNotTrack = navigatorDnt === "1" || navigatorDnt === "yes" || windowDnt === "1" || windowDnt === "yes";
  return {
    globalPrivacyControl: resolved.navigator.globalPrivacyControl === true,
    doNotTrack,
  };
}

function asCallable(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return typeof value === "function" ? value as (...args: unknown[]) => unknown : undefined;
}

function ensureQueue(global: MutableGlobal, name: string): unknown[] {
  const current = global[name];
  if (Array.isArray(current)) return current;
  const queue: unknown[] = [];
  global[name] = queue;
  return queue;
}

function ensureGtag(global: MutableGlobal): (...args: unknown[]) => unknown {
  const existing = asCallable(global["gtag"]);
  if (existing) return existing;
  const dataLayer = ensureQueue(global, "dataLayer");
  const gtag = (...args: unknown[]) => dataLayer.push(args);
  global["gtag"] = gtag;
  return gtag;
}

function ensureFbq(global: MutableGlobal): (...args: unknown[]) => unknown {
  const existing = asCallable(global["fbq"]);
  if (existing) return existing;
  const fbq = function metaPixelQueue(...args: unknown[]): unknown {
    const current = metaPixelQueue as MetaPixelQueue;
    if (typeof current.callMethod === "function") {
      return current.callMethod.apply(current, args);
    }
    return current.queue.push(args);
  } as MetaPixelQueue;
  Object.assign(fbq, { queue: [], loaded: true, version: "2.0", push: fbq });
  global["fbq"] = fbq;
  global["_fbq"] = fbq;
  return fbq;
}

function ensureTikTok(global: MutableGlobal, pixelId: string): TikTokRuntime {
  global["TiktokAnalyticsObject"] = "ttq";
  const existing = global["ttq"];
  if (existing && !Array.isArray(existing) && (typeof existing === "object" || typeof existing === "function")) {
    const runtime = existing as TikTokRuntime;
    const pixelRuntime = runtime.instance?.(pixelId);
    if (!pixelRuntime) throw new Error("TikTok runtime does not expose a per-pixel instance");
    return pixelRuntime;
  }

  const queue = (Array.isArray(existing) ? existing : []) as TikTokQueue;
  queue.methods ??= [...TIKTOK_METHODS];
  queue.setAndDefer ??= (target, method) => {
    if (typeof target[method] === "function") return;
    target[method] = (...args: unknown[]) => {
      const targetQueue = Array.isArray(target) ? target : queue;
      return targetQueue.push([method, ...args]);
    };
  };
  for (const method of queue.methods) queue.setAndDefer(queue, method);

  queue._i ??= {};
  queue._o ??= {};
  queue._t ??= {};
  const pixelQueue = queue._i[pixelId] ?? [];
  for (const method of queue.methods) queue.setAndDefer(pixelQueue as unknown as TikTokRuntime, method);
  Object.assign(pixelQueue, { _u: "https://analytics.tiktok.com/i18n/pixel/events.js" });
  queue._i[pixelId] = pixelQueue;
  queue._o[pixelId] ??= {};
  queue._t[pixelId] ??= Date.now();
  queue.instance ??= (id) => (queue._i[id] ?? []) as unknown as TikTokRuntime;
  global["ttq"] = queue;
  return queue.instance(pixelId);
}

function currentTikTokInstance(global: MutableGlobal, pixelId: string): TikTokRuntime {
  const runtime = global["ttq"] as TikTokRuntime | undefined;
  const instance = runtime?.instance?.(pixelId);
  if (!instance) throw new Error("TikTok runtime does not expose a per-pixel instance");
  return instance;
}

function mappedMetaEvent(name: string): string | undefined {
  return ({
    page_view: "PageView",
    purchase: "Purchase",
    signup: "CompleteRegistration",
    lead: "Lead",
    add_to_cart: "AddToCart",
    view_content: "ViewContent",
  } as Record<string, string>)[name];
}

export class BrowserPixelDispatcher implements PixelDispatcher {
  readonly environment: BrowserEnvironment;
  readonly loadedScripts = new Map<string, Promise<void>>();
  readonly initialized = new Set<string>();

  constructor(environment?: BrowserEnvironment) {
    this.environment = environment ?? defaultEnvironment();
  }

  private loadScript(provider: ProviderConfig["provider"], src: string): Promise<void> {
    const url = new URL(src);
    if (!PROVIDERS[provider].scriptOrigins.includes(url.origin)) {
      return Promise.reject(new Error(`script origin ${url.origin} is not allowlisted for ${provider}`));
    }
    const key = `${provider}:${src}`;
    const existing = this.loadedScripts.get(key);
    if (existing) return existing;

    const present = Array.from(this.environment.document.scripts)
      .find((script) => script.dataset["openPixelsKey"] === key);
    if (present?.dataset["loaded"] === "true") return Promise.resolve();

    const script = present ?? this.environment.document.createElement("script");
    const attempt = new Promise<void>((resolve, reject) => {
      script.async = true;
      script.src = src;
      script.dataset["openPixelsKey"] = key;
      script.referrerPolicy = "strict-origin-when-cross-origin";
      script.addEventListener("load", () => {
        script.dataset["loaded"] = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`failed to load ${provider} script`)), { once: true });
      if (!present) this.environment.document.head.append(script);
    });
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      if (this.loadedScripts.get(key) === tracked) this.loadedScripts.delete(key);
      script.remove();
      throw error;
    });
    this.loadedScripts.set(key, tracked);
    return tracked;
  }

  async dispatch(provider: ProviderConfig, event: PixelEvent): Promise<void> {
    switch (provider.provider) {
      case "google-analytics": {
        const gtag = ensureGtag(this.environment.global);
        const initKey = `${provider.provider}:${provider.measurementId}`;
        if (!this.initialized.has(initKey)) {
          gtag("js", new Date());
          gtag("config", provider.measurementId, { send_page_view: false });
          this.initialized.add(initKey);
        }
        await this.loadScript(provider.provider, `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(provider.measurementId)}`);
        gtag("event", event.name, {
          ...(event.properties ?? {}),
          event_id: event.eventId,
          send_to: provider.measurementId,
        });
        return;
      }
      case "google-ads": {
        const label = provider.conversionLabels[event.name];
        if (!label) throw new Error(`no Google Ads conversion label for ${event.name}`);
        const gtag = ensureGtag(this.environment.global);
        const initKey = `${provider.provider}:${provider.conversionId}`;
        if (!this.initialized.has(initKey)) {
          gtag("config", provider.conversionId);
          this.initialized.add(initKey);
        }
        await this.loadScript(provider.provider, `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(provider.conversionId)}`);
        gtag("event", "conversion", {
          ...(event.properties ?? {}),
          event_id: event.eventId,
          send_to: `${provider.conversionId}/${label}`,
        });
        return;
      }
      case "meta": {
        const fbq = ensureFbq(this.environment.global);
        const initKey = `${provider.provider}:${provider.pixelId}`;
        if (!this.initialized.has(initKey)) {
          fbq("init", provider.pixelId);
          this.initialized.add(initKey);
        }
        await this.loadScript(provider.provider, "https://connect.facebook.net/en_US/fbevents.js");
        const mapped = mappedMetaEvent(event.name);
        fbq(
          mapped ? "trackSingle" : "trackSingleCustom",
          provider.pixelId,
          mapped ?? event.name,
          event.properties ?? {},
          { eventID: event.eventId },
        );
        return;
      }
      case "tiktok": {
        const initKey = `${provider.provider}:${provider.pixelId}`;
        ensureTikTok(this.environment.global, provider.pixelId);
        await this.loadScript(
          provider.provider,
          `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(provider.pixelId)}&lib=ttq`,
        );
        this.initialized.add(initKey);
        const ttq = currentTikTokInstance(this.environment.global, provider.pixelId);
        if (event.name === "page_view" && typeof ttq.page === "function") ttq.page();
        else if (typeof ttq.track === "function") ttq.track(event.name, event.properties ?? {});
        else throw new Error("TikTok pixel runtime cannot track events");
        return;
      }
      case "linkedin": {
        const conversionId = provider.conversionIds[event.name];
        if (!conversionId) throw new Error(`no LinkedIn conversion id for ${event.name}`);
        const url = new URL("https://px.ads.linkedin.com/collect/");
        url.searchParams.set("pid", provider.partnerId);
        url.searchParams.set("conversionId", conversionId);
        url.searchParams.set("fmt", "gif");
        const image = this.environment.document.createElement("img");
        image.width = 1;
        image.height = 1;
        image.alt = "";
        image.referrerPolicy = "strict-origin-when-cross-origin";
        image.src = url.toString();
        image.style.display = "none";
        this.environment.document.body.append(image);
        return;
      }
    }
  }
}

export class BrowserPixelClient {
  readonly orchestrator: PixelOrchestrator;
  readonly dispatcher: BrowserPixelDispatcher;

  constructor(options: BrowserPixelClientOptions = {}) {
    this.orchestrator = new PixelOrchestrator(options);
    this.dispatcher = new BrowserPixelDispatcher(options.environment);
  }

  track(event: PixelEvent, consent: ConsentState): Promise<DispatchResult> {
    return this.orchestrator.dispatch({
      event,
      consent,
      signals: readBrowserPrivacySignals(this.dispatcher.environment),
    }, this.dispatcher);
  }
}

export function createBrowserPixelClient(options: BrowserPixelClientOptions = {}): BrowserPixelClient {
  return new BrowserPixelClient(options);
}
