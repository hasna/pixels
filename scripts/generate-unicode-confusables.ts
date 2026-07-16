import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNICODE_VERSION = "17.0.0";
const SOURCE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/security/confusables.txt`;
const SOURCE_SHA256 = "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a";
const root = join(import.meta.dir, "..");
const sourcePath = join(root, "scripts", "unicode", `confusables-${UNICODE_VERSION}.txt`);
const outputPath = join(root, "src", "generated", "unicode-confusables.ts");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceText(): Promise<string> {
  if (process.argv.includes("--refresh")) {
    const response = await fetch(SOURCE_URL, { redirect: "error" });
    if (!response.ok) throw new Error(`Unicode data download failed: HTTP ${response.status}`);
    const downloaded = await response.text();
    if (sha256(downloaded) !== SOURCE_SHA256) {
      throw new Error("Unicode data digest differs from the pinned SHA-256");
    }
    mkdirSync(join(root, "scripts", "unicode"), { recursive: true });
    writeFileSync(sourcePath, downloaded);
    return downloaded;
  }
  return readFileSync(sourcePath, "utf8");
}

function codePoints(value: string): string {
  return value.split(/\s+/).map((hex) => String.fromCodePoint(Number.parseInt(hex, 16))).join("");
}

function asciiSkeleton(value: string): string | null {
  const skeleton = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .toLowerCase();
  return /^[a-z0-9]+$/.test(skeleton) ? skeleton : null;
}

function generate(source: string): string {
  if (sha256(source) !== SOURCE_SHA256) {
    throw new Error("Vendored Unicode data digest differs from the pinned SHA-256");
  }

  const entries = new Map<number, string>();
  const asciiNormalizationAliases = new Map<string, Set<string>>();
  const nonAsciiNormalizationAliases = new Map<string, Set<string>>();
  for (const rawLine of source.split(/\r?\n/)) {
    const data = rawLine.split("#", 1)[0]?.trim();
    if (!data) continue;
    const [sourceField, targetField] = data.split(";").map((field) => field.trim());
    if (!sourceField || !targetField) continue;
    const sourceCodePoints = sourceField.split(/\s+/);
    if (sourceCodePoints.length !== 1) continue;
    const sourceCodePoint = Number.parseInt(sourceCodePoints[0]!, 16);
    if (sourceCodePoint <= 0x7f) continue;
    const sourceCharacter = String.fromCodePoint(sourceCodePoint);
    if (!/^[\p{L}\p{N}]$/u.test(sourceCharacter)) continue;
    const target = asciiSkeleton(codePoints(targetField));
    if (target) {
      entries.set(sourceCodePoint, target);
      for (const normalizationForm of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
        const normalized = sourceCharacter.normalize(normalizationForm);
        for (const caseVariant of [normalized, normalized.toLowerCase(), normalized.toUpperCase()]) {
          if (/[^\x00-\x7F]/.test(caseVariant)) {
            const targets = nonAsciiNormalizationAliases.get(caseVariant) ?? new Set<string>();
            targets.add(target);
            nonAsciiNormalizationAliases.set(caseVariant, targets);
            continue;
          }
          const asciiAlias = caseVariant
            .replace(/\p{M}+/gu, "")
            .toUpperCase()
            .toLowerCase();
          if (/^[a-z0-9]+$/.test(asciiAlias)) {
            if (asciiAlias === target) continue;
            const targets = asciiNormalizationAliases.get(asciiAlias) ?? new Set<string>();
            targets.add(target);
            asciiNormalizationAliases.set(asciiAlias, targets);
          }
        }
      }
    }
  }

  const serialized = [...entries]
    .sort(([left], [right]) => left - right)
    .map(([codePoint, skeleton]) => `${codePoint.toString(36)}\u001F${skeleton}`)
    .join("\u001E");
  const serializedAliases = [...asciiNormalizationAliases]
    .flatMap(([sourceAlias, targets]) => [...targets].map((target) => [sourceAlias, target] as const))
    .sort(([leftSource, leftTarget], [rightSource, rightTarget]) => {
      if (leftSource !== rightSource) return leftSource < rightSource ? -1 : 1;
      return leftTarget === rightTarget ? 0 : leftTarget < rightTarget ? -1 : 1;
    })
    .map(([sourceAlias, target]) => `${sourceAlias}\u001F${target}`)
    .join("\u001E");
  const serializedNonAsciiAliases = [...nonAsciiNormalizationAliases]
    .filter(([sourceAlias, targets]) => {
      const sourceCharacters = [...sourceAlias];
      if (sourceCharacters.length !== 1) return true;
      const directTarget = entries.get(sourceCharacters[0]!.codePointAt(0)!);
      return directTarget === undefined
        || targets.size > 1
        || !targets.has(directTarget);
    })
    .flatMap(([sourceAlias, targets]) => [...targets].map((target) => [sourceAlias, target] as const))
    .sort(([leftSource, leftTarget], [rightSource, rightTarget]) => {
      if (leftSource.length !== rightSource.length) return rightSource.length - leftSource.length;
      if (leftSource !== rightSource) return leftSource < rightSource ? -1 : 1;
      return leftTarget === rightTarget ? 0 : leftTarget < rightTarget ? -1 : 1;
    })
    .map(([sourceAlias, target]) => `${sourceAlias}\u001F${target}`)
    .join("\u001E");

  return `// Generated by scripts/generate-unicode-confusables.ts. Do not edit.\n`
    + `// Unicode Security Mechanisms ${UNICODE_VERSION}; source SHA-256 ${SOURCE_SHA256}.\n`
    + `// This is the browser-safe Open Pixels profile: non-ASCII letters/numbers\n`
    + `// whose UTS #39 skeleton is wholly ASCII alphanumeric. ASCII source\n`
    + `// characters are intentionally excluded so ordinary keys retain identity.\n`
    + `export const UNICODE_CONFUSABLES_VERSION = ${JSON.stringify(UNICODE_VERSION)};\n`
    + `export const UNICODE_CONFUSABLES_SOURCE_SHA256 = ${JSON.stringify(SOURCE_SHA256)};\n\n`
    + `// Records use U+001E and fields use U+001F to keep the browser artifact\n`
    + `// compact; neither separator can occur in the pinned L/N source profile.\n`
    + `export const ASCII_CONFUSABLE_SKELETON_DATA = ${JSON.stringify(serialized)};\n\n`
    + `// Compatibility normalization can erase a non-ASCII source before its\n`
    + `// official mapping is applied (for example, U+2161 -> "II" while its\n`
    + `// skeleton is "ll"). These deterministic aliases let the semantic\n`
    + `// matcher preserve that equivalence without globally rewriting ASCII.\n`
    + `export const ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA = ${JSON.stringify(serializedAliases)};\n\n`
    + `// Non-ASCII source/case/normalization forms remain attributable to the\n`
    + `// original official mapping. Multiple targets are preserved as bounded\n`
    + `// semantic alternatives instead of choosing one and losing another.\n`
    + `export const NON_ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA = ${JSON.stringify(serializedNonAsciiAliases)};\n`;
}

const generated = generate(await sourceText());
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) {
    throw new Error("Generated Unicode confusable table is stale; run bun run generate:unicode-confusables");
  }
  console.log(`verified Unicode ${UNICODE_VERSION} confusable table (${SOURCE_SHA256})`);
} else {
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  writeFileSync(outputPath, generated);
  console.log(`generated ${outputPath}`);
}
