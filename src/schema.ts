import { z } from "zod";
import {
  ASCII_CONFUSABLE_SKELETON_DATA,
  ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA,
  NON_ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA,
} from "./generated/unicode-confusables.js";
import { PROVIDER_IDS } from "./types.js";
import type { PropertyValue } from "./types.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const eventName = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const scalarPropertyValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

function buildPropertyValueSchema(depth: number): z.ZodType<PropertyValue> {
  if (depth === 0) return scalarPropertyValue;
  const nested = buildPropertyValueSchema(depth - 1);
  return z.union([
    scalarPropertyValue,
    z.array(nested).max(20),
    z.record(z.string().min(1).max(64), nested).refine(
      (value) => Object.keys(value).length <= 50,
      "nested property objects may contain at most 50 keys",
    ),
  ]);
}

const propertyValue = buildPropertyValueSchema(4);
const embeddedEmailValue = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/i;

function compactDataPairs(data: string): Array<readonly [string, string]> {
  if (data.length === 0) return [];
  return data.split("\u001E").map((record) => {
    const separator = record.indexOf("\u001F");
    return [record.slice(0, separator), record.slice(separator + 1)] as const;
  });
}

const asciiConfusableSkeletons = new Map<number, string>(
  compactDataPairs(ASCII_CONFUSABLE_SKELETON_DATA)
    .map(([codePoint, target]) => [Number.parseInt(codePoint, 36), target]),
);
const MIXED_SCRIPT_CLASSIFICATION_WILDCARD = "?";
const CONFUSABLE_TARGET_MARKER_START = 0xe000;

const nonAsciiNormalizationTargets = new Map<string, Set<string>>();
for (const [source, target] of compactDataPairs(NON_ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA)) {
  const targets = nonAsciiNormalizationTargets.get(source) ?? new Set<string>();
  targets.add(target);
  const sourceCharacters = [...source];
  if (sourceCharacters.length === 1
    && /^[\p{L}\p{N}]$/u.test(source)
    && !asciiConfusableSkeletons.has(source.codePointAt(0)!)) {
    targets.add(MIXED_SCRIPT_CLASSIFICATION_WILDCARD);
  }
  nonAsciiNormalizationTargets.set(source, targets);
}
const confusableTargetMarkerBySignature = new Map<string, string>();
const confusableTargetMarkerTargets = new Map<string, readonly string[]>();
const targetSignatures = [...new Set([...nonAsciiNormalizationTargets.values()]
  .filter((targets) => targets.size > 1)
  .map((targets) => [...targets].sort().join("\0")))]
  .sort();
for (const [index, signature] of targetSignatures.entries()) {
  const marker = String.fromCodePoint(CONFUSABLE_TARGET_MARKER_START + index);
  confusableTargetMarkerBySignature.set(signature, marker);
  confusableTargetMarkerTargets.set(marker, Object.freeze(signature.split("\0").sort((left, right) => {
    if (left === MIXED_SCRIPT_CLASSIFICATION_WILDCARD) return 1;
    if (right === MIXED_SCRIPT_CLASSIFICATION_WILDCARD) return -1;
    return left === right ? 0 : left < right ? -1 : 1;
  })));
}
const nonAsciiNormalizationAliasesByInitial = new Map<
  string,
  ReadonlyArray<readonly [string, string]>
>();
for (const [source, targets] of nonAsciiNormalizationTargets) {
  const signature = [...targets].sort().join("\0");
  const replacement = targets.size === 1
    ? [...targets][0]!
    : confusableTargetMarkerBySignature.get(signature)!;
  const initial = source[0]!;
  const entries = nonAsciiNormalizationAliasesByInitial.get(initial) ?? [];
  nonAsciiNormalizationAliasesByInitial.set(initial, [...entries, [source, replacement] as const]);
}
for (const [initial, entries] of nonAsciiNormalizationAliasesByInitial) {
  nonAsciiNormalizationAliasesByInitial.set(initial, [...entries].sort(([left], [right]) =>
    right.length - left.length || (left === right ? 0 : left < right ? -1 : 1)));
}

function applyNonAsciiNormalizationAliases(value: string): string {
  if (!/[a-z]/i.test(value)) return value;
  let output = "";
  for (let offset = 0; offset < value.length;) {
    const candidates = nonAsciiNormalizationAliasesByInitial.get(value[offset]!) ?? [];
    const match = candidates.find(([source]) => value.startsWith(source, offset));
    if (match) {
      output += match[1];
      offset += match[0].length;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(offset)!);
    output += character;
    offset += character.length;
  }
  return output;
}

function foldMixedScriptUnicodeSkeleton(value: string): string {
  return value.replace(/[\p{L}\p{N}]+/gu, (word) => {
    // Pure non-ASCII words remain ordinary multilingual metadata. Inside an
    // ASCII identifier word, apply the pinned UTS #39-derived table and treat
    // any remaining non-ASCII letter/number as one bounded semantic wildcard.
    // This makes the privacy boundary conservative without transliterating or
    // mutating the original event key.
    if (!/[a-z]/i.test(word)) return word;
    return [...word].map((character) => {
      if (/^[a-z0-9]$/i.test(character)) return character;
      const skeleton = asciiConfusableSkeletons.get(character.codePointAt(0)!);
      if (skeleton) return skeleton;
      const decomposed = character.normalize("NFKD").replace(/\p{M}+/gu, "");
      return [...decomposed].map((part) => {
        if (/^[a-z0-9]$/i.test(part)) return part;
        const decomposedSkeleton = asciiConfusableSkeletons.get(part.codePointAt(0)!);
        if (decomposedSkeleton) return decomposedSkeleton;
        return /^[\p{L}\p{N}]$/u.test(part)
          ? MIXED_SCRIPT_CLASSIFICATION_WILDCARD
          : part;
      }).join("");
    }).join("");
  });
}

