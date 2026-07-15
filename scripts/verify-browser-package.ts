import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

  const archiveName = run(["npm", "pack", "--ignore-scripts", "--pack-destination", archiveDirectory])
    .trim()
    .split("\n")
    .at(-1);
  if (!archiveName) throw new Error("npm pack did not return an archive name");
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
  console.log("packed browser export bundles with standard esbuild browser platform");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
