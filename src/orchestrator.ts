import { evaluationRequestSchema, pixelPolicySchema, providerConfigsSchema } from "./schema.js";
import { PROVIDERS } from "./providers.js";
import type {
  DispatchResult,
  EvaluationRequest,
  EvaluationResult,
  PixelDispatcher,
  PixelEvent,
  PixelPolicy,
  ProviderConfig,
  ProviderDecision,
  ProviderId,
  RuntimeSignals,
} from "./types.js";

const EMPTY_PROVIDER_ALLOWLIST = Object.freeze([]) as unknown as ProviderId[];

export const DEFAULT_POLICY: PixelPolicy = Object.freeze({
  enabled: false,
  allowedProviders: EMPTY_PROVIDER_ALLOWLIST,
  respectGlobalPrivacyControl: true,
  respectDoNotTrack: true,
});

function freezePolicy(policy: PixelPolicy): PixelPolicy {
  return Object.freeze({
    ...policy,
    allowedProviders: Object.freeze([...policy.allowedProviders]) as unknown as ProviderId[],
    ...(policy.allowedEvents
      ? { allowedEvents: Object.freeze([...policy.allowedEvents]) as unknown as string[] }
      : {}),
  });
}

function freezeProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const frozen = providers.map((provider): ProviderConfig => {
    if (provider.provider === "google-ads") {
      return Object.freeze({ ...provider, conversionLabels: Object.freeze({ ...provider.conversionLabels }) });
    }
    if (provider.provider === "linkedin") {
      return Object.freeze({ ...provider, conversionIds: Object.freeze({ ...provider.conversionIds }) });
    }
    return Object.freeze({ ...provider });
  });
  return Object.freeze(frozen) as unknown as ProviderConfig[];
}

function decisionFor(
  event: PixelEvent,
  provider: ProviderConfig,
  policy: PixelPolicy,
  consent: EvaluationRequest["consent"],
  signals: RuntimeSignals,
): ProviderDecision {
  const definition = PROVIDERS[provider.provider];
  if (!policy.enabled) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "platform_disabled" };
  }
  if (!provider.enabled) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "provider_disabled" };
  }
  if (!policy.allowedProviders.includes(provider.provider)) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "provider_not_allowlisted" };
  }
  if (policy.allowedEvents && !policy.allowedEvents.includes(event.name)) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "event_not_allowlisted" };
  }
  if (provider.provider === "google-ads" && !provider.conversionLabels[event.name]) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "provider_event_unmapped" };
  }
  if (provider.provider === "linkedin" && !provider.conversionIds[event.name]) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "provider_event_unmapped" };
  }
  if (policy.respectGlobalPrivacyControl && signals.globalPrivacyControl) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "global_privacy_control" };
  }
  if (policy.respectDoNotTrack && signals.doNotTrack) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "do_not_track" };
  }
  if (!consent[definition.purpose]) {
    return { provider: provider.provider, purpose: definition.purpose, allowed: false, reason: "consent_missing" };
  }
  return { provider: provider.provider, purpose: definition.purpose, allowed: true, reason: "allowed" };
}

export function evaluatePixelEvent(input: EvaluationRequest): EvaluationResult {
  const parsed = evaluationRequestSchema.parse(input);
  const policy = pixelPolicySchema.parse({ ...DEFAULT_POLICY, ...(parsed.policy ?? {}) });
  const signals = parsed.signals ?? {};
  const decisions = parsed.providers.map((provider) => decisionFor(parsed.event, provider, policy, parsed.consent, signals));
  return {
    accepted: decisions.some((decision) => decision.allowed),
    event: parsed.event,
    decisions,
  };
}

export class PixelOrchestrator {
  readonly policy: PixelPolicy;
  readonly providers: ProviderConfig[];

  constructor(options: { policy?: Partial<PixelPolicy>; providers?: ProviderConfig[] } = {}) {
    this.policy = freezePolicy(pixelPolicySchema.parse({ ...DEFAULT_POLICY, ...(options.policy ?? {}) }));
    this.providers = freezeProviders(providerConfigsSchema.parse(options.providers ?? []));
  }

  evaluate(input: Omit<EvaluationRequest, "policy" | "providers">): EvaluationResult {
    return evaluatePixelEvent({
      ...input,
      policy: this.policy,
      providers: this.providers,
    });
  }

  async dispatch(
    input: Omit<EvaluationRequest, "policy" | "providers">,
    dispatcher: PixelDispatcher,
  ): Promise<DispatchResult> {
    const evaluation = this.evaluate(input);
    const allowed = new Set(
      evaluation.decisions.filter((decision) => decision.allowed).map((decision) => decision.provider),
    );
    const dispatched: DispatchResult["dispatched"] = [];
    const failed: DispatchResult["failed"] = [];

    for (const provider of this.providers) {
      if (!allowed.has(provider.provider)) continue;
      try {
        await dispatcher.dispatch(provider, evaluation.event);
        dispatched.push(provider.provider);
      } catch (error) {
        failed.push({
          provider: provider.provider,
          message: error instanceof Error ? error.message : "provider dispatch failed",
        });
      }
    }

    return { evaluation, dispatched, failed };
  }
}