const classificationPropertyKeyCache = new Map<string, string>();
const propertyKeyTokensCache = new Map<string, readonly string[]>();
const canonicalPropertyKeyTokensCache = new Map<string, readonly string[]>();
const segmentCompactPropertyTokenCache = new Map<string, readonly string[] | null>();
const MAX_PROPERTY_CLASSIFICATION_CACHE = 4_096;

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= MAX_PROPERTY_CLASSIFICATION_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/**
 * Produces a classification-only copy of a property key. The original key is
 * retained in the event and in validation errors. Compatibility decomposition
 * plus mark removal makes NFC/NFD and accented Latin renderings equivalent;
 * upper/lower expansion approximates Unicode default case folding. Letter case
 * is deliberately never treated as a trusted semantic boundary: adversarial
 * capitalization must classify exactly like compact lowercase spelling, while
 * stable punctuation still separates words. A pinned Unicode 17.0.0 UTS #39
 * profile is applied only to words containing ASCII. Remaining non-ASCII
 * letters/numbers in those mixed words are single-character semantic
 * wildcards; ordinary non-Latin words are not transliterated or rejected.
 */
function classificationPropertyKey(key: string): string {
  const cached = classificationPropertyKeyCache.get(key);
  if (cached !== undefined) return cached;
  // UTS #39 mappings are code-point-specific. Apply the skeleton before case
  // folding so a case pair cannot first collapse into a different confusable
  // class (for example, Greek lunate sigma versus ordinary sigma).
  const classified = foldMixedScriptUnicodeSkeleton(applyNonAsciiNormalizationAliases(key))
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .toLowerCase();
  setBoundedCache(classificationPropertyKeyCache, key, classified);
  return classified;
}

function propertyKeyTokens(key: string): string[] {
  const cached = propertyKeyTokensCache.get(key);
  if (cached) return [...cached];
  const tokens = classificationPropertyKey(key)
    .split(/[^a-z0-9?\uE000-\uF8FF]+/)
    .filter(Boolean)
    .flatMap((token) => {
      const variants = classificationTokenVariants(token);
      if (segmentCompactPropertyToken(variants[0]!) !== null) return [variants[0]!];
      const recognized = variants.filter((variant) => segmentCompactPropertyToken(variant) !== null);
      return recognized.length > 0 ? recognized : variants;
    });
  setBoundedCache(propertyKeyTokensCache, key, Object.freeze(tokens));
  return [...tokens];
}

function identityPropertyKeyTokens(key: string): string[] {
  return classificationPropertyKey(key)
    .split(/[^a-z0-9?\uE000-\uF8FF]+/)
    .filter(Boolean);
}

function identityCanonicalPropertyKeyTokens(key: string): string[] {
  return identityPropertyKeyTokens(key).flatMap((token) =>
    segmentCompactPropertyToken(token) ?? [canonicalPropertyToken(token)]);
}

const canonicalPropertyTokens: Readonly<Record<string, string>> = Object.freeze({
  applications: "application",
  apps: "app",
  addresses: "address",
  amounts: "amount",
  cells: "cell",
  cellulars: "cellular",
  cellphones: "cellphone",
  contacts: "contact",
  contactnumbers: "contactnumber",
  contactvalues: "contactvalue",
  counts: "count",
  counters: "counter",
  emails: "email",
  firstnames: "firstname",
  fullnames: "fullname",
  identifiers: "identifier",
  ids: "id",
  indices: "index",
  indexes: "index",
  lastnames: "lastname",
  people: "person",
  mobiles: "mobile",
  names: "name",
  numbers: "number",
  organizations: "organization",
  org: "organization",
  orgs: "organization",
  phonenumbers: "phonenumber",
  phones: "phone",
  prices: "price",
  quantities: "quantity",
  ranks: "rank",
  telephones: "telephone",
  totals: "total",
  values: "value",
});

function canonicalPropertyToken(token: string): string {
  return canonicalPropertyTokens[token] ?? token;
}

const semanticPropertyWords: Readonly<Record<string, string>> = Object.freeze({
  ...canonicalPropertyTokens,
  address: "address",
  agent: "agent",
  alias: "alias",
  alternate: "alternate",
  amount: "amount",
  app: "app",
  application: "application",
  attribute: "attribute",
  author: "author",
  backup: "backup",
  band: "band",
  billing: "billing",
  business: "business",
  campaign: "campaign",
  carrier: "carrier",
  category: "category",
  cell: "cell",
  cellular: "cellular",
  cellphone: "cellphone",
  client: "client",
  code: "code",
  company: "company",
  contact: "contact",
  contactnumber: "contactnumber",
  contactvalue: "contactvalue",
  count: "count",
  counter: "counter",
  customer: "customer",
  data: "data",
  description: "description",
  detail: "detail",
  default: "default",
  display: "display",
  domain: "domain",
  email: "email",
  emergency: "emergency",
  event: "event",
  extension: "extension",
  family: "family",
  field: "field",
  file: "file",
  first: "first",
  forename: "forename",
  full: "full",
  given: "given",
  group: "group",
  holder: "holder",
  host: "host",
  home: "home",
  id: "id",
  identifier: "identifier",
  index: "index",
  info: "info",
  information: "info",
  ip: "ip",
  label: "label",
  last: "last",
  legal: "legal",
  list: "list",
  key: "key",
  maiden: "maiden",
  mail: "mail",
  member: "member",
  metadata: "metadata",
  main: "main",
  mobile: "mobile",
  name: "name",
  network: "network",
  note: "note",
  number: "number",
  of: "of",
  office: "office",
  order: "order",
  organization: "organization",
  person: "person",
  personal: "personal",
  phone: "phone",
  phonenumber: "phonenumber",
  plan: "plan",
  postal: "postal",
  preferred: "preferred",
  price: "price",
  primary: "primary",
  product: "product",
  profile: "profile",
  project: "project",
  protocol: "protocol",
  provider: "provider",
  quantity: "quantity",
  rank: "rank",
  recipient: "recipient",
  record: "record",
  remote: "remote",
  secondary: "secondary",
  service: "service",
  shipping: "shipping",
  source: "source",
  standard: "standard",
  street: "street",
  support: "support",
  surname: "surname",
  team: "team",
  tel: "tel",
  telephone: "telephone",
  technology: "technology",
  text: "text",
  total: "total",
  user: "user",
  value: "value",
  verified: "verified",
  visitor: "visitor",
  work: "work",
  zip: "zip",
});

