# Open Pixels

Open Pixels is a small, reusable TypeScript toolkit for running analytics and advertising pixels behind explicit policy and consent gates. It ships as `@hasna/pixels` with a browser SDK, a server-side evaluation API, the `pixels` CLI, and the `pixels-mcp` MCP server.

It is deliberately fail-closed:

- the platform is disabled by default;
- the provider allowlist is empty by default;
- analytics and advertising consent are evaluated separately;
- Global Privacy Control and Do Not Track override consent by default;
- Google Ads and LinkedIn conversions require explicit event mappings;
- direct-PII-looking event property names and embedded email, phone, and IP values are rejected recursively, including phone-like numbers under common contact fields;
- only built-in providers with fixed script origins can dispatch;
- the HTTP event route cannot dispatch unless both an authorizer and dispatcher are configured.

The initial built-ins are Google Analytics, Google Ads, Meta Pixel, TikTok Pixel, and LinkedIn Insight Tag. Open Pixels does not buy traffic, manage ad campaigns, or bypass a consent manager.

## Install

```bash
bun add @hasna/pixels
```

## Evaluate before dispatch

```ts
import { PixelOrchestrator } from "@hasna/pixels";

const pixels = new PixelOrchestrator({
  policy: {
    enabled: true,
    allowedProviders: ["google-analytics"],
    allowedEvents: ["page_view", "newsletter_signup"],
  },
  providers: [
    { provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" },
  ],
});

const evaluation = pixels.evaluate({
  event: { name: "page_view", properties: { section: "nutrition" } },
  consent: { analytics: true, advertising: false, source: "banner" },
  signals: { globalPrivacyControl: false, doNotTrack: false },
});
```

`evaluate` is pure and never loads a script or emits a request.

## Browser dispatch

```ts
import { createBrowserPixelClient } from "@hasna/pixels/browser";

const client = createBrowserPixelClient({
  policy: {
    enabled: true,
    allowedProviders: ["google-analytics", "meta"],
    allowedEvents: ["page_view", "newsletter_signup"],
  },
  providers: [
    { provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" },
    { provider: "meta", enabled: true, pixelId: "123456789" },
  ],
});

await client.track(
  { name: "page_view", properties: { section: "nutrition" } },
  { analytics: true, advertising: false, source: "banner" },
);
```

Scripts are loaded only after the event passes policy, consent, privacy-signal, and schema checks. Revoking consent prevents future dispatch; it cannot undo data already sent or unload a third-party script, so applications should also reset/reload their page when their consent design requires that behavior.

Provider events remain account-scoped when several applications share the same page globals: Google Analytics events include the destination measurement ID in `send_to`, Meta events use `trackSingle`/`trackSingleCustom` with the configured pixel ID, and TikTok events use the official `ttq.instance(pixelId)` runtime rather than the global fan-out methods. Each site must still receive its own server-owned provider configuration; do not copy account IDs between tenants.

The browser SDK loads only the fixed origins returned by `listProviders()`. Production Content Security Policy must explicitly allow the selected providers' script, connection, and image endpoints. Deployments that require script nonces should integrate and approve provider loading in their own CSP-aware boundary. Treat provider load failures as observable delivery failures and retry only after confirming consent remains granted.

## Provider mappings

Google Ads and LinkedIn accept only mapped conversion events:

```ts
const providers = [
  {
    provider: "google-ads" as const,
    enabled: true,
    conversionId: "AW-123456",
    conversionLabels: { newsletter_signup: "SignupLabel" },
  },
  {
    provider: "linkedin" as const,
    enabled: true,
    partnerId: "12345",
    conversionIds: { newsletter_signup: "67890" },
  },
];
```

## HTTP API

`createPixelsHttpHandler()` exposes:

- `GET /health`
- `GET /v1/providers`
- `POST /v1/evaluate` — pure evaluation
- `POST /v1/events` — dispatch, available only with an authorizer and dispatcher

The standalone `pixels serve` command exposes the read/evaluate API only and keeps dispatch disabled. Bind defaults to `127.0.0.1`.

An application that enables `/v1/events` owns the full authenticated-caller trust boundary: callers can select provider account identifiers, allowlists, and policy within the validated request. Constrain or replace those values with server-owned configuration before dispatch when callers must not control them.

## CLI

```bash
pixels providers --json
pixels validate ./pixels.config.json
pixels evaluate ./evaluation.json
pixels serve --port 8891
```

## MCP

The MCP server is read-only and supports provider discovery, configuration validation, and event evaluation. It cannot dispatch pixels.

```bash
pixels-mcp                 # stdio
pixels-mcp --http          # Streamable HTTP at http://127.0.0.1:8892/mcp
```

The HTTP transport also exposes `GET /health`.

Streamable HTTP binds to loopback by default, rejects unapproved browser `Origin` headers, and permits local origins plus exact origins configured with repeatable `--allow-origin` flags. Library consumers may supply an `authorize` callback; non-loopback binding fails closed unless that callback is present. The CLI intentionally provides no non-loopback authentication backend, so `--host 0.0.0.0` is rejected.

The exported raw `handlePixelsMcpHttpRequest()` does not infer whether an embedding server is remote. Remote embeddings must provide `authorize`, enforce request-body and rate limits at the server or reverse-proxy boundary, and retain the exact-origin policy. `startPixelsMcpHttpServer()` enforces the non-loopback authorization requirement for its own listener.

```ts
import { startPixelsMcpHttpServer } from "@hasna/pixels/mcp/http";

startPixelsMcpHttpServer({
  hostname: "10.0.0.10",
  allowedOrigins: ["https://console.example"],
  authorize: (request) => verifyRequest(request),
});
```

## Privacy boundary

Open Pixels is a technical enforcement layer, not legal advice or a complete consent-management platform. Its PII checks are bounded heuristics for common direct identifiers, not exhaustive classification or compliance proof. Applications remain responsible for their notices, retention, data processing agreements, geographic requirements, and correct classification of each provider. Never put secrets or direct personal information in browser-visible provider configuration or event properties.

The recursive guard rejects common direct-name keys, phone/contact ancestry (including nested values and numeric arrays), embedded email/IP/phone values, and formatted phone values. Human-name and phone/contact classification uses bounded semantic tokenization across camel, snake, kebab, compact, case, plural, and reordered forms, including compound containers in nested objects and arrays. Ambiguous name fields fail closed when their key or ancestry denotes a display, customer, contact, user, profile, member, person, recipient, author, or visitor; explicit non-person patterns for event, product, company, organization, campaign, category, and file names remain allowed. It deliberately permits ordinary amounts, counters, identifier leaves such as numeric-string order IDs, and non-PII contact text; callers must not use those fields to disguise personal information.

## Development

```bash
bun install
bun run check
```

Dependencies use Bun's seven-day release-age quarantine. The exact new Hasna package name is retained in the exclusion registry for supervised package bootstrap.

## License

Apache-2.0
