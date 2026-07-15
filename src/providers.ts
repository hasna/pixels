import type { ProviderDefinition, ProviderId } from "./types.js";

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>> = Object.freeze({
  "google-analytics": Object.freeze({
    id: "google-analytics",
    purpose: "analytics",
    displayName: "Google Analytics",
    scriptOrigins: ["https://www.googletagmanager.com"],
  }),
  "google-ads": Object.freeze({
    id: "google-ads",
    purpose: "advertising",
    displayName: "Google Ads",
    scriptOrigins: ["https://www.googletagmanager.com"],
  }),
  meta: Object.freeze({
    id: "meta",
    purpose: "advertising",
    displayName: "Meta Pixel",
    scriptOrigins: ["https://connect.facebook.net"],
  }),
  tiktok: Object.freeze({
    id: "tiktok",
    purpose: "advertising",
    displayName: "TikTok Pixel",
    scriptOrigins: ["https://analytics.tiktok.com"],
  }),
  linkedin: Object.freeze({
    id: "linkedin",
    purpose: "advertising",
    displayName: "LinkedIn Insight Tag",
    scriptOrigins: ["https://snap.licdn.com", "https://px.ads.linkedin.com"],
  }),
});

export function listProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS).map((provider) => ({
    ...provider,
    scriptOrigins: [...provider.scriptOrigins],
  }));
}