function pluralPropertyWord(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const semanticPropertyWordVariants = Object.freeze(
  Object.entries(semanticPropertyWords)
    .flatMap(([word, canonical]) => {
      const variants: Array<[string, string]> = [[word, canonical]];
      variants.push([pluralPropertyWord(word), canonical]);
      return variants;
    })
    .sort(([left], [right]) => right.length - left.length),
);

const semanticPropertyWordVariantsByInitial = new Map<string, ReadonlyArray<readonly [string, string]>>();
for (const entry of semanticPropertyWordVariants) {
  const initial = entry[0][0]!;
  const entries = semanticPropertyWordVariantsByInitial.get(initial) ?? [];
  semanticPropertyWordVariantsByInitial.set(initial, [...entries, entry]);
}

const normalizationConfusableAliasesByInitial = new Map<
  string,
  ReadonlyArray<readonly [string, string]>
>();
for (const entry of compactDataPairs(ASCII_NORMALIZATION_CONFUSABLE_ALIAS_DATA)) {
  const initial = entry[0][0]!;
  const entries = normalizationConfusableAliasesByInitial.get(initial) ?? [];
  normalizationConfusableAliasesByInitial.set(initial, [...entries, entry]);
}

function normalizationAliasesAt(token: string, offset: number): ReadonlyArray<readonly [string, string]> {
  return (normalizationConfusableAliasesByInitial.get(token[offset] ?? "") ?? [])
    .filter(([source]) => token.startsWith(source, offset));
}

function classificationTokenVariants(token: string): string[] {
  let markerVariants = [""];
  for (const character of token) {
    const targets = confusableTargetMarkerTargets.get(character) ?? [character];
    markerVariants = markerVariants.flatMap((prefix) => targets.map((target) => `${prefix}${target}`));
    if (markerVariants.length > 64) {
      markerVariants = markerVariants.slice(0, 64);
      break;
    }
  }

  const variants = new Set(markerVariants);
  for (const base of markerVariants) {
    for (let offset = 0; offset < base.length; offset += 1) {
      for (const [source, target] of normalizationAliasesAt(base, offset)) {
        // Single-character aliases are already streamed inside each semantic
        // word. Materialize only structural aliases that can span a semantic
        // boundary (for example m -> rn across cellular|number).
        if (source.length === 1 && target.length === 1) continue;
        variants.add(`${base.slice(0, offset)}${target}${base.slice(offset + source.length)}`);
      }
    }
  }
  return [...variants];
}

function semanticVariantsAt(token: string, offset: number): ReadonlyArray<readonly [string, string]> {
  if (token[offset] === MIXED_SCRIPT_CLASSIFICATION_WILDCARD) return semanticPropertyWordVariants;
  const initials = new Set<string>([token[offset] ?? ""]);
  for (const [, target] of normalizationAliasesAt(token, offset)) initials.add(target[0]!);
  for (const target of confusableTargetMarkerTargets.get(token[offset] ?? "") ?? []) {
    initials.add(target[0]!);
  }
  const variants: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const initial of initials) {
    for (const entry of semanticPropertyWordVariantsByInitial.get(initial) ?? []) {
      const identity = `${entry[0]}\0${entry[1]}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        variants.push(entry);
      }
    }
  }
  return variants;
}

interface TokenVariantMatch {
  readonly end: number;
  readonly usedNormalizationAlias: boolean;
}

function tokenVariantMatches(token: string, variant: string, offset: number): TokenVariantMatch[] {
  const memo = new Map<string, readonly TokenVariantMatch[]>();

  function visit(tokenOffset: number, variantOffset: number): readonly TokenVariantMatch[] {
    if (variantOffset === variant.length) {
      return [{ end: tokenOffset, usedNormalizationAlias: false }];
    }
    if (tokenOffset >= token.length) return [];
    const memoKey = `${tokenOffset}:${variantOffset}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;
    const matches = new Map<string, TokenVariantMatch>();
    const add = (match: TokenVariantMatch) => {
      matches.set(`${match.end}:${match.usedNormalizationAlias ? "1" : "0"}`, match);
    };
    const character = token[tokenOffset];
    if (character === MIXED_SCRIPT_CLASSIFICATION_WILDCARD) {
      for (const match of visit(tokenOffset + 1, variantOffset + 1)) add(match);
    } else if (confusableTargetMarkerTargets.has(character ?? "")) {
      for (const target of confusableTargetMarkerTargets.get(character!)!) {
        if (!variant.startsWith(target, variantOffset)) continue;
        for (const match of visit(tokenOffset + 1, variantOffset + target.length)) add(match);
      }
    } else if (character === variant[variantOffset]) {
      for (const match of visit(tokenOffset + 1, variantOffset + 1)) add(match);
    }
    for (const [source, target] of normalizationAliasesAt(token, tokenOffset)) {
      if (!variant.startsWith(target, variantOffset)) continue;
      for (const match of visit(tokenOffset + source.length, variantOffset + target.length)) {
        add({ end: match.end, usedNormalizationAlias: true });
      }
    }
    const result = Object.freeze([...matches.values()]);
    memo.set(memoKey, result);
    return result;
  }

  return [...visit(offset, 0)];
}

function tokenVariantMatchEnds(token: string, variant: string, offset: number): number[] {
  return [...new Set(tokenVariantMatches(token, variant, offset).map((match) => match.end))];
}

function segmentCompactPropertyToken(token: string): string[] | null {
  if (segmentCompactPropertyTokenCache.has(token)) {
    const cached = segmentCompactPropertyTokenCache.get(token)!;
    return cached ? [...cached] : null;
  }
  const memo = new Map<number, string[] | null>();

  function visit(offset: number): string[] | null {
    if (offset === token.length) return [];
    if (memo.has(offset)) return memo.get(offset)!;

    for (const [variant, canonical] of semanticVariantsAt(token, offset)) {
      for (const matchEnd of tokenVariantMatchEnds(token, variant, offset)) {
        const remainder = visit(matchEnd);
        if (remainder) {
          const result = [canonical, ...remainder];
          memo.set(offset, result);
          return result;
        }
      }
    }

    memo.set(offset, null);
    return null;
  }

  const result = visit(0);
  setBoundedCache(
    segmentCompactPropertyTokenCache,
    token,
    result ? Object.freeze([...result]) : null,
  );
  return result ? [...result] : null;
}

interface SemanticPropertyRun {
  readonly start: number;
  readonly end: number;
  readonly tokens: readonly string[];
  readonly usedNormalizationAlias: boolean;
}

const semanticPropertyRunCache = new Map<string, readonly SemanticPropertyRun[]>();
const MAX_SEMANTIC_PROPERTY_RUN_CACHE = 512;

/**
 * Finds bounded runs of recognized semantic words inside a compact property
 * token. Unknown spans are never recursively segmented: they only separate
 * recognized runs. This keeps the classifier deterministic while making a
 * compact rendering such as `billingcontactphone` decision-equivalent to its
 * camel and separator forms.
 */
function semanticPropertyRuns(token: string): SemanticPropertyRun[] {
  const cached = semanticPropertyRunCache.get(token);
  if (cached) return [...cached];
  const memo = new Map<number, Omit<SemanticPropertyRun, "start"> | null>();

  function longestRunFrom(offset: number): Omit<SemanticPropertyRun, "start"> | null {
    if (memo.has(offset)) return memo.get(offset)!;
    let best: Omit<SemanticPropertyRun, "start"> | null = null;

    for (const [variant, canonical] of semanticVariantsAt(token, offset)) {
      for (const match of tokenVariantMatches(token, variant, offset)) {
        const remainder = longestRunFrom(match.end);
        const candidate = {
          end: remainder?.end ?? match.end,
          tokens: [canonical, ...(remainder?.tokens ?? [])],
          usedNormalizationAlias: match.usedNormalizationAlias
            || (remainder?.usedNormalizationAlias ?? false),
        };
        if (!best
          || candidate.end > best.end
          || (candidate.end === best.end && candidate.tokens.length > best.tokens.length)
          || (candidate.end === best.end
            && candidate.tokens.length === best.tokens.length
            && candidate.usedNormalizationAlias
            && !best.usedNormalizationAlias)) {
          best = candidate;
        }
      }
    }

    memo.set(offset, best);
    return best;
  }

  const runs: SemanticPropertyRun[] = [];
  for (let start = 0; start < token.length; start += 1) {
    const run = longestRunFrom(start);
    if (run) runs.push({ start, ...run });
  }
  if (semanticPropertyRunCache.size >= MAX_SEMANTIC_PROPERTY_RUN_CACHE) {
    const oldest = semanticPropertyRunCache.keys().next().value;
    if (oldest !== undefined) semanticPropertyRunCache.delete(oldest);
  }
  semanticPropertyRunCache.set(token, Object.freeze(runs.map((run) => Object.freeze({
    ...run,
    tokens: Object.freeze([...run.tokens]),
  }))));
  return runs;
}

function canonicalPropertyKeyTokens(key: string): string[] {
  const cached = canonicalPropertyKeyTokensCache.get(key);
  if (cached) return [...cached];
  const tokens = [...new Set(propertyKeyTokens(key).flatMap((token) =>
    segmentCompactPropertyToken(token) ?? [canonicalPropertyToken(token)]))];
  setBoundedCache(canonicalPropertyKeyTokensCache, key, Object.freeze(tokens));
  return [...tokens];
}

const safeNumericIdentifierTokens = new Set([
  "id",
  "identifier",
  "count",
  "counter",
  "index",
  "rank",
  "total",
  "amount",
  "price",
  "quantity",
]);

function hasSafeNumericLeafSemantic(key: string): boolean {
  const identityLeaf = identityPropertyKeyTokens(key).at(-1);
  if (identityLeaf) {
    const identityExact = segmentCompactPropertyToken(identityLeaf) ?? [canonicalPropertyToken(identityLeaf)];
    if (safeNumericIdentifierTokens.has(identityExact.at(-1)!)) return true;
    if (semanticPropertyRuns(identityLeaf).some((run) =>
      run.end === identityLeaf.length
        && run.tokens.length > 1
        && safeNumericIdentifierTokens.has(run.tokens.at(-1)!))) return true;
  }
  const rawTokens = propertyKeyTokens(key);
  const leaf = rawTokens.at(-1);
  if (!leaf) return false;
  const exact = segmentCompactPropertyToken(leaf) ?? [canonicalPropertyToken(leaf)];
  if (safeNumericIdentifierTokens.has(exact.at(-1)!)) return true;
  return semanticPropertyRuns(leaf).some((run) =>
    run.end === leaf.length
      && run.tokens.length > 1
      && safeNumericIdentifierTokens.has(run.tokens.at(-1)!));
}

const directHumanNameKeys = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "surname",
  "forename",
  "givenname",
  "familyname",
  "maidenname",
]);

