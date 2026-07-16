import { readFileSync } from "node:fs";

export function packageVersion(): string {
  // Bun may place this helper in a shared dist chunk. Support both the source/
  // nested-entry layout and the emitted root-chunk layout without hardcoding a version.
  for (const relativePath of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL(relativePath, import.meta.url), "utf8"),
      ) as { version?: unknown };
      if (typeof packageJson.version === "string") return packageJson.version;
    } catch {
      // Try the next supported package layout.
    }
  }
  return "0.0.0";
}
