import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixelsHttpHandler } from "./api.js";
import { BrowserPixelClient } from "./browser.js";
import { buildPixelsMcpServer } from "./mcp/server.js";
import { evaluatePixelEvent } from "./orchestrator.js";
import { independentUnicodeConfusableCorpus } from "../test/unicode-confusable-corpus.js";

const provider = {
  provider: "google-analytics" as const,
  enabled: true,
  measurementId: "G-ABC12345",
};

function request(properties: Record<string, unknown>) {
  return {
    event: { name: "lead", properties },
    consent: { analytics: true, advertising: false },
    policy: { enabled: true, allowedProviders: ["google-analytics" as const] },
    providers: [provider],
  };
}

function immediateBrowserEnvironment() {
  const scripts: unknown[] = [];
  const images: unknown[] = [];
  const globals: Record<string, unknown> = {};
  return {
    scripts,
    images,
    globals,
    environment: {
      document: {
        scripts,
        head: {
          append(value: Record<string, unknown>) {
            scripts.push(value);
            (value["listeners"] as Record<string, () => void> | undefined)?.["load"]?.();
          },
        },
        body: { append(value: unknown) { images.push(value); } },
        createElement() {
          const listeners: Record<string, () => void> = {};
          return {
            dataset: {},
            style: {},
            listeners,
            addEventListener(name: string, callback: () => void) { listeners[name] = callback; },
            remove() {},
          };
        },
      } as unknown as Document,
      global: globals as typeof globalThis & Record<string, unknown>,
      navigator: { doNotTrack: "0", globalPrivacyControl: false } as unknown as Navigator & {
        globalPrivacyControl?: boolean;
      },
    },
  };
}

