import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, PixelOrchestrator, evaluatePixelEvent } from "./orchestrator.js";
import type { EvaluationRequest, PropertyValue, ProviderConfig } from "./types.js";

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

  test("rejects common cell-number renderings", () => {
    const cellNumberKeys = [
      "cellnumber",
      "cellNumber",
      "cell_number",
      "cell-number",
      "cell.number",
      "CELLNUMBER",
      "primaryCellNumber",
      "billing_cell_number",
      "billingphone",
      "emergencyTelephone",
      "homephone",
      "home-mobile",
      "personalphone",
      "work.tel",
      "supportCell",
    ];
    for (const key of cellNumberKeys) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: { [key]: 15551234567 } },
      })), key).toThrow();
    }
  });

  test("does not treat entity names or embedded words as PII tokens", () => {
    const safeProperties = {
      orgName: "Hasna",
      primaryOrgName: "Hasna",
      ORGANIZATION_NAME: "Hasna",
      saxophone: "alto",
      headphones: "studio",
      zipper: "metal",
      streetwear: "summer",
      addressablemarket: 42,
      mobilegame: "puzzle",
      codename: "apollo",
      projectname: "pixels",
      teamname: "growth",
      appname: "news",
    };
    expect(() => evaluatePixelEvent(request({
      event: { name: "page_view", properties: safeProperties },
    }))).not.toThrow();
  });

  test("rejects high-risk semantic pairs across bounded unknown modifiers", () => {
    const hostileKeys = [
      "contactqzxphone",
      "phoneqzxcontact",
      "cellneutralxnumber",
      "customerqzxname",
      "nameqzxcustomer",
      "recipientqzxfullname",
    ];
    for (const key of hostileKeys) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: { [key]: 15551234567 } },
      })), key).toThrow();
    }
  });

  test("rejects cellular phone fields and explicit personal-name contexts", () => {
    const renderers = [
      (tokens: string[]) => tokens.join(""),
      (tokens: string[]) => tokens.join("").toUpperCase(),
      (tokens: string[]) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join(""),
      (tokens: string[]) => tokens.join("_"),
      (tokens: string[]) => tokens.join("-"),
      (tokens: string[]) => tokens.join("."),
    ];
    const hostilePhrases = [
      ["cellular", "number"], ["number", "cellular"],
      ["cellular", "phone"], ["phone", "cellular"],
      ["personal", "name"], ["name", "personal"],
      ["personal", "surname"], ["surname", "personal"],
    ];

    for (const phrase of hostilePhrases) {
      for (const render of renderers) {
        const key = render(phrase);
        expect(() => evaluatePixelEvent(request({
          event: { name: "lead", properties: { [key]: 15551234567 } },
        })), key).toThrow();
      }
    }
  });

  test("preserves explicit non-person cellular and mobile product contexts", () => {
    const renderers = [
      (tokens: string[]) => tokens.join(""),
      (tokens: string[]) => tokens.join("").toUpperCase(),
      (tokens: string[]) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join(""),
      (tokens: string[]) => tokens.join("_"),
      (tokens: string[]) => tokens.join("-"),
      (tokens: string[]) => tokens.join("."),
    ];
    const safePhrases = [
      ["cellular", "network"], ["cellular", "networks"],
      ["cellular", "data"], ["cellular", "plan"],
      ["mobile", "game"], ["mobile", "platform"],
      ["phone", "service"], ["telephone", "carrier"],
      ["cellular", "organization"], ["cellular", "org"],
      ["cellular", "app"], ["cellular", "code"],
      ["cellular", "project"], ["cellular", "team"],
      ["mobile", "organization"], ["phone", "provider"],
      ["telephone", "standard"], ["tel", "protocol"],
      ["cellphone", "band"], ["cell", "technology"],
      ["cellular", "company"], ["mobile", "event"],
    ];

    for (const phrase of safePhrases) {
      for (const render of renderers) {
        const key = render(phrase);
        expect(() => evaluatePixelEvent(request({
          event: { name: "page_view", properties: { [key]: "ordinary non-person value" } },
        })), key).not.toThrow();
      }
    }
    expect(() => evaluatePixelEvent(request({
      event: {
        name: "page_view",
        properties: {
          primaryCellularNetwork: "5g",
          safe0xCellularOrganization: "Network operator",
          safe0x_cellular_org: "Network operator",
          "safe0x-cellular-app": "Dialer product",
          "safe0x.cellular.project": "Network roadmap",
          preferredCellularApp: "Dialer product",
          personalProjectName: "Research Journal",
          personal_project_name: "Research Journal",
        },
      },
    }))).not.toThrow();
    expect(() => evaluatePixelEvent(request({
      event: { name: "lead", properties: { cellularNetwork: 15551234567 } },
    }))).toThrow();
    for (const key of [
      "cellularNumber",
      "cellularAppNumber",
      "contactCellularApp",
      "personCellularOrganization",
      "cellularOrganizationAddress",
      "personalName",
    ]) {
      expect(() => evaluatePixelEvent(request({
        event: { name: "lead", properties: { [key]: 15551234567 } },
      })), key).toThrow();
    }
    const entityDescriptors = [
      "org", "organization", "app", "application", "code", "company", "event", "project", "team",
      "network", "provider", "carrier", "standard", "protocol", "band", "technology", "plan",
      "product", "service", "campaign", "category", "file", "domain", "host",
    ];
    for (const descriptor of entityDescriptors) {
      for (const phrase of [
        ["contact", "cellular", descriptor],
        ["person", "cellular", descriptor],
        ["personal", "cellular", descriptor],
        ["cellular", descriptor, "value"],
        ["cellular", descriptor, "number"],
        ["cellular", descriptor, "address"],
      ]) {
        for (const render of renderers) {
          const key = render(phrase);
          expect(() => evaluatePixelEvent(request({
            event: { name: "lead", properties: { [key]: 15551234567 } },
          })), key).toThrow();
        }
      }
    }
  });

  test("rejects compact personal semantics surrounded by bounded modifier spans", () => {
    const modifiers = [
      "primary", "billing", "emergency", "shipping", "alternate", "preferred", "secondary",
      "qzx", "neutralx",
    ];
    const hostileSemantics = [
      ["contact", "phone"],
      ["contact", "number"],
      ["customer", "name"],
      ["holder", "name"],
    ];

    for (const modifier of modifiers) {
      for (const semantics of hostileSemantics) {
        const keys = [
          `${modifier}${semantics.join("")}`,
          `${semantics.join("")}${modifier}`,
          `${modifier}${semantics.join("")}tailx`,
          `${modifier.toUpperCase()}${semantics.join("").toUpperCase()}`,
        ];
        for (const key of keys) {
          expect(() => evaluatePixelEvent(request({
            event: { name: "lead", properties: { [key]: 15551234567 } },
          })), key).toThrow();
        }
      }
    }
  });

  test("accepts every safe numeric leaf rendering beneath compact contact ancestry", () => {
    const safeLeaves = [
      "id", "identifier", "count", "counter", "index", "rank", "total", "amount", "price", "quantity",
    ];
    const plurals: Record<string, string> = {
      id: "ids",
      identifier: "identifiers",
      count: "counts",
      counter: "counters",
      index: "indices",
      rank: "ranks",
      total: "totals",
      amount: "amounts",
      price: "prices",
      quantity: "quantities",
    };
    const renderers = [
      (leaf: string) => `contact${leaf}`,
      (leaf: string) => `contact${plurals[leaf]}`,
      (leaf: string) => `contact_${leaf}`,
      (leaf: string) => `contact-${leaf}`,
      (leaf: string) => `CONTACT${leaf.toUpperCase()}`,
      (leaf: string) => `billingcontact${leaf}`,
    ];

    for (const leaf of safeLeaves) {
      for (const render of renderers) {
        const key = render(leaf);
        expect(() => evaluatePixelEvent(request({
          event: {
            name: "page_view",
            properties: { customercontacts: [{ [key]: 15551234567 }] },
          },
        })), key).not.toThrow();
      }
    }
  });

  test("keeps a generated modifier corpus fail-closed with a zero false-positive budget", () => {
    const modifiers = [
      "primary", "billing", "emergency", "shipping", "alternate", "preferred", "secondary",
      "qzx", "neutralx",
    ];
    const renderers = [
      (tokens: string[]) => tokens.join(""),
      (tokens: string[]) => tokens.join("").toUpperCase(),
      (tokens: string[]) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join(""),
      (tokens: string[]) => tokens.join("_"),
      (tokens: string[]) => tokens.join("-"),
      (tokens: string[]) => tokens.join("."),
    ];
    const hostileSemantics = [
      ["contact", "phone"],
      ["contact", "number"],
      ["customer", "name"],
      ["holder", "name"],
      ["recipient", "full", "name"],
      ["member", "mobile", "number"],
    ];
    const hostileKeys = new Set<string>();
    for (const modifier of modifiers) {
      for (const semantic of hostileSemantics) {
        for (const tokens of [
          [modifier, ...semantic],
          [...semantic, modifier],
          [modifier, ...semantic, "tailx"],
        ]) {
          for (const render of renderers) hostileKeys.add(render(tokens));
        }
      }
    }
    const missedHostileKeys = [...hostileKeys].filter((key) => {
      try {
        evaluatePixelEvent(request({ event: { name: "lead", properties: { [key]: 15551234567 } } }));
        return true;
      } catch {
        return false;
      }
    });
    expect(hostileKeys.size).toBeGreaterThanOrEqual(455);
    expect(missedHostileKeys).toEqual([]);

    const safeNumericLeaves = [
      "id", "identifier", "count", "counter", "index", "rank", "total", "amount", "price", "quantity",
    ];
    const safeEntityNames = ["event", "product", "company", "organization", "campaign", "category", "file"];
    const safeNameStructures = [
      (entity: string) => [entity, "name"],
      (entity: string) => [entity, "name", "label"],
      (entity: string) => [entity, "name", "field"],
      (entity: string) => [entity, "name", "description"],
      (entity: string) => ["name", "of", entity],
      (entity: string) => [entity, "metadata", "name"],
      (entity: string) => [entity, "name", "value"],
      (entity: string) => [entity, "name", "key"],
      (entity: string) => [entity, "name", "attribute"],
      (entity: string) => [entity, "name", "detail"],
      (entity: string) => [entity, "name", "record"],
    ];
    const safeCases = new Map<string, Record<string, unknown>>();
    for (const modifier of modifiers) {
      for (const leaf of safeNumericLeaves) {
        for (const render of renderers) {
          const key = render([modifier, "contact", leaf]);
          safeCases.set(key, { customercontacts: [{ [key]: 15551234567 }] });
        }
      }
    }
    for (const entity of safeEntityNames) {
      for (const structure of safeNameStructures) {
        for (const render of renderers) {
          const key = render(structure(entity));
          safeCases.set(key, { profile: { [key]: "Research Journal" } });
        }
      }
      for (const modifier of modifiers) {
        for (const render of renderers) {
          const key = render([modifier, entity, "name"]);
          safeCases.set(key, { profile: { [key]: "Research Journal" } });
        }
      }
    }
    const falsePositiveKeys = [...safeCases].flatMap(([key, properties]) => {
      try {
        evaluatePixelEvent(request({
          event: { name: "page_view", properties: properties as EvaluationRequest["event"]["properties"] },
        }));
        return [];
      } catch {
        return [key];
      }
    });
    expect(safeCases.size).toBeGreaterThanOrEqual(453);
    expect(falsePositiveKeys).toEqual([]);
  });

  test("preserves a reviewer-scale hostile and safe semantic boundary corpus", () => {
    const renderers = [
      (tokens: string[]) => tokens.join(""),
      (tokens: string[]) => tokens.join("").toUpperCase(),
      (tokens: string[]) => tokens[0] + tokens.slice(1).map((token) =>
        token[0]!.toUpperCase() + token.slice(1)).join(""),
      (tokens: string[]) => tokens.join("_"),
      (tokens: string[]) => tokens.join("-"),
      (tokens: string[]) => tokens.join("."),
    ];
    const phoneRoots = ["cell", "cellular", "cellphone", "mobile", "phone", "tel", "telephone"];
    const hostilePhrases = [
      ...phoneRoots.flatMap((root) => [
        [root, "number"], ["number", root],
        [root, "contact"], ["contact", root],
        [`${root}s`, "numbers"], ["numbers", `${root}s`],
      ]),
      ["contact", "number"], ["number", "contact"],
      ["customer", "name"], ["name", "customer"],
      ["holder", "name"], ["name", "holder"],
      ["recipient", "full", "name"], ["name", "of", "recipient"],
      ["member", "mobile"], ["mobile", "member"],
      ["user", "telephone"], ["telephone", "user"],
      ["visitor", "phone"], ["phone", "visitor"],
      ["person", "cell"], ["cell", "person"],
      ["display", "name"], ["name", "display"],
      ["profile", "mobile"], ["author", "telephone"],
      ["personal", "name"], ["name", "personal"],
      ["personal", "surname"], ["surname", "personal"],
      ["personal", "names"], ["names", "personal"],
    ];
    const prefixes = Array.from({ length: 42 }, (_, index) => `qx${index.toString(36)}z`);
    const suffixes = Array.from({ length: 32 }, (_, index) => `vy${index.toString(36)}k`);
    const hostileKeys = new Set<string>();
    for (const phrase of hostilePhrases) {
      for (const prefix of prefixes) {
        for (const suffix of suffixes) {
          for (const render of renderers) hostileKeys.add(render([prefix, ...phrase, suffix]));
        }
      }
    }
    const missedHostileKeys: string[] = [];
    let hostileIndex = 0;
    for (const key of hostileKeys) {
      const leaf = { [key]: 15551234567 };
      const shape = hostileIndex % 3 === 0
        ? leaf
        : hostileIndex % 3 === 1
          ? { metadata: leaf }
          : { records: [leaf] };
      hostileIndex += 1;
      try {
        evaluatePixelEvent(request({
          event: { name: "lead", properties: shape as EvaluationRequest["event"]["properties"] },
        }));
        if (missedHostileKeys.length < 20) missedHostileKeys.push(key);
      } catch {
        // Expected: the public schema rejects before any dispatch decision.
      }
    }
    expect(hostileKeys.size).toBeGreaterThan(518_400);
    expect(Math.max(...[...hostileKeys].map((key) => key.length))).toBeLessThanOrEqual(64);
    expect(missedHostileKeys).toEqual([]);

    const modifiers = Array.from({ length: 96 }, (_, index) => `safex${index.toString(36)}q`);
    const safeEntities = [
      "app", "application", "code", "event", "product", "company", "organization",
      "org", "campaign", "category", "file", "host", "domain", "project", "team",
    ];
    const safeNameStructures = [
      (entity: string) => [entity, "name"],
      (entity: string) => [entity, "name", "label"],
      (entity: string) => [entity, "name", "field"],
      (entity: string) => [entity, "name", "description"],
      (entity: string) => ["name", "of", entity],
      (entity: string) => [entity, "metadata", "name"],
      (entity: string) => [entity, "name", "value"],
      (entity: string) => [entity, "name", "key"],
      (entity: string) => [entity, "name", "attribute"],
      (entity: string) => [entity, "name", "detail"],
      (entity: string) => [entity, "name", "record"],
    ];
    const safeNumericLeaves = [
      "id", "identifier", "count", "counter", "index", "rank", "total", "amount", "price", "quantity",
    ];
    const safeCases = new Map<string, PropertyValue>();
    for (const entity of safeEntities) {
      for (const structure of safeNameStructures) {
        for (const render of renderers) safeCases.set(render(structure(entity)), "Research Journal");
      }
      for (const modifier of modifiers) {
        for (const render of renderers) safeCases.set(render([modifier, entity, "name"]), "Research Journal");
      }
    }
    for (const modifier of modifiers) {
      for (const leaf of safeNumericLeaves) {
        for (const render of renderers) safeCases.set(render([modifier, "contact", leaf]), 15551234567);
      }
    }
    for (const key of [
      "saxophone", "headphones", "microphone", "telephonebook", "mobilegame",
      "cellularnetwork", "cellophane", "zipper", "zipline", "streetwear",
      "addressablemarket", "contactlesspayment", "phonetics", "codename",
      "projectname", "teamname", "appname",
    ]) safeCases.set(key, "ordinary non-person value");
    for (const collision of [
      "saxophone", "headphones", "microphone", "zipper", "zipline", "streetwear",
      "addressablemarket", "contactlesspayment", "phonetics", "cellophane",
    ]) {
      for (const modifier of modifiers) {
        for (const render of renderers) {
          safeCases.set(render([modifier, collision]), "ordinary non-person value");
        }
      }
    }

    const telecomModifiers = Array.from({ length: 28 }, (_, index) => `entity${index.toString(36)}x`);
    const telecomRoots = ["cell", "cellular", "cellphone", "mobile", "phone", "tel", "telephone"];
    const entityDescriptors = [
      "org", "organization", "app", "application", "code", "company", "event", "project", "team", "network",
      "provider", "carrier", "standard", "protocol", "band", "technology", "plan", "product",
      "service", "campaign", "category", "file", "domain", "host",
    ];
    for (const modifier of telecomModifiers) {
      for (const root of telecomRoots) {
        for (const descriptor of entityDescriptors) {
          for (const tokens of [
            [modifier, root, descriptor],
            [root, modifier, descriptor],
            [root, descriptor, modifier],
            [modifier, root, descriptor, "name"],
          ]) {
            for (const render of renderers) {
              safeCases.set(render(tokens), "ordinary non-person entity metadata");
            }
          }
        }
      }
    }

    const falsePositiveKeys: string[] = [];
    for (const [key, value] of safeCases) {
      try {
        evaluatePixelEvent(request({
          event: { name: "page_view", properties: { [key]: value } },
        }));
      } catch {
        if (falsePositiveKeys.length < 20) falsePositiveKeys.push(key);
      }
    }
    expect(safeCases.size).toBeGreaterThan(100_000);
    expect(Math.max(...[...safeCases.keys()].map((key) => key.length))).toBeLessThanOrEqual(64);
    expect(falsePositiveKeys).toEqual([]);
  }, 90_000);

  test("keeps semantic decisions stable after bounded cache churn", () => {
    const classify = (key: string, value: PropertyValue): "accepted" | "rejected" => {
      try {
        evaluatePixelEvent(request({ event: { name: "probe", properties: { [key]: value } } }));
        return "accepted";
      } catch {
        return "rejected";
      }
    };
    const probes: Array<[string, PropertyValue]> = [
      ["cellnumber", 15551234567],
      ["contactqzxphone", 15551234567],
      ["customerneutralxname", "Ada Lovelace"],
      ["orgName", "Hasna"],
      ["primaryOrgName", "Hasna"],
      ["saxophone", "alto"],
      ["mobilegame", "puzzle"],
    ];
    const before = probes.map(([key, value]) => classify(key, value));
    for (let index = 0; index < 900; index += 1) {
      classify(`qz${index.toString(36)}informationmetadatarecorddetail`, index);
    }
    const after = probes.map(([key, value]) => classify(key, value));
    expect(before).toEqual([
      "rejected", "rejected", "rejected", "accepted", "accepted", "accepted", "accepted",
    ]);
    expect(after).toEqual(before);
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

  test("does not mistake lexical suffix collisions for explicit safe numeric leaves", () => {
    const collisions = ["paid", "valid", "rapid", "account", "encounter"];
    for (const key of collisions) {
      expect(() => evaluatePixelEvent(request({
        event: {
          name: "lead",
          properties: { customercontacts: [{ [key]: 15551234567 }] },
        },
      })), key).toThrow();
    }
  });

  test("keeps maximum-width semantic scanning within a bounded runtime", () => {
    const properties = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
      `informationmetadatarecorddetailgroupvalue${index}`,
      index,
    ]));
    const input = request({
      event: { name: "page_view", properties },
      providers: [],
    });
    evaluatePixelEvent(input);
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 50; iteration += 1) evaluatePixelEvent(input);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
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