const personalNameContextTokens = new Set([
  "display",
  "customer",
  "contact",
  "user",
  "profile",
  "member",
  "person",
  "recipient",
  "author",
  "visitor",
  "holder",
]);

const personalContextContainerTokens = new Set([
  ...personalNameContextTokens,
  "people",
  "data",
  "detail",
  "group",
  "info",
  "list",
  "metadata",
  "record",
]);
const personalContextContainerWords = Object.freeze(
  [...personalContextContainerTokens].sort((left, right) => right.length - left.length),
);

const safeNonPersonNameKeys = new Set([
  "appname",
  "applicationname",
  "codename",
  "eventname",
  "productname",
  "companyname",
  "organizationname",
  "projectname",
  "teamname",
  "campaignname",
  "categoryname",
  "filename",
  "hostname",
  "domainname",
  "authoritativename",
]);

const safeNonPersonNameTokens = new Set([
  "app",
  "application",
  "code",
  "event",
  "product",
  "company",
  "organization",
  "campaign",
  "category",
  "file",
  "host",
  "domain",
  "project",
  "team",
]);

const safeNameStructureTokens = new Set([
  ...safeNonPersonNameTokens,
  "name",
  "attribute",
  "label",
  "data",
  "description",
  "detail",
  "field",
  "group",
  "info",
  "key",
  "list",
  "metadata",
  "of",
  "record",
  "value",
]);

const directHumanNameModifierTokens = new Set([
  "alias",
  "first",
  "full",
  "given",
  "family",
  "last",
  "legal",
  "maiden",
  "personal",
  "preferred",
]);

const controlledSemanticModifierTokens = new Set([
  ...directHumanNameModifierTokens,
  "alternate",
  "backup",
  "billing",
  "business",
  "default",
  "emergency",
  "home",
  "main",
  "office",
  "personal",
  "primary",
  "secondary",
  "shipping",
  "support",
  "verified",
  "work",
]);

const directPhoneSemanticTokens = new Set([
  "cell",
  "cellular",
  "cellphone",
  "mobile",
  "phone",
  "phonenumber",
  "tel",
  "telephone",
]);

