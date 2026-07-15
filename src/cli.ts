#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPixelsApi } from "./api.js";
import { evaluatePixelEvent } from "./orchestrator.js";
import { listProviders } from "./providers.js";
import { configurationSchema, evaluationRequestSchema } from "./schema.js";

function version(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function help(): void {
  console.log(`Usage: pixels <command> [options]

Consent-aware pixel policy and dispatch tooling. Dispatch is disabled by default.

Commands:
  providers                 List built-in allowlisted providers
  validate <config.json>    Validate a pixel policy and provider configuration
  evaluate <request.json>   Evaluate an event without dispatching it
  serve [options]           Serve the read/evaluate HTTP API (dispatch disabled)

Options:
      --json                Emit JSON
      --host <hostname>     API bind hostname (default: 127.0.0.1)
  -p, --port <port>         API port (default: 8891)
  -V, --version             Show package version
  -h, --help                Show help`);
}

function optionValue(args: string[], names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8891;
  const port = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 through 65535");
  return port;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    console.log(version());
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    help();
    return;
  }

  const command = args[0];
  if (command === "providers") {
    console.log(JSON.stringify({ providers: listProviders() }, null, 2));
    return;
  }
  if (command === "validate") {
    const path = args[1];
    if (!path) throw new Error("validate requires a config JSON path");
    const configuration = configurationSchema.parse(readJsonFile(path));
    console.log(JSON.stringify({ ok: true, configuration }, null, 2));
    return;
  }
  if (command === "evaluate") {
    const path = args[1];
    if (!path) throw new Error("evaluate requires a request JSON path");
    const request = evaluationRequestSchema.parse(readJsonFile(path));
    console.log(JSON.stringify({ ok: true, result: evaluatePixelEvent(request) }, null, 2));
    return;
  }
  if (command === "serve") {
    const hostname = optionValue(args, ["--host"]) ?? "127.0.0.1";
    const port = parsePort(optionValue(args, ["--port", "-p"]));
    startPixelsApi({ hostname, port, log: (message) => console.error(message) });
    console.error("Provider dispatch endpoint is fail-closed because no authorized dispatcher is configured.");
    await new Promise<never>(() => {});
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`pixels error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
