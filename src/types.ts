export const PROVIDER_IDS = [
  "google-analytics",
  "google-ads",
  "meta",
  "tiktok",
  "linkedin",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];
export type ConsentPurpose = "analytics" | "advertising";
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | PropertyValue[]
  | { [key: string]: PropertyValue };

export interface PixelEvent {
  name: string;
  eventId?: string;
  timestamp?: string;
  properties?: Record<string, PropertyValue>;
  context?: {
    url?: string;
    referrer?: string;
    title?: string;
  };
}

export interface ConsentState {
  analytics: boolean;
  advertising: boolean;
  source?: "banner" | "settings" | "api" | "unknown";
  updatedAt?: string;
}

export interface PixelPolicy {
  enabled: boolean;
  allowedProviders: ProviderId[];
  allowedEvents?: string[];
  respectGlobalPrivacyControl: boolean;
  respectDoNotTrack: boolean;
}

export interface RuntimeSignals {
  globalPrivacyControl?: boolean;
  doNotTrack?: boolean;
}

export interface GoogleAnalyticsConfig {
  provider: "google-analytics";
  enabled: boolean;
  measurementId: string;
}

export interface GoogleAdsConfig {
  provider: "google-ads";
  enabled: boolean;
  conversionId: string;
  conversionLabels: Record<string, string>;
}

export interface MetaConfig {
  provider: "meta";
  enabled: boolean;
  pixelId: string;
}

export interface TikTokConfig {
  provider: "tiktok";
  enabled: boolean;
  pixelId: string;
}

export interface LinkedInConfig {
  provider: "linkedin";
  enabled: boolean;
  partnerId: string;
  conversionIds: Record<string, string>;
}

export type ProviderConfig =
  | GoogleAnalyticsConfig
  | GoogleAdsConfig
  | MetaConfig
  | TikTokConfig
  | LinkedInConfig;

export type DecisionReason =
  | "allowed"
  | "platform_disabled"
  | "provider_disabled"
  | "provider_not_allowlisted"
  | "event_not_allowlisted"
  | "provider_event_unmapped"
  | "consent_missing"
  | "global_privacy_control"
  | "do_not_track";

export interface ProviderDecision {
  provider: ProviderId;
  purpose: ConsentPurpose;
  allowed: boolean;
  reason: DecisionReason;
}

export interface EvaluationRequest {
  event: PixelEvent;
  consent: ConsentState;
  policy?: Partial<PixelPolicy>;
  providers: ProviderConfig[];
  signals?: RuntimeSignals;
}

export interface EvaluationResult {
  accepted: boolean;
  event: PixelEvent;
  decisions: ProviderDecision[];
}

export interface DispatchResult {
  evaluation: EvaluationResult;
  dispatched: ProviderId[];
  failed: Array<{ provider: ProviderId; message: string }>;
}

export interface PixelDispatcher {
  dispatch(provider: ProviderConfig, event: PixelEvent): Promise<void> | void;
}

export interface ProviderDefinition {
  id: ProviderId;
  purpose: ConsentPurpose;
  displayName: string;
  scriptOrigins: string[];
}
