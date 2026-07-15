import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixelsHttpHandler } from "./api.js";
import { BrowserPixelClient } from "./browser.js";
import { buildPixelsMcpServer } from "./mcp/server.js";
import { PixelOrchestrator, evaluatePixelEvent } from "./orchestrator.js";
import {
  independentUnicodeConfusableCorpus,
  PINNED_UNICODE_CONFUSABLES_SHA256,
} from "../test/unicode-confusable-corpus.js";

const ga = { provider: "google-analytics" as const, enabled: true, measurementId: "G-ABC12345" };

function request(properties: Record<string, unknown>) {
  return {
    event: { name: "lead", properties },
    consent: { analytics: true, advertising: false },
    policy: { enabled: true, allowedProviders: ["google-analytics" as const] },
    providers: [ga],
  };
}

function generatedHostileSamples(): string[] {
  const corpus = independentUnicodeConfusableCorpus();
  const official = corpus.officialHostileKeys;
  const indexes = [0, Math.floor(official.length / 3), Math.floor(official.length * 2 / 3), official.length - 1];
  return [...new Set(indexes.map((index) => official[index]!).concat(corpus.conservativeWildcardKeys[0]!))];
}

function browserEnvironment() {
  const scripts: unknown[] = [];
  const images: unknown[] = [];
  const globals: Record<string, unknown> = {};
  return {
    scripts,
    images,
    globals,
    environment: {
      document: {
        head: { append(value: unknown) { scripts.push(value); } },
        body: { append(value: unknown) { images.push(value); } },
        createElement() {
          return { dataset: {}, style: {}, addEventListener() {}, remove() {} };
        },
      } as unknown as Document,
      global: globals as typeof globalThis & Record<string, unknown>,
      navigator: { doNotTrack: "0", globalPrivacyControl: false } as unknown as Navigator & { globalPrivacyControl?: boolean },
    },
  };
}

describe("pinned Unicode privacy boundary", () => {
  test("independently generates a broad official and conservative corpus with no core dispatch", async () => {
    const corpus = independentUnicodeConfusableCorpus();
    expect(corpus.sourceSha256).toBe(PINNED_UNICODE_CONFUSABLES_SHA256);
    expect(corpus.officialHostileKeys.length).toBeGreaterThan(900);
    expect(corpus.conservativeWildcardKeys.length).toBe(192);

    const orchestrator = new PixelOrchestrator({
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [ga],
    });
    let dispatches = 0;
    const started = performance.now();
    let index = 0;
    for (const key of [...corpus.officialHostileKeys, ...corpus.conservativeWildcardKeys]) {
      const leaf = { [key]: 15551234567 };
      const properties = index % 3 === 0 ? leaf : index % 3 === 1 ? { profile: leaf } : { records: [leaf] };
      index += 1;
      expect(() => evaluatePixelEvent(request(properties))).toThrow();
      await expect(orchestrator.dispatch(request(properties), {
        dispatch() { dispatches += 1; },
      })).rejects.toThrow();
    }
    expect(dispatches).toBe(0);
    expect(performance.now() - started).toBeLessThan(8_000);
  });

  test("preserves pure multilingual and safe mixed telecom metadata", () => {
    const corpus = independentUnicodeConfusableCorpus();
    const properties: Record<string, string> = {
      "région_du_réseau": "Europe",
      "περιοχή_δικτύου": "Αθήνα",
      "регион_сети": "София",
      "περιοχή2026": "Αθήνα",
      "регион2": "София",
      "日本語3": "metadata",
      "cellular_οrganization": "Opérateur réseau",
      "сellular_app": "lector",
    };
    for (const key of corpus.pureMultilingualKeys.slice(0, 40)) properties[key] = "metadata";
    expect(() => evaluatePixelEvent(request(properties))).not.toThrow();
    expect(corpus.safeMixedTelecomKeys.length).toBeGreaterThan(250);
    for (const key of corpus.safeMixedTelecomKeys) {
      expect(() => evaluatePixelEvent(request({ [key]: "carrier metadata" }))).not.toThrow();
    }
  });

  test("bounds wildcard work for the maximum property-key length", () => {
    const key = `a${"Ж".repeat(63)}`;
    const started = performance.now();
    expect(() => evaluatePixelEvent(request({ [key]: "metadata" }))).not.toThrow();
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("blocks independently generated keys before browser, API, CLI, and MCP effects", async () => {
    const samples = generatedHostileSamples();

    const browser = browserEnvironment();
    const browserClient = new BrowserPixelClient({
      environment: browser.environment,
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [ga],
    });
    for (const key of samples) {
      await expect(browserClient.track({ name: "lead", properties: { [key]: 15551234567 } }, {
        analytics: true,
        advertising: false,
      })).rejects.toThrow();
    }
    expect(browser.scripts).toHaveLength(0);
    expect(browser.images).toHaveLength(0);
    expect(browser.globals["dataLayer"]).toBeUndefined();

    let apiDispatches = 0;
    const handler = createPixelsHttpHandler({
      authorize: () => true,
      dispatcher: { dispatch() { apiDispatches += 1; } },
    });
    for (const key of samples) {
      const response = await handler(new Request("http://local/v1/events", {
        method: "POST",
        body: JSON.stringify(request({ [key]: 15551234567 })),
      }));
      expect(response.status).toBe(400);
    }
    expect(apiDispatches).toBe(0);

    const cliKey = samples[0]!;
    const cliDirectory = mkdtempSync(join(tmpdir(), "pixels-unicode-cli-"));
    try {
      const requestPath = join(cliDirectory, "request.json");
      writeFileSync(requestPath, JSON.stringify(request({ [cliKey]: 15551234567 })));
      const cli = Bun.spawn([
        process.execPath,
        "run",
        "src/cli.ts",
        "evaluate",
        requestPath,
      ], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("direct personal information");
    } finally {
      rmSync(cliDirectory, { recursive: true, force: true });
    }

    const server = buildPixelsMcpServer();
    const client = new Client({ name: "unicode-boundary-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const key of samples) {
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
  });
});