const safePhoneContextTokens = new Set([
  "app",
  "application",
  "band",
  "campaign",
  "carrier",
  "category",
  "code",
  "company",
  "data",
  "device",
  "domain",
  "event",
  "file",
  "game",
  "host",
  "network",
  "organization",
  "plan",
  "platform",
  "product",
  "protocol",
  "provider",
  "project",
  "service",
  "standard",
  "team",
  "technology",
]);

const safePhoneContextModifierTokens = new Set([
  "backup",
  "business",
  "default",
  "primary",
  "secondary",
  "support",
]);

const safePhoneEntityStructureTokens = new Set([
  "attribute",
  "description",
  "detail",
  "field",
  "info",
  "key",
  "label",
  "metadata",
  "name",
  "record",
]);

function canonicalSafePhoneContextToken(token: string): string {
  if (token.endsWith("s") && safePhoneContextTokens.has(token.slice(0, -1))) {
    return token.slice(0, -1);
  }
  return token;
}

const explicitPersonalOrDirectValueTokens = new Set([
  ...personalNameContextTokens,
  "address",
  "contact",
  "contactnumber",
  "contactvalue",
  "email",
  "ip",
  "mail",
  "number",
  "person",
  "personal",
  "postal",
  "street",
  "value",
  "zip",
]);

function isBoundedUnknownEntityModifier(token: string): boolean {
  return token.length > 0
    && token.length <= MAX_UNKNOWN_SEMANTIC_MODIFIER_LENGTH
    && /^[a-z0-9]+$/.test(token)
    && semanticPropertyWords[token] === undefined;
}

function isExplicitSafePhoneContext(tokens: readonly string[]): boolean {
  const canonical = tokens.map(canonicalSafePhoneContextToken);
  const unknownModifiers = canonical.filter(isBoundedUnknownEntityModifier);
  return canonical.some((token) => directPhoneSemanticTokens.has(token))
    && canonical.some((token) => safePhoneContextTokens.has(token))
    && unknownModifiers.length <= 1
    && !canonical.some((token) => explicitPersonalOrDirectValueTokens.has(
      canonicalPersonalContextToken(token),
    ))
    && canonical.every((token) => directPhoneSemanticTokens.has(token)
      || safePhoneContextTokens.has(token)
      || safePhoneContextModifierTokens.has(token)
      || controlledSemanticModifierTokens.has(token)
      || safePhoneEntityStructureTokens.has(token)
      || isBoundedUnknownEntityModifier(token));
}

function hasExplicitSafePhoneIdentityContext(
  key: string,
  combinedIdentityTokens: readonly string[],
): boolean {
  const rawTokens = identityPropertyKeyTokens(key);
  // Mixed-script target markers are intentionally never allowed to acquire a
  // safe-entity identity through the more permissive classification skeleton.
  if (rawTokens.some((token) => /[?\uE000-\uF8FF]/.test(token))) return false;
  if (isExplicitSafePhoneContext(combinedIdentityTokens)) return true;

  return rawTokens.some((rawToken) => semanticPropertyRuns(rawToken).some((run) => {
    const candidate = [
      ...(run.start > 0 ? [rawToken.slice(0, run.start)] : []),
      ...run.tokens,
      ...(run.end < rawToken.length ? [rawToken.slice(run.end)] : []),
    ];
    return isExplicitSafePhoneContext(candidate);
  }));
}

function isPhoneSemanticPhrase(tokens: readonly string[]): boolean {
  const hasPhone = tokens.some((token) => directPhoneSemanticTokens.has(token));
  if (tokens.includes("cell") && tokens.includes("number")) return true;
  if (tokens.includes("contact") && tokens.some((token) => [
    "cell",
    "cellular",
    "cellphone",
    "mobile",
    "number",
    "phone",
    "phonenumber",
    "tel",
    "telephone",
    "value",
  ].includes(token))) return true;
  return hasPhone && tokens.some((token) =>
    token === "number"
      || token === "contact"
      || personalNameContextTokens.has(canonicalPersonalContextToken(token))
      || controlledSemanticModifierTokens.has(token));
}

function isPersonalNameSemanticPhrase(tokens: readonly string[]): boolean {
  const hasName = tokens.some((token) => [
    "firstname",
    "forename",
    "fullname",
    "lastname",
    "name",
    "surname",
  ].includes(token));
  return hasName && tokens.some((token) =>
    personalNameContextTokens.has(canonicalPersonalContextToken(token))
      || directHumanNameModifierTokens.has(token));
}

function isHighRiskSemanticPhrase(tokens: readonly string[]): boolean {
  return tokens.length > 1
    && (isPhoneSemanticPhrase(tokens) || isPersonalNameSemanticPhrase(tokens));
}

function isBoundedHighRiskAnchorPair(tokens: readonly string[]): boolean {
  const hasPhone = tokens.some((token) => directPhoneSemanticTokens.has(token));
  const hasPersonalContext = tokens.some((token) =>
    personalNameContextTokens.has(canonicalPersonalContextToken(token)));
  const hasName = tokens.some((token) => [
    "firstname",
    "forename",
    "fullname",
    "lastname",
    "name",
    "surname",
  ].includes(token));
  if (tokens.includes("cell") && tokens.includes("number")) return true;
  if (tokens.includes("contact") && tokens.some((token) =>
    token === "number" || token === "value" || directPhoneSemanticTokens.has(token))) return true;
  if (hasPhone && (tokens.includes("number") || hasPersonalContext)) return true;
  return hasName && (hasPersonalContext
    || tokens.some((token) => directHumanNameModifierTokens.has(token)));
}

const MAX_UNKNOWN_SEMANTIC_MODIFIER_LENGTH = 16;

