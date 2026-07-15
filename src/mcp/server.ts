import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { evaluatePixelEvent } from "../orchestrator.js";
import { listProviders } from "../providers.js";
import { configurationSchema, evaluationRequestSchema } from "../schema.js";

function result(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function resource(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

export function buildPixelsMcpServer(): McpServer {
  const server = new McpServer({ name: "pixels", version: "0.1.0" });

  server.registerResource(
    "pixel-providers",
    "pixels://providers",
    {
      title: "Open Pixels providers",
      description: "Built-in allowlisted providers, purposes, and fixed script origins.",
      mimeType: "application/json",
    },
    async () => resource("pixels://providers", { providers: listProviders() }),
  );

  server.registerTool(
    "pixels_providers",
    {
      description: "List built-in allowlisted provider definitions.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => result({ ok: true, providers: listProviders() }),
  );

  server.registerTool(
    "pixels_validate_configuration",
    {
      description: "Validate a consent policy and provider configuration without dispatching events.",
      inputSchema: configurationSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => result({ ok: true, configuration: configurationSchema.parse(input) }),
  );

  server.registerTool(
    "pixels_evaluate_event",
    {
      description: "Evaluate consent, privacy signals, provider allowlists, and event mappings without dispatching an event.",
      inputSchema: evaluationRequestSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => result({ ok: true, result: evaluatePixelEvent(evaluationRequestSchema.parse(input)) }),
  );

  return server;
}
