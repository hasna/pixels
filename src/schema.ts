import { z } from "zod";
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

const mixedScriptAsciiConfusables: Readonly<Record<string, string>> = Object.freeze({
  // Greek characters commonly substituted into otherwise-Latin identifiers.
  "α": "a",
  "β": "b",
  "ε": "e",
  "ι": "i",
  "κ": "k",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "χ": "x",
  // Cyrillic characters commonly substituted into otherwise-Latin identifiers.
  "а": "a",
  "в": "b",
  "е": "e",
  "і": "i",
  "ј": "j",
  "к": "k",
  "м": "m",
  "н": "h",
  "о": "o",
  "р": "p",
  "с": "c",
  "т": "t",
  "у": "y",
  "х": "x",
});

function foldMixedScriptAsciiConfusables(value: string): string {
  return value.replace(/[\p{L}\p{N}]+/gu, (word) => {
    if (!/[a-z]/i.test(word)) return word;
    if (![...word].some((character) => mixedScriptAsciiConfusables[character] !== undefined)) {
      return word;
    }
    return [...word].map((character) => mixedScriptAsciiConfusables[character] ?? character).join("");
  });
}

/**
 * Produces a classification-only copy of a property key. The original key is
 * retained in the event and in validation errors. Compatibility decomposition
 * plus mark removal makes NFC/NFD and accented Latin renderings equivalent;
 * upper/lower expansion approximates Unicode default case folding. A bounded
 * confusable skeleton is applied only to mixed ASCII/Greek/Cyrillic words, so
 * ordinary non-Latin metadata is not transliterated or blanket-rejected.
 */
function classificationPropertyKey(key: string): string {
  const decomposed = key.normalize("NFKD").replace(/\p{M}+/gu, "");
  const separated = decomposed
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1_$2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1_$2");
  return foldMixedScriptAsciiConfusables(separated.toUpperCase().toLowerCase());
}

function propertyKeyTokens(key: string): string[] {
  return classificationPropertyKey(key)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
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

function semanticVariantsAt(token: string, offset: number): ReadonlyArray<readonly [string, string]> {
  return semanticPropertyWordVariantsByInitial.get(token[offset] ?? "") ?? [];
}

function segmentCompactPropertyToken(token: string): string[] | null {
  const memo = new Map<number, string[] | null>();

  function visit(offset: number): string[] | null {
    if (offset === token.length) return [];
    if (memo.has(offset)) return memo.get(offset)!;

    for (const [variant, canonical] of semanticVariantsAt(token, offset)) {
      if (!token.startsWith(variant, offset)) continue;
      const remainder = visit(offset + variant.length);
      if (remainder) {
        const result = [canonical, ...remainder];
        memo.set(offset, result);
        return result;
      }
    }

    memo.set(offset, null);
    return null;
  }

  return visit(0);
}

interface SemanticPropertyRun {
  readonly start: number;
  readonly end: number;
  readonly tokens: readonly string[];
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
      if (!token.startsWith(variant, offset)) continue;
      const nextOffset = offset + variant.length;
      const remainder = longestRunFrom(nextOffset);
      const candidate = {
        end: remainder?.end ?? nextOffset,
        tokens: [canonical, ...(remainder?.tokens ?? [])],
      };
      if (!best
        || candidate.end > best.end
        || (candidate.end === best.end && candidate.tokens.length > best.tokens.length)) {
        best = candidate;
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
  return propertyKeyTokens(key).flatMap((token) =>
    segmentCompactPropertyToken(token) ?? [canonicalPropertyToken(token)]);
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
    if (isHighRiskSemanticPhrase(run.tokens)
      && (run.end === rawToken.length || isBoundedHighRiskAnchorPair(run.tokens))) {
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
        if (!remaining.startsWith(variant)) continue;
        const isPersonal = personalNameContextTokens.has(canonicalPersonalContextToken(word));
        if (visit(remaining.slice(variant.length), foundPersonalContext || isPersonal)) {
          memo.set(memoKey, true);
          return true;
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
  if (safeNonPersonNameKeys.has(compact)) return false;
  if (!hasPersonalContextToken(terms) && hasExplicitSafeNonPersonNameSemantic(key, exactTerms)) return false;
  if (directHumanNameKeys.has(compact)) return true;
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
  const normalized = tokens.join("_");
  const compact = tokens.join("");
  if (hasSafeNumericLeafSemantic(key)) return false;
  if (/(?:^|_)e_mail(?:_|$)/.test(normalized)) return true;
  if (recognizedTokens.some((token) => ["email", "address", "street", "zip"].includes(token))) return true;
  if (recognizedTokens.some((token) => directPhoneSemanticTokens.has(token))
    && !isExplicitSafePhoneContext(recognizedTokens)) return true;
  if (["contactnumber", "mobilenumber", "telephonenumber", "cellphonenumber"].includes(compact)) return true;
  if (blockedHumanNameKey(key, path)) return true;
  if (/(?:^|_)postal_code(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)user_agent(?:_|$)/.test(normalized)) return true;
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