function recognizedHighRiskRunTokens(rawToken: string): string[] {
  const runs = semanticPropertyRuns(rawToken);
  const recognized = new Set<string>();
  for (const run of runs) {
    const compact = run.tokens.join("");
    const isDirectAliasedSensitiveRun = run.usedNormalizationAlias && (
      run.tokens.some((token) => [
        "address",
        "email",
        "street",
        "zip",
      ].includes(token))
      || run.tokens.some((token) => directPhoneSemanticTokens.has(token))
      || directHumanNameKeys.has(compact)
      || (run.tokens.includes("postal") && run.tokens.includes("code"))
      || (run.tokens.includes("user") && run.tokens.includes("agent"))
      || (run.tokens.includes("ip") && run.tokens.some((token) => [
        "address",
        "client",
        "remote",
        "source",
        "user",
        "visitor",
      ].includes(token)))
    );
    if (isDirectAliasedSensitiveRun
      || (isHighRiskSemanticPhrase(run.tokens)
        && (run.end === rawToken.length || isBoundedHighRiskAnchorPair(run.tokens)))) {
      run.tokens.forEach((token) => recognized.add(token));
    }
  }

  // A compact renderer can place one bounded, unrecognized modifier between
  // two explicit risk anchors. Require the pair itself to form a complete
  // high-risk semantic phrase; never promote a lone substring match.
  for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
    const left = runs[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < runs.length; rightIndex += 1) {
      const right = runs[rightIndex]!;
      if (right.start < left.end) continue;
      const gapLength = right.start - left.end;
      if (gapLength > MAX_UNKNOWN_SEMANTIC_MODIFIER_LENGTH) break;
      const combined = [...left.tokens, ...right.tokens];
      if (!isBoundedHighRiskAnchorPair(combined)) continue;
      combined.forEach((token) => recognized.add(token));
    }
  }
  return [...recognized];
}

/**
 * Returns exact semantic tokens plus tokens from complete multi-word risk
 * phrases. A lone word found inside an unrelated identifier is intentionally
 * not promoted to a field boundary (`saxophone`, `zipper`, `mobilegame`).
 */
function recognizedRiskSemanticKeyTokens(key: string): string[] {
  const exactTokens = canonicalPropertyKeyTokens(key);
  const phraseTokens = propertyKeyTokens(key).flatMap(recognizedHighRiskRunTokens);
  return [...new Set([...exactTokens, ...phraseTokens])];
}

function singularNameKeyCompact(key: string): string {
  const compact = canonicalPropertyKeyTokens(key).join("");
  return compact.endsWith("names") ? compact.slice(0, -1) : compact;
}

function isSafeNonPersonNameSemantic(tokens: string[]): boolean {
  return tokens.includes("name")
    && tokens.some((token) => safeNonPersonNameTokens.has(token))
    && tokens.every((token) => safeNameStructureTokens.has(token));
}

function hasExplicitSafeNonPersonNameSemantic(key: string, exactTerms: string[]): boolean {
  if (exactTerms.some((_, index) => isSafeNonPersonNameSemantic(exactTerms.slice(index)))) return true;
  return propertyKeyTokens(key).some((rawToken) => semanticPropertyRuns(rawToken).some((run) =>
    run.start === 0
      && run.end === rawToken.length
      && isSafeNonPersonNameSemantic([...run.tokens])));
}

function hasExplicitSafeNonPersonIdentityNameSemantic(key: string): boolean {
  const rawTokens = identityPropertyKeyTokens(key);
  if (rawTokens.some((token) => /[?\uE000-\uF8FF]/.test(token))) return false;
  const exactTerms = identityCanonicalPropertyKeyTokens(key);
  if (exactTerms.some((_, index) => isSafeNonPersonNameSemantic(exactTerms.slice(index)))) return true;
  return rawTokens.some((rawToken) => semanticPropertyRuns(rawToken).some((run) =>
    run.end === rawToken.length && isSafeNonPersonNameSemantic([...run.tokens])));
}

function canonicalPersonalContextToken(token: string): string {
  if (token === "people") return "person";
  if (token.endsWith("s") && personalNameContextTokens.has(token.slice(0, -1))) {
    return token.slice(0, -1);
  }
  return token;
}

function hasPersonalContextToken(tokens: string[]): boolean {
  return tokens.some((token) => personalNameContextTokens.has(canonicalPersonalContextToken(token)));
}

