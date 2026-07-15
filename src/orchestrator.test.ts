import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, PixelOrchestrator, evaluatePixelEvent } from "./orchestrator.js";
import type { EvaluationRequest, ProviderConfig } from "./types.js";

const ga: ProviderConfig = { provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" };
const meta: ProviderConfig = { provider: "meta", enabled: true, pixelId: "123456789" };

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    event: { name: "page_view", properties: { section: "news" } },
    consent: { analytics: true, advertising: true },
    providers: [ga, meta],
    ...overrides,
  };
}

function permutations(tokens: string[]): string[][] {
  if (tokens.length <= 1) return [tokens];
  return tokens.flatMap((token, index) => permutations([
    ...tokens.slice(0, index),
    ...tokens.slice(index + 1),
  ]).map((remainder) => [token, ...remainder]));
}

describe("evaluatePixelEvent", () => {
  test("is disabled and empty-allowlist by default", () => {
    expect(DEFAULT_POLICY.enabled).toBeFalse();
    expect(DEFAULT_POLICY.allowedProviders).toEqual([]);
    const output = evaluatePixelEvent(request());
    expect(output.accepted).toBeFalse();
    expect(output.decisions.every((decision) => decision.reason === "platform_disabled")).toBeTrue();
  });

  test("allows only explicitly allowlisted providers with purpose consent", () => {
    const output = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      consent: { analytics: true, advertising: false },
    }));
    expect(output.decisions).toEqual([
      { provider: "google-analytics", purpose: "analytics", allowed: true, reason: "allowed" },
      { provider: "meta", purpose: "advertising", allowed: false, reason: "consent_missing" },
    ]);
  });

  test("privacy signals override granted consent", () => {
    const gpc = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      signals: { globalPrivacyControl: true },
    }));
    expect(gpc.decisions.every((decision) => decision.reason === "global_privacy_control")).toBeTrue();

    const dnt = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      signals: { doNotTrack: true },
    }));
    expect(dnt.decisions.every((decision) => decision.reason === "do_not_track")).toBeTrue();
  });

  test("requires configured conversion mappings", () => {
    const output = evaluatePixelEvent(request({
      policy: { enabled: true, allowedProviders: ["google-ads", "linkedin"] },
      providers: [
        { provider: "google-ads", enabled: true, conversionId: "AW-123456", conversionLabels: {} },
        { provider: "linkedin", enabled: true, partnerId: "12345", conversionIds: {} },
      ],
    }));
    expect(output.decisions.every((decision) => decision.reason === "provider_event_unmapped")).toBeTrue();
  });

  test("rejects direct PII keys, embedded values, IP addresses, and nested variants", () => {
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { email: "person@example.test" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "person@example.test" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "send to person@example.test now" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "+15551234567" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: 15551234567 } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { mobile: 15551234567 } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { telephone: 15551234567 } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: "call (555) 123-4567 today" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { clientIp: "203.0.113.42" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { server: "203.0.113.42:443" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { server: "fe80::1%eth0" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { eMail: "redacted" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { "e-mail": "redacted" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { IPAddress: "redacted" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { userAgent: "redacted" } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { metadata: { remoteAddress: "2001:db8::1" } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { firstName: "Ada" } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { firstname: "Ada" } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { name: "Ada" } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { contact: { value: 15551234567 } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { profile: { mobile: { value: 15551234567 } } } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { phones: [15551234567] } } }))).toThrow();
    expect(() => evaluatePixelEvent(request({ event: { name: "lead", properties: { note: "call 15551234567 now" } } }))).toThrow();
  });

  test("rejects plural PII ancestry across spelling, nesting, arrays, and scalar forms", () => {
    const blockedCases: Array<[string, Record<string, unknown>]> = [
      ["plural contacts numeric array", { contacts: [15551234567] }],
      ["plural contacts string array", { contacts: ["15551234567"] }],
      ["uppercase plural contacts", { CONTACTS: [15551234567] }],
      ["nested plural contacts", { profile: { contacts: [15551234567] } }],
      ["plural container array ancestry", { profiles: [{ contacts: ["15551234567"] }] }],
      ["separator contact ancestry", { "contact-groups": [{ values: [15551234567] }] }],
      ["camel phone numbers", { phoneNumbers: [15551234567] }],
      ["separator phone numbers", { phone_numbers: ["15551234567"] }],
      ["compact plural phone numbers", { phonenumbers: [15551234567] }],
      ["contact number key", { contactNumbers: "redacted" }],
      ["compact contact values numeric array", { contactvalues: [15551234567] }],
      ["compact contact values string array", { contactvalues: ["15551234567"] }],
      ["compact plural first names", { firstnames: "Ada" }],
      ["compact plural last names", { lastnames: "L" }],
      ["compact plural full names", { fullnames: "Ada L" }],
      ["uppercase compact plural names", { FIRSTNAMES: "Ada" }],
      ["separator plural names", { "first-names": "Ada" }],
      ["snake plural names", { last_names: "L" }],
    ];

    for (const [label, properties] of blockedCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).toThrow();
    }
  });

  test("rejects compound human-name keys while preserving non-person entity names", () => {
    const personalContexts = [
      "display", "customer", "contact", "user", "profile",
      "member", "person", "people", "recipient", "author", "visitor",
    ];
    const blockedCases: Array<[string, Record<string, unknown>]> = personalContexts.flatMap((context) => [
      [`camel ${context} name`, { [`${context}Name`]: "Ada Lovelace" }],
      [`snake plural ${context} names`, { [`${context}_names`]: "Ada Lovelace" }],
      [`kebab ${context} name`, { [`${context}-name`]: "Ada Lovelace" }],
      [`compact plural ${context} names`, { [`${context}names`]: "Ada Lovelace" }],
      [`uppercase compact ${context} names`, { [`${context.toUpperCase()}NAMES`]: "Ada Lovelace" }],
    ] as Array<[string, Record<string, unknown>]>);
    blockedCases.push(
      ["human-name token before customer context", { nameOfCustomer: "Ada Lovelace" }],
      ["human-name token with trailing label", { customerNameLabel: "Ada Lovelace" }],
      ["profile display name ancestry", { profile: { displayName: "Ada Lovelace" } }],
      ["profile preferred name ancestry", { profile: { preferredName: "Ada Lovelace" } }],
      ["plural profile legal names ancestry", { profiles: [{ legal_names: "Ada Lovelace" }] }],
      ["customer ancestry through an array", { customers: [{ preferredName: "Ada Lovelace" }] }],
      ["nested recipient profile ancestry", {
        metadata: { recipientProfile: { preferred_names: ["Ada Lovelace"] } },
      }],
    );

    for (const [label, properties] of blockedCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).toThrow();
    }

    const entityContexts = [
      "event", "product", "company", "organization", "campaign", "category", "file",
    ];
    const safeCases: Array<[string, Record<string, unknown>]> = entityContexts.flatMap((context) => [
      [`camel ${context} name`, { [`${context}Name`]: "Research Journal" }],
      [`snake plural ${context} names`, { [`${context}_names`]: ["Research Journal"] }],
      [`kebab ${context} name`, { [`${context}-name`]: "Research Journal" }],
      [`compact plural ${context} names`, { [`${context}names`]: ["Research Journal"] }],
      [`uppercase compact ${context} names`, { [`${context.toUpperCase()}NAMES`]: "Research Journal" }],
    ] as Array<[string, Record<string, unknown>]>);
    safeCases.push(
      ["safe entity name within profile ancestry", {
        profile: { productName: "Nutrition Journal Plus", companyName: "Hasna Inc." },
      }],
      ["safe entity names in nested arrays", {
        metadata: [{ campaign_names: ["organic-search"], file_names: ["index.html"] }],
      }],
      ["personal-context identifiers and counts", {
        customerId: "customer_123", contactCount: 4, memberIndex: 7, visitorTotal: 10,
      }],
      ["ordinary contact text", { contactNote: "reach the support team" }],
    );

    for (const [label, properties] of safeCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "page_view", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).not.toThrow();
    }
  });

  test("rejects generated compact personal-name semantics in any token order", () => {
    const tokenSequences = [
      ["name", "of", "customer"],
      ["names", "of", "customers"],
      ...permutations(["customer", "name", "label"]),
      ...permutations(["customers", "names", "labels"]),
      ["label", "name", "recipient"],
      ["visitor", "detail", "full", "name"],
    ];
    const renderers: Array<[string, (tokens: string[]) => string]> = [
      ["compact", (tokens) => tokens.join("")],
      ["uppercase compact", (tokens) => tokens.join("").toUpperCase()],
      ["camel", (tokens) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join("")],
      ["snake", (tokens) => tokens.join("_")],
      ["kebab", (tokens) => tokens.join("-")],
    ];

    for (const tokens of tokenSequences) {
      for (const [style, render] of renderers) {
        const key = render(tokens);
        expect(() => evaluatePixelEvent(request({
          event: { name: "lead", properties: { [key]: "Ada Lovelace" } },
        })), `${style} ${tokens.join(" ")}`).toThrow();
      }
    }

    const nestedCases: Array<[string, Record<string, unknown>]> = [
      ["nested compact name of customer", { customerdata: { nameofcustomer: "Ada Lovelace" } }],
      ["array compact customer name label", {
        profiles: [{ customernamelabel: "Ada Lovelace" }],
      }],
      ["nested plural compact customer names label", {
        records: { customernameslabel: ["Ada Lovelace"] },
      }],
      ["compact customer name field", { customernamefield: "Ada Lovelace" }],
      ["compact name of customer attribute", { nameofcustomerattribute: "Ada Lovelace" }],
    ];
    for (const [label, properties] of nestedCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).toThrow();
    }
  });

  test("rejects generated compact contact-phone semantics while preserving safe leaves", () => {
    const phoneSequences = [
      ...permutations(["contact", "phone", "number"]),
      ...permutations(["contacts", "phone", "numbers"]),
      ["phone", "of", "contact"],
      ["telephone", "of", "customer"],
      ["member", "mobile", "number"],
    ];
    const renderers: Array<[string, (tokens: string[]) => string]> = [
      ["compact", (tokens) => tokens.join("")],
      ["uppercase compact", (tokens) => tokens.join("").toUpperCase()],
      ["camel", (tokens) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join("")],
      ["snake", (tokens) => tokens.join("_")],
      ["kebab", (tokens) => tokens.join("-")],
    ];
    for (const tokens of phoneSequences) {
      for (const [style, render] of renderers) {
        const key = render(tokens);
        expect(() => evaluatePixelEvent(request({
          event: { name: "lead", properties: { [key]: 15551234567 } },
        })), `${style} ${tokens.join(" ")}`).toThrow();
      }
    }

    const nestedCases: Array<[string, Record<string, unknown>]> = [
      ["compact contact details value", { contactdetails: { value: 15551234567 } }],
      ["compact customer contacts array value", {
        customercontacts: [{ value: 15551234567 }],
      }],
      ["compact member contact info value", { membercontactinfo: { value: "15551234567" } }],
      ["compact customer contact information value", {
        customercontactinformation: { value: "15551234567" },
      }],
      ["compact contact phone numbers array", { contactphonenumbers: [15551234567] }],
      ["compact contact phone number value", { contactphonenumbervalue: 15551234567 }],
    ];
    for (const [label, properties] of nestedCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).toThrow();
    }

    const safeCases: Array<[string, Record<string, unknown>]> = [
      ["safe compact entity names", {
        eventname: "page_view",
        productnames: ["Nutrition Journal"],
        COMPANYNAME: "Hasna Inc.",
        organizationnames: ["Hasna Inc."],
        campaignnamelabel: "organic-search",
        campaignnamefield: "utm_campaign",
        companynamedescription: "publisher",
        categorynames: ["research"],
        filenames: ["index.html"],
      }],
      ["safe compact numeric leaves", {
        customercontactid: 15551234567,
        contactcount: 15551234567,
        phonecount: 15551234567,
        orderid: 15551234567,
        amount: 15551234567,
      }],
      ["safe contact text", {
        contactnote: "reach the support team",
        contacttext: "support desk",
        authoritativeName: "primary-dns-record",
        hostname: "news.example.test",
        domainName: "example.test",
      }],
    ];
    for (const [label, properties] of safeCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "page_view", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).not.toThrow();
    }
  });

  test("accepts safe identifiers, dotted versions, and email-like non-address text", () => {
    expect(() => evaluatePixelEvent(request({
      event: {
        name: "page_view",
        properties: {
          campaign: "spring@example",
          release: "version 1.2.3",
          publishDate: "2026-07-15",
          compactDate: "20260715",
          releaseTrain: "2026.07.15",
          orderId: "order_12345678",
          numericStringOrderId: "15551234567",
          nestedNumericOrderId: { orderId: "15551234567" },
          numericOrderId: 15551234567,
          amount: 15551234567,
          counter: 15551234567,
          contactCount: 15551234567,
          network: { ipVersion: "IPv6", regions: ["north", "west"] },
        },
      },
    }))).not.toThrow();
  });

  test("does not treat plural safe identifiers, counters, amounts, or ordinary contact text as PII", () => {
    const safeCases: Array<[string, Record<string, unknown>]> = [
      ["ordinary contacts", { contacts: ["support team", "wholesale desk"] }],
      ["plural order ids", { orderIds: [15551234567, "15551234567"] }],
      ["snake plural order ids", { order_ids: [15551234567, "15551234567"] }],
      ["plural amounts", { amounts: [15551234567, "15551234567"] }],
      ["plural counters", { counters: [15551234567, "15551234567"] }],
      ["plural counts", { counts: [15551234567, "15551234567"] }],
      ["contact count", { contactCount: 15551234567 }],
      ["phone count", { phoneCount: 15551234567 }],
      ["email count", { emailCount: 15551234567 }],
      ["name counter", { nameCounter: 15551234567 }],
      ["nested safe leaf overrides contact ancestry", {
        contacts: [{ orderId: 15551234567, amount: 15551234567, counter: 15551234567 }],
      }],
      ["ordinary non-PII strings", { campaign: "summer-2026", note: "contact the support team" }],
    ];

    for (const [label, properties] of safeCases) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "page_view", properties: properties as EvaluationRequest["event"]["properties"] },
      })), label).not.toThrow();
    }
  });

  test("rejects duplicate providers", () => {
    expect(() => evaluatePixelEvent(request({ providers: [ga, ga] }))).toThrow();
  });

  test("rejects unknown keys and over-broad property maps", () => {
    const properties = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`field_${index}`, index]));
    expect(() => evaluatePixelEvent(request({ event: { name: "wide", properties } }))).toThrow();
    expect(() => evaluatePixelEvent({ ...request(), extra: true } as EvaluationRequest)).toThrow();
  });
});

describe("PixelOrchestrator", () => {
  test("freezes policy and provider configuration after validation", () => {
    const orchestrator = new PixelOrchestrator({
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [ga],
    });
    expect(Object.isFrozen(orchestrator.policy)).toBeTrue();
    expect(Object.isFrozen(orchestrator.policy.allowedProviders)).toBeTrue();
    expect(Object.isFrozen(orchestrator.providers)).toBeTrue();
    expect(Object.isFrozen(orchestrator.providers[0])).toBeTrue();
    expect(() => orchestrator.policy.allowedProviders.push("meta")).toThrow();
  });

  test("dispatches allowed providers and contains provider failures", async () => {
    const orchestrator = new PixelOrchestrator({
      policy: { enabled: true, allowedProviders: ["google-analytics", "meta"] },
      providers: [ga, meta],
    });
    const result = await orchestrator.dispatch({
      event: { name: "page_view" },
      consent: { analytics: true, advertising: true },
    }, {
      dispatch(provider) {
        if (provider.provider === "meta") throw new Error("test failure");
      },
    });
    expect(result.dispatched).toEqual(["google-analytics"]);
    expect(result.failed).toEqual([{ provider: "meta", message: "test failure" }]);
  });
});
