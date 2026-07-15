import { z } from "zod";
import { PROVIDER_IDS } from "./types.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const eventName = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const propertyValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const blockedPropertyKeys = /(?:^|[_-])(?:e-?mail|phone|first_?name|last_?name|full_?name|address|street|postal_?code|zip|ip|user_?agent)(?:$|[_-])/i;
const directEmailValue = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const directPhoneValue = /^\+?[1-9][0-9]{7,14}$/;
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
  for (const [key, value] of entries) {
    if (blockedPropertyKeys.test(key)) {
      context.addIssue({
        code: "custom",
        message: `property ${key} may contain direct personal information and is not allowed`,
        path: ["properties", key],
      });
    }
    if (typeof value === "string" && (directEmailValue.test(value) || directPhoneValue.test(value))) {
      context.addIssue({
        code: "custom",
        message: `property ${key} appears to contain direct personal information and is not allowed`,
        path: ["properties", key],
      });
    }
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
