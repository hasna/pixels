import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PINNED_UNICODE_CONFUSABLES_SHA256 = "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a";

const sourcePath = join(import.meta.dir, "..", "scripts", "unicode", "confusables-17.0.0.txt");

interface IndependentCorpus {
  readonly sourceSha256: string;
  readonly officialHostileKeys: readonly string[];
  readonly officialNormalizationHostileKeys: readonly string[];
  readonly conservativeWildcardKeys: readonly string[];
  readonly pureMultilingualKeys: readonly string[];
  readonly safeMixedTelecomKeys: readonly string[];
  readonly safeNormalizationTelecomKeys: readonly string[];
}

let cachedCorpus: IndependentCorpus | undefined;

function normalizedAsciiTarget(value: string): string | null {
  const target = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .toLowerCase();
  return /^[a-z0-9]+$/.test(target) ? target : null;
}

/**
 * Independently parses the pinned upstream text rather than importing the
 * production generated table. This prevents a table-generation omission from
 * silently shrinking the adversarial corpus.
 */
export function independentUnicodeConfusableCorpus(): IndependentCorpus {
  if (cachedCorpus) return cachedCorpus;
  const source = readFileSync(sourcePath, "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const mappings = new Map<string, string>();

  for (const rawLine of source.split(/\r?\n/)) {
    const data = rawLine.split("#", 1)[0]?.trim();
    if (!data) continue;
    const [sourceField, targetField] = data.split(";").map((field) => field.trim());
    if (!sourceField || !targetField) continue;
    const sourcePoints = sourceField.split(/\s+/);
    if (sourcePoints.length !== 1) continue;
    const character = String.fromCodePoint(Number.parseInt(sourcePoints[0]!, 16));
    if (character.codePointAt(0)! <= 0x7f || !/^[\p{L}\p{N}]$/u.test(character)) continue;
    const targetCharacters = targetField
      .split(/\s+/)
      .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .join("");
    const target = normalizedAsciiTarget(targetCharacters);
    if (target) mappings.set(character, target);
  }

  const sensitiveTemplates = [
    "phone", "email", "address", "street", "postalcode", "zip", "clientip",
    "remoteip", "ipaddress", "useragent", "cellularnumber", "contactphone",
    "customername", "firstname", "lastname", "fullname", "surname", "forename",
  ];
  const officialHostileKeys = new Set<string>();
  const officialNormalizationHostileKeys = new Set<string>();
  const safeMixedTelecomKeys = new Set<string>();
  const safeNormalizationTelecomKeys = new Set<string>();
  for (const [sourceCharacter, officialTarget] of mappings) {
    const normalizationForms = new Set<string>();
    for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
      const normalized = sourceCharacter.normalize(form);
      normalizationForms.add(normalized);
      normalizationForms.add(normalized.toLowerCase());
      normalizationForms.add(normalized.toUpperCase());
    }
    for (const sourceForm of normalizationForms) {
      for (const safeTerm of ["organization", "application", "network"]) {
        let safeOffset = safeTerm.indexOf(officialTarget);
        while (safeOffset >= 0) {
          safeNormalizationTelecomKeys.add(
            `cellular_${safeTerm.slice(0, safeOffset)}${sourceForm}${safeTerm.slice(safeOffset + officialTarget.length)}`,
          );
          safeOffset = safeTerm.indexOf(officialTarget, safeOffset + 1);
        }
      }
      for (const template of sensitiveTemplates) {
        let offset = template.indexOf(officialTarget);
        while (offset >= 0) {
          officialNormalizationHostileKeys.add(
            `${template.slice(0, offset)}${sourceForm}${template.slice(offset + officialTarget.length)}`,
          );
          offset = template.indexOf(officialTarget, offset + 1);
        }
      }
    }

    const runtimeCharacter = sourceCharacter
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "");
    const runtimeCharacters = [...runtimeCharacter];
    if (runtimeCharacters.length !== 1) continue;
    const runtimeSkeleton = /^[a-z0-9]$/i.test(runtimeCharacter)
      ? runtimeCharacter.toLowerCase()
      : mappings.get(runtimeCharacter);
    if (!runtimeSkeleton) continue;
    for (const safeTerm of ["organization", "application", "network"]) {
      let safeOffset = safeTerm.indexOf(runtimeSkeleton);
      while (safeOffset >= 0) {
        safeMixedTelecomKeys.add(
          `cellular_${safeTerm.slice(0, safeOffset)}${runtimeCharacter}${safeTerm.slice(safeOffset + runtimeSkeleton.length)}`,
        );
        safeOffset = safeTerm.indexOf(runtimeSkeleton, safeOffset + 1);
      }
    }
    for (const template of sensitiveTemplates) {
      let offset = template.indexOf(runtimeSkeleton);
      while (offset >= 0) {
        officialHostileKeys.add(
          `${template.slice(0, offset)}${runtimeCharacter}${template.slice(offset + runtimeSkeleton.length)}`,
        );
        offset = template.indexOf(runtimeSkeleton, offset + 1);
      }
    }
  }

  // Independently generate non-table mixed-script letters. They exercise the
  // conservative one-code-point wildcard and are not selected from production
  // lookup data or from a hand-maintained character list.
  const conservativeWildcardKeys = new Set<string>();
  const pureMultilingualKeys = new Set<string>();
  for (let codePoint = 0x80; codePoint <= 0x2fff && conservativeWildcardKeys.size < 192; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (!/^[\p{L}\p{N}]$/u.test(character)) continue;
    const runtimeCharacter = character
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "");
    if ([...runtimeCharacter].length !== 1
      || !/^[\p{L}\p{N}]$/u.test(runtimeCharacter)
      || /^[a-z0-9]$/i.test(runtimeCharacter)) continue;
    if (mappings.has(runtimeCharacter)) continue;
    conservativeWildcardKeys.add(`ph${runtimeCharacter}ne`);
    pureMultilingualKeys.add(`${runtimeCharacter}${runtimeCharacter}`);
    safeMixedTelecomKeys.add(`cellular_${runtimeCharacter}rganization`);
  }

  cachedCorpus = Object.freeze({
    sourceSha256,
    officialHostileKeys: Object.freeze([...officialHostileKeys]),
    officialNormalizationHostileKeys: Object.freeze([...officialNormalizationHostileKeys]),
    conservativeWildcardKeys: Object.freeze([...conservativeWildcardKeys]),
    pureMultilingualKeys: Object.freeze([...pureMultilingualKeys]),
    safeMixedTelecomKeys: Object.freeze([...safeMixedTelecomKeys]),
    safeNormalizationTelecomKeys: Object.freeze([...safeNormalizationTelecomKeys]),
  });
  return cachedCorpus;
}