function compactHasPersonalContext(value: string): boolean {
  const memo = new Map<string, boolean>();

  function visit(remaining: string, foundPersonalContext: boolean): boolean {
    if (remaining.length === 0) return foundPersonalContext;
    const memoKey = `${remaining}:${foundPersonalContext ? "1" : "0"}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;

    for (const word of personalContextContainerWords) {
      const variants = [word, `${word}s`];
      for (const variant of variants) {
        for (const matchEnd of tokenVariantMatchEnds(remaining, variant, 0)) {
          const isPersonal = personalNameContextTokens.has(canonicalPersonalContextToken(word));
          if (visit(remaining.slice(matchEnd), foundPersonalContext || isPersonal)) {
            memo.set(memoKey, true);
            return true;
          }
        }
      }
    }

    memo.set(memoKey, false);
    return false;
  }

  return visit(value, false);
}

function pathHasPersonalNameContext(path: Array<string | number>): boolean {
  return path
    .filter((item): item is string => typeof item === "string" && item !== "properties")
    .some((key) => {
      const terms = canonicalPropertyKeyTokens(key);
      return hasPersonalContextToken(terms) || compactHasPersonalContext(terms.join(""));
    });
}

function blockedHumanNameKey(key: string, path: Array<string | number>): boolean {
  const exactTerms = canonicalPropertyKeyTokens(key);
  const terms = recognizedRiskSemanticKeyTokens(key);
  const compact = singularNameKeyCompact(key);
  const identityCompact = identityCanonicalPropertyKeyTokens(key).join("");
  if (safeNonPersonNameKeys.has(identityCompact)) return false;
  if (!hasPersonalContextToken(terms) && hasExplicitSafeNonPersonIdentityNameSemantic(key)) return false;
  if (safeNonPersonNameKeys.has(compact)) return false;
  if (!hasPersonalContextToken(terms) && hasExplicitSafeNonPersonNameSemantic(key, exactTerms)) return false;
  if (directHumanNameKeys.has(compact)) return true;
  if (terms.some((term) => directHumanNameKeys.has(term))) return true;
  const rawLeaf = propertyKeyTokens(key).at(-1);
  const hasNameSemantic = terms.includes("name")
    || terms.some((term) => ["forename", "surname"].includes(term));
  const hasAmbiguousPersonalNameSuffix = Boolean(
    rawLeaf?.endsWith("name") && pathHasPersonalNameContext(path),
  );
  if (!hasNameSemantic && !hasAmbiguousPersonalNameSuffix) return false;

  if (terms.some((term) => directHumanNameModifierTokens.has(term))) return true;
  if (hasPersonalContextToken(terms)) return true;
  return pathHasPersonalNameContext(path);
}

function blockedPropertyKey(key: string, path: Array<string | number> = []): boolean {
  const tokens = canonicalPropertyKeyTokens(key);
  const recognizedTokens = recognizedRiskSemanticKeyTokens(key);
  const identityTokens = identityCanonicalPropertyKeyTokens(key);
  const identityRecognizedTokens = [...new Set([
    ...identityTokens,
    ...identityPropertyKeyTokens(key).flatMap(recognizedHighRiskRunTokens),
  ])];
  const normalized = tokens.join("_");
  const compact = tokens.join("");
  if (hasSafeNumericLeafSemantic(key)) return false;
  if (/(?:^|_)e_mail(?:_|$)/.test(normalized)) return true;
  if (recognizedTokens.some((token) => ["email", "address", "street", "zip"].includes(token))) return true;
  if (identityRecognizedTokens.some((token) => directPhoneSemanticTokens.has(token))
    && hasExplicitSafePhoneIdentityContext(key, identityRecognizedTokens)) return false;
  if (recognizedTokens.some((token) => directPhoneSemanticTokens.has(token))
    && !isExplicitSafePhoneContext(recognizedTokens)) return true;
  if (["contactnumber", "mobilenumber", "telephonenumber", "cellphonenumber"].includes(compact)) return true;
  if (blockedHumanNameKey(key, path)) return true;
  if (recognizedTokens.includes("postal") && recognizedTokens.includes("code")) return true;
  if (recognizedTokens.includes("user") && recognizedTokens.includes("agent")) return true;
  if (/(?:^|_)postal_code(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)user_agent(?:_|$)/.test(normalized)) return true;
  if (recognizedTokens.includes("ip")
    && recognizedTokens.some((token) => ["client", "remote", "source", "user", "visitor"].includes(token))) {
    return true;
  }
  if (normalized === "ip" || /(?:^|_)(?:client|remote|source|user|visitor)_ip(?:_|$)/.test(normalized)) return true;
  return /(?:^|_)ip_address(?:_|$)/.test(normalized);
}

function numericPhonePropertyKey(key: string): boolean {
  const tokens = recognizedRiskSemanticKeyTokens(key);
  if (hasSafeNumericLeafSemantic(key)) return false;
  if (tokens.some((token) => directPhoneSemanticTokens.has(token))) {
    return true;
  }
  return tokens.some((token) => ["contact", "contactnumber", "contactvalue"].includes(token));
}

function safeNumericIdentifierKey(key: string): boolean {
  return hasSafeNumericLeafSemantic(key);
}

function hasNumericPhoneContext(path: Array<string | number>): boolean {
  const propertyKeys = path.filter((item): item is string => typeof item === "string");
  const nearestKey = propertyKeys.at(-1);
  if (nearestKey && safeNumericIdentifierKey(nearestKey)) return false;
  return propertyKeys.some(numericPhonePropertyKey);
}

function isNumericPhone(value: number, path: Array<string | number>): boolean {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  if (!hasNumericPhoneContext(path)) return false;
  const digits = String(value);
  return digits.length >= 8 && digits.length <= 15;
}

function containsPhone(value: string, path: Array<string | number>): boolean {
  const propertyKeys = path.filter((item): item is string => typeof item === "string");
  const nearestKey = propertyKeys.at(-1);
  const candidates = value.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return candidates.some((candidate) => {
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(candidate.trim())) return false;
    if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(candidate.trim())) return false;
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    if (candidate.includes("+") || /[\s().-]/.test(candidate)) return true;
    if (nearestKey && safeNumericIdentifierKey(nearestKey)) return false;
    if (candidate.trim() !== value.trim()) return true;
    return hasNumericPhoneContext(path);
  });
}

function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false;
    return Number(octet) <= 255;
  });
}

function isIpv6Address(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

function isIpAddress(value: string): boolean {
  return isIpv4Address(value) || isIpv6Address(value);
}

function containsIpAddress(value: string): boolean {
  const candidates = value.split(/[\s,;()[\]{}<>"'=/?#]+/).filter(Boolean);
  return candidates.some((candidate) => {
    if (isIpAddress(candidate)) return true;
    const withoutZone = candidate.replace(/%[^:]+$/, "");
    if (isIpAddress(withoutZone)) return true;
    const withoutPort = withoutZone.match(/^(.+):\d{1,5}$/)?.[1];
    if (withoutPort && isIpAddress(withoutPort)) return true;
    return isIpAddress(withoutZone.replace(/^[.,]+|[.,]+$/g, ""));
  });
}

const MAX_PROPERTY_CLASSIFICATION_KEYS = 200;
const MAX_PROPERTY_CLASSIFICATION_CODE_POINTS = 4_096;
const MAX_PROPERTY_CLASSIFICATION_WORK = 20_000;
const WILDCARD_CLASSIFICATION_WORK = 1_024;
const NORMALIZATION_ALIAS_CLASSIFICATION_WORK = 16;
const ALIAS_DENSE_CLASSIFICATION_WORK = MAX_PROPERTY_CLASSIFICATION_WORK + 1;
const TARGET_ALTERNATIVE_CLASSIFICATION_WORK = 2_048;

interface PropertyClassificationBudget {
  keys: number;
  codePoints: number;
  work: number;
  exceeded: boolean;
}

function consumePropertyClassificationKey(key: string, state: PropertyClassificationBudget): void {
  if (state.exceeded) return;
  const classified = classificationPropertyKey(key);
  let wildcardCount = 0;
  let normalizationAliasCount = 0;
  let targetAlternativeCount = 0;
  for (let offset = 0; offset < classified.length; offset += 1) {
    if (classified[offset] === MIXED_SCRIPT_CLASSIFICATION_WILDCARD) wildcardCount += 1;
    normalizationAliasCount += normalizationAliasesAt(classified, offset).length;
    targetAlternativeCount += confusableTargetMarkerTargets.get(classified[offset] ?? "")?.length ?? 0;
  }
  state.keys += 1;
  state.codePoints += [...key].length;
  state.work += [...classified].length
    + wildcardCount * WILDCARD_CLASSIFICATION_WORK
    + normalizationAliasCount * NORMALIZATION_ALIAS_CLASSIFICATION_WORK
    // Multiple alias paths per input character are the expensive case. Fail
    // that density during linear metering without penalizing many ordinary
    // keys that each contain one or two incidental ASCII alias sources.
    + (normalizationAliasCount > classified.length ? ALIAS_DENSE_CLASSIFICATION_WORK : 0)
    + targetAlternativeCount * TARGET_ALTERNATIVE_CLASSIFICATION_WORK;
  state.exceeded = state.keys > MAX_PROPERTY_CLASSIFICATION_KEYS
    || state.codePoints > MAX_PROPERTY_CLASSIFICATION_CODE_POINTS
    || state.work > MAX_PROPERTY_CLASSIFICATION_WORK;
}

function measureNestedPropertyClassification(
  value: PropertyValue,
  state: PropertyClassificationBudget,
): void {
  if (state.exceeded || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) measureNestedPropertyClassification(item, state);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    consumePropertyClassificationKey(key, state);
    measureNestedPropertyClassification(item, state);
    if (state.exceeded) return;
  }
}

function inspectPropertyValue(
  value: PropertyValue,
  path: Array<string | number>,
  context: z.RefinementCtx,
  state: { nodes: number; overLimit: boolean },
): void {
  state.nodes += 1;
  if (state.nodes > 200) {
    if (!state.overLimit) {
      state.overLimit = true;
      context.addIssue({ code: "custom", message: "properties may contain at most 200 values", path });
    }
    return;
  }
  if (typeof value === "string") {
    if (embeddedEmailValue.test(value) || containsPhone(value, path) || containsIpAddress(value)) {
      context.addIssue({
        code: "custom",
        message: "property appears to contain direct personal information and is not allowed",
        path,
      });
    }
    return;
  }
  if (typeof value === "number" && isNumericPhone(value, path)) {
    context.addIssue({
      code: "custom",
      message: "numeric property appears to contain a direct phone number and is not allowed",
      path,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPropertyValue(item, [...path, index], context, state));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = [...path, key];
      if (blockedPropertyKey(key, path)) {
        context.addIssue({
          code: "custom",
          message: `property ${key} may contain direct personal information and is not allowed`,
          path: itemPath,
        });
      }
      inspectPropertyValue(item, itemPath, context, state);
    }
  }
}
const httpUrl = z.url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use http or https");

export const pixelEventSchema = z.object({
  name: eventName,
  eventId: identifier.optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  properties: z.record(z.string().min(1).max(64), propertyValue).optional(),
  context: z.object({
    url: httpUrl.optional(),
    referrer: httpUrl.optional(),
    title: z.string().max(300).optional(),
  }).strict().optional(),
}).strict().superRefine((event, context) => {
  const entries = Object.entries(event.properties ?? {});
  if (entries.length > 50) {
    context.addIssue({ code: "custom", message: "properties may contain at most 50 keys", path: ["properties"] });
  }
  const classificationBudget: PropertyClassificationBudget = {
    keys: 0,
    codePoints: 0,
    work: 0,
    exceeded: false,
  };
  for (const [key, value] of entries) {
    consumePropertyClassificationKey(key, classificationBudget);
    measureNestedPropertyClassification(value, classificationBudget);
    if (classificationBudget.exceeded) break;
  }
  if (classificationBudget.exceeded) {
    context.addIssue({
      code: "custom",
      message: "properties exceed the bounded classification work budget",
      path: ["properties"],
    });
    return;
  }
  const state = { nodes: 0, overLimit: false };
  for (const [key, value] of entries) {
    if (blockedPropertyKey(key, ["properties"])) {
      context.addIssue({
        code: "custom",
        message: `property ${key} may contain direct personal information and is not allowed`,
        path: ["properties", key],
      });
    }
    inspectPropertyValue(value, ["properties", key], context, state);
  }
});

export const consentStateSchema = z.object({
  analytics: z.boolean(),
  advertising: z.boolean(),
  source: z.enum(["banner", "settings", "api", "unknown"]).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const runtimeSignalsSchema = z.object({
  globalPrivacyControl: z.boolean().optional(),
  doNotTrack: z.boolean().optional(),
}).strict();

export const pixelPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowedProviders: z.array(z.enum(PROVIDER_IDS)).max(PROVIDER_IDS.length).default([]),
  allowedEvents: z.array(eventName).max(100).optional(),
  respectGlobalPrivacyControl: z.boolean().default(true),
  respectDoNotTrack: z.boolean().default(true),
}).strict();

const conversionMap = z.record(eventName, identifier).superRefine((value, context) => {
  if (Object.keys(value).length > 100) {
    context.addIssue({ code: "custom", message: "conversion maps may contain at most 100 events" });
  }
});

export const providerConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("google-analytics"),
    enabled: z.boolean().default(true),
    measurementId: z.string().regex(/^G-[A-Z0-9]{4,20}$/),
  }).strict(),
  z.object({
    provider: z.literal("google-ads"),
    enabled: z.boolean().default(true),
    conversionId: z.string().regex(/^AW-[0-9]{4,20}$/),
    conversionLabels: conversionMap.default({}),
  }).strict(),
  z.object({
    provider: z.literal("meta"),
    enabled: z.boolean().default(true),
    pixelId: z.string().regex(/^[0-9]{5,30}$/),
  }).strict(),
  z.object({
    provider: z.literal("tiktok"),
    enabled: z.boolean().default(true),
    pixelId: z.string().regex(/^[A-Z0-9]{8,32}$/i),
  }).strict(),
  z.object({
    provider: z.literal("linkedin"),
    enabled: z.boolean().default(true),
    partnerId: z.string().regex(/^[0-9]{3,20}$/),
    conversionIds: conversionMap.default({}),
  }).strict(),
]);

export const providerConfigsSchema = z.array(providerConfigSchema).max(PROVIDER_IDS.length).superRefine((providers, context) => {
  const seen = new Set<string>();
  providers.forEach((provider, index) => {
    if (seen.has(provider.provider)) {
      context.addIssue({ code: "custom", message: `provider ${provider.provider} is configured more than once`, path: [index, "provider"] });
    }
    seen.add(provider.provider);
  });
});

export const evaluationRequestSchema = z.object({
  event: pixelEventSchema,
  consent: consentStateSchema,
  policy: pixelPolicySchema.partial().optional(),
  providers: providerConfigsSchema,
  signals: runtimeSignalsSchema.optional(),
}).strict();

export const configurationSchema = z.object({
  policy: pixelPolicySchema,
  providers: providerConfigsSchema,
}).strict();
