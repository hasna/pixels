# Open Pixels

Open Pixels is a small, reusable TypeScript toolkit for running analytics and advertising pixels behind explicit policy and consent gates. It ships as `@hasna/pixels` with a browser SDK, a server-side evaluation API, the `pixels` CLI, and the `pixels-mcp` MCP server.

It is deliberately fail-closed:

- the platform is disabled by default;
- the provider allowlist is empty by default;
- analytics and advertising consent are evaluated separately;
- Global Privacy Control and Do Not Track override consent by default;
- Google Ads and LinkedIn conversions require explicit event mappings;
- direct-PII-looking event property names are rejected;
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

## Privacy boundary

Open Pixels is a technical enforcement layer, not legal advice or a complete consent-management platform. Applications remain responsible for their notices, retention, data processing agreements, geographic requirements, and correct classification of each provider. Never put secrets or direct personal information in browser-visible provider configuration or event properties.

## Development

```bash
bun install
bun run check
```

Dependencies use Bun's seven-day release-age quarantine. The exact new Hasna package name is retained in the exclusion registry for supervised package bootstrap.

## License

Apache-2.0
