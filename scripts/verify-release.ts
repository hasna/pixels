import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { import?: string }>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(pkg.name === "@hasna/pixels", "package name must remain @hasna/pixels");
assert(pkg.bin?.["pixels"] === "dist/cli.js", "pixels CLI bin is missing");
assert(pkg.bin?.["pixels-mcp"] === "dist/mcp/cli.js", "pixels-mcp bin is missing");
for (const path of ["dist/index.js", "dist/browser.js", "dist/api.js", "dist/cli.js", "dist/mcp/cli.js", "dist/mcp/server.js", "dist/mcp/http.js"]) {
  assert(existsSync(join(root, path)), `${path} is missing from the build`);
}
assert(pkg.exports?.["./mcp/http"]?.import === "./dist/mcp/http.js", "MCP HTTP library export is missing");

const cli = Bun.spawnSync(["bun", join(root, "dist/cli.js"), "--help"], { stdout: "pipe", stderr: "pipe" });
assert(cli.exitCode === 0, "built pixels --help failed");
const cliHelp = cli.stdout.toString();
assert(cliHelp.includes("Dispatch is disabled by default"), "CLI help must disclose fail-closed dispatch");

const mcp = Bun.spawnSync(["bun", join(root, "dist/mcp/cli.js"), "--help"], { stdout: "pipe", stderr: "pipe" });
assert(mcp.exitCode === 0, "built pixels-mcp --help failed");
assert(mcp.stdout.toString().includes("Streamable HTTP"), "MCP help must disclose Streamable HTTP mode");

const api = await import(join(root, "dist/index.js"));
for (const exported of ["PixelOrchestrator", "evaluatePixelEvent", "createBrowserPixelClient", "createPixelsHttpHandler", "listProviders"]) {
  assert(exported in api, `public export ${exported} is missing`);
}
assert(api.DEFAULT_POLICY.enabled === false, "published default policy must remain disabled");
assert(Array.isArray(api.DEFAULT_POLICY.allowedProviders) && api.DEFAULT_POLICY.allowedProviders.length === 0, "published provider allowlist must default empty");

console.log("release contract verified");