describe("A6 alias streaming regressions", () => {
  test("independently composes every official ASCII alias with sensitive semantics", () => {
    const corpus = independentUnicodeConfusableCorpus();
    expect(corpus.officialAsciiNormalizationAliases).toHaveLength(15);
    expect(corpus.officialAsciiNormalizationSensitiveKeys).toHaveLength(34);
    expect(Math.min(...corpus.officialAsciiNormalizationSensitiveKeys.map((key) => key.length))).toBeGreaterThan(18);

    const misses: string[] = [];
    for (const key of corpus.officialAsciiNormalizationSensitiveKeys) {
      try {
        evaluatePixelEvent(request({ [key]: 15551234567 }));
        misses.push(key);
      } catch {
        // Expected fail-closed classification.
      }
    }
    expect(misses).toEqual([]);
  });

  test("fails alias-dense cold requests during linear work metering without starving timers", async () => {
    const handler = createPixelsHttpHandler();
    const keys = Array.from({ length: 5 }, (_, index) =>
      `${"iv".repeat(29)}${index.toString(36)}`.slice(0, 64));
    const timerStarted = performance.now();
    let timerDelay = Number.POSITIVE_INFINITY;
    const timer = new Promise<void>((resolve) => setTimeout(() => {
      timerDelay = performance.now() - timerStarted;
      resolve();
    }, 0));
    const started = performance.now();
    const responses = await Promise.all(keys.map((key) => handler(new Request("http://local/v1/evaluate", {
      method: "POST",
      body: JSON.stringify(request({ [key]: "metadata" })),
    }))));
    await timer;
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
    expect(performance.now() - started).toBeLessThan(250);
    expect(timerDelay).toBeLessThan(100);
  });

  test("blocks every long alias composition across browser, API, CLI, and MCP with no effects", async () => {
    const hostileKeys = independentUnicodeConfusableCorpus().officialAsciiNormalizationSensitiveKeys;
    const browser = immediateBrowserEnvironment();
    const browserClient = new BrowserPixelClient({
      environment: browser.environment,
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [provider],
    });
    for (const key of hostileKeys) {
      await expect(browserClient.track({ name: "lead", properties: { [key]: 15551234567 } }, {
        analytics: true,
        advertising: false,
      })).rejects.toThrow();
    }
    expect(browser.scripts).toHaveLength(0);
    expect(browser.images).toHaveLength(0);
    expect(browser.globals["dataLayer"]).toBeUndefined();

    let apiDispatches = 0;
    const api = createPixelsHttpHandler({
      authorize: () => true,
      dispatcher: { dispatch() { apiDispatches += 1; } },
    });
    for (const key of hostileKeys) {
      const response = await api(new Request("http://local/v1/events", {
        method: "POST",
        body: JSON.stringify(request({ [key]: 15551234567 })),
      }));
      expect(response.status).toBe(400);
    }
    expect(apiDispatches).toBe(0);

    const directory = mkdtempSync(join(tmpdir(), "pixels-a6-alias-cli-"));
    try {
      for (const [index, key] of hostileKeys.entries()) {
        const requestPath = join(directory, `${index}.json`);
        writeFileSync(requestPath, JSON.stringify(request({ [key]: 15551234567 })));
        const cli = Bun.spawn([process.execPath, "run", "src/cli.ts", "evaluate", requestPath], {
          cwd: import.meta.dir + "/..",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          cli.exited,
          new Response(cli.stdout).text(),
          new Response(cli.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("direct personal information");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const server = buildPixelsMcpServer();
    const client = new Client({ name: "pixels-a6-alias-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const key of hostileKeys) {
        const result = await client.callTool({
          name: "pixels_evaluate_event",
          arguments: request({ [key]: 15551234567 }),
        });
        expect(result.isError).toBeTrue();
        expect(result.structuredContent).toBeUndefined();
      }
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }, 180_000);

  test("preserves every official alias in long safe telecom and multilingual controls", async () => {
    const corpus = independentUnicodeConfusableCorpus();
    expect(corpus.officialAsciiNormalizationSafeTelecomKeys).toHaveLength(26);
    const safeCases = [
      ...corpus.officialAsciiNormalizationSafeTelecomKeys.map((key) => [key, "carrier metadata"] as const),
      ...corpus.officialAsciiNormalizationAliases.map((_, index) =>
        [`περιοχή_δικτύου_${index}`, "Αθήνα"] as const),
    ];
    expect(safeCases).toHaveLength(41);
    for (const [key, value] of safeCases) {
      expect(() => evaluatePixelEvent(request({ [key]: value }))).not.toThrow();
    }

    const browser = immediateBrowserEnvironment();
    const browserClient = new BrowserPixelClient({
      environment: browser.environment,
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [provider],
    });
    for (const [key, value] of safeCases) {
      const browserResult = await browserClient.track({ name: "page_view", properties: { [key]: value } }, {
        analytics: true,
        advertising: false,
      });
      expect(browserResult.dispatched).toEqual(["google-analytics"]);
    }
    expect(browser.scripts).toHaveLength(1);

    let apiDispatches = 0;
    const api = createPixelsHttpHandler({
      authorize: () => true,
      dispatcher: { dispatch() { apiDispatches += 1; } },
    });
    for (const [key, value] of safeCases) {
      const evaluateResponse = await api(new Request("http://local/v1/evaluate", {
        method: "POST",
        body: JSON.stringify(request({ [key]: value })),
      }));
      expect(evaluateResponse.status).toBe(200);
      const eventResponse = await api(new Request("http://local/v1/events", {
        method: "POST",
        body: JSON.stringify(request({ [key]: value })),
      }));
      expect(eventResponse.status).toBe(202);
    }
    expect(apiDispatches).toBe(safeCases.length);

    const directory = mkdtempSync(join(tmpdir(), "pixels-a6-safe-cli-"));
    try {
      for (const [index, [key, value]] of safeCases.entries()) {
        const requestPath = join(directory, `${index}.json`);
        writeFileSync(requestPath, JSON.stringify(request({ [key]: value })));
        const cli = Bun.spawn([process.execPath, "run", "src/cli.ts", "evaluate", requestPath], {
          cwd: import.meta.dir + "/..",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          cli.exited,
          new Response(cli.stdout).text(),
          new Response(cli.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout).result.accepted).toBeTrue();
        expect(stderr).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const server = buildPixelsMcpServer();
    const client = new Client({ name: "pixels-a6-safe-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const [key, value] of safeCases) {
        const result = await client.callTool({
          name: "pixels_evaluate_event",
          arguments: request({ [key]: value }),
        });
        expect(result.isError).not.toBeTrue();
        expect((result.structuredContent as { result?: { accepted?: boolean } }).result?.accepted).toBeTrue();
      }
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }, 180_000);
});
