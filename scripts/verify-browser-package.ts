import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pixels-browser-consumer-"));

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

try {
  const archiveDirectory = join(temporaryRoot, "archive");
  const packageRoot = join(temporaryRoot, "node_modules", "@hasna", "pixels");
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });

  const packResult = JSON.parse(run([
    "npm",
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    archiveDirectory,
  ])) as Array<{ filename?: unknown }>;
  const archiveName = packResult[0]?.filename;
  if (typeof archiveName !== "string" || archiveName.length === 0) {
    throw new Error("npm pack did not return a structured archive name");
  }
  run(["tar", "-xzf", join(archiveDirectory, archiveName), "-C", packageRoot, "--strip-components=1"]);

  // A normal npm consumer installs declared runtime dependencies beside the package.
  // Reuse the frozen local dependency graph so this gate is deterministic and offline.
  symlinkSync(realpathSync(join(root, "node_modules", "zod")), join(temporaryRoot, "node_modules", "zod"), "dir");

  const entry = join(temporaryRoot, "entry.mjs");
  const output = join(temporaryRoot, "bundle.mjs");
  writeFileSync(entry, [
    'import { createBrowserPixelClient } from "@hasna/pixels/browser";',
    "globalThis.__openPixelsBrowserExport = createBrowserPixelClient;",
  ].join("\n"));

  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
  });

  const bundled = readFileSync(output, "utf8");
  if (/node:(?:net|fs|path|url)|from\s*["'](?:net|fs|path|url)["']/.test(bundled)) {
    throw new Error("packed browser export contains a Node built-in import");
  }
  const bundleBytes = statSync(output).size;
  // Exact pre-UTS39 PR baseline: 587446 bytes. The pinned table adds 4.7%;
  // leave a narrow ceiling so future data or dependency growth is reviewed.
  if (bundleBytes > 620_000) {
    throw new Error(`packed browser export exceeds the 620000-byte safety budget: ${bundleBytes}`);
  }
  console.log(`packed browser export bundles with standard esbuild browser platform (${bundleBytes} bytes)`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
