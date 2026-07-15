import { isIP } from "node:net";
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

function propertyKeyTokens(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function blockedPropertyKey(key: string): boolean {
  const tokens = propertyKeyTokens(key);
  const normalized = tokens.join("_");
  if (/(?:^|_)e_mail(?:_|$)/.test(normalized)) return true;
  if (tokens.some((token) => ["email", "phone", "address", "street", "zip"].includes(token))) return true;
  if (/(?:^|_)(?:first|last|full)_name(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)postal_code(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)user_agent(?:_|$)/.test(normalized)) return true;
  if (normalized === "ip" || /(?:^|_)(?:client|remote|source|user|visitor)_ip(?:_|$)/.test(normalized)) return true;
  return /(?:^|_)ip_address(?:_|$)/.test(normalized);
}

function numericPhonePropertyKey(key: string): boolean {
  const tokens = propertyKeyTokens(key);
  const normalized = tokens.join("_");
  if (tokens.some((token) => ["phone", "mobile", "telephone", "tel", "cellphone"].includes(token))) {
    return !tokens.some((token) => ["count", "id", "index", "rank", "total"].includes(token));
  }
  return ["contact", "contact_number", "contact_value"].includes(normalized);
}

function isNumericPhone(value: number, path: Array<string | number>): boolean {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  const propertyKey = path.findLast((item): item is string => typeof item === "string");
  if (!propertyKey || !numericPhonePropertyKey(propertyKey)) return false;
  const digits = String(value);
  return digits.length >= 8 && digits.length <= 15;
}

function containsPhone(value: string): boolean {
  const candidates = value.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return candidates.some((candidate) => {
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(candidate.trim())) return false;
    if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(candidate.trim())) return false;
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    return candidate.includes("+") || /[\s().-]/.test(candidate) || candidate.trim() === value.trim();
  });
}

function containsIpAddress(value: string): boolean {
  const candidates = value.split(/[\s,;()[\]{}<>"'=/?#]+/).filter(Boolean);
  return candidates.some((candidate) => {
    if (isIP(candidate) !== 0) return true;
    const withoutZone = candidate.replace(/%[^:]+$/, "");
    if (isIP(withoutZone) !== 0) return true;
    const withoutPort = withoutZone.match(/^(.+):\d{1,5}$/)?.[1];
    if (withoutPort && isIP(withoutPort) !== 0) return true;
    return isIP(withoutZone.replace(/^[.,]+|[.,]+$/g, "")) !== 0;
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
    if (embeddedEmailValue.test(value) || containsPhone(value) || containsIpAddress(value)) {
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
      if (blockedPropertyKey(key)) {
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
    if (blockedPropertyKey(key)) {
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
