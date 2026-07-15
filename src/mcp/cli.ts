#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function version(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function optionValue(args: string[], names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args: string[], name: string): string[] {
  return args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1] as string] : []);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8892;
  const port = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 through 65535");
  return port;
}

function help(): void {
  console.log(`Usage: pixels-mcp [options]

Runs the read-only policy/evaluation MCP server over stdio by default.

Options:
      --http             Serve Streamable HTTP on /mcp
      --host <hostname>  HTTP bind hostname (default: 127.0.0.1)
      --allow-origin <origin>
                         Permit an additional exact browser Origin (repeatable)
  -p, --port <port>      HTTP port (default: 8892)
  -V, --version          Show package version
  -h, --help             Show help`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return help();
  if (args.includes("--version") || args.includes("-V")) return console.log(version());

  if (args.includes("--http")) {
    const { startPixelsMcpHttpServer } = await import("./http.js");
    const hostname = optionValue(args, ["--host"]) ?? "127.0.0.1";
    const port = parsePort(optionValue(args, ["--port", "-p"]));
    const allowedOrigins = optionValues(args, "--allow-origin");
    startPixelsMcpHttpServer({ hostname, port, allowedOrigins, log: (message) => console.error(message) });
    await new Promise<never>(() => {});
  }

  const { buildPixelsMcpServer } = await import("./server.js");
  await buildPixelsMcpServer().connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(`pixels-mcp error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
