import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildPixelsMcpServer } from "./server.js";
import packageJson from "../../package.json";

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = buildPixelsMcpServer();
  const client = new Client({ name: "pixels-contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("pixels MCP contract", () => {
  test("exposes read-only provider, validation, and evaluation tools", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "pixels_evaluate_event",
        "pixels_providers",
        "pixels_validate_configuration",
      ]);
      expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBeTrue();
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBeTrue();
      expect(client.getServerVersion()?.version).toBe(packageJson.version);

      const resources = await client.listResources();
      expect(resources.resources.map((item) => item.uri)).toContain("pixels://providers");

      const evaluated = await client.callTool({
        name: "pixels_evaluate_event",
        arguments: {
          event: { name: "page_view" },
          consent: { analytics: true, advertising: false },
          policy: { enabled: true, allowedProviders: ["google-analytics"] },
          providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
        },
      });
      expect((evaluated.structuredContent as { result?: { accepted?: boolean } }).result?.accepted).toBeTrue();

      const hostile = await client.callTool({
        name: "pixels_evaluate_event",
        arguments: {
          event: { name: "lead", properties: { emergencycontactnumber: 15551234567 } },
          consent: { analytics: true, advertising: false },
          policy: { enabled: true, allowedProviders: ["google-analytics"] },
          providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
        },
      });
      expect(hostile.isError).toBeTrue();
      expect(JSON.stringify(hostile.content)).toContain("direct phone number");
      expect(hostile.structuredContent).toBeUndefined();

      const cellNumberHostile = await client.callTool({
        name: "pixels_evaluate_event",
        arguments: {
          event: { name: "lead", properties: { cell_number: 15551234567 } },
          consent: { analytics: true, advertising: false },
          policy: { enabled: true, allowedProviders: ["google-analytics"] },
          providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
        },
      });
      expect(cellNumberHostile.isError).toBeTrue();
      expect(JSON.stringify(cellNumberHostile.content)).toContain("direct phone number");
      expect(cellNumberHostile.structuredContent).toBeUndefined();

      for (const properties of [
        { cellularNumber: 15551234567 },
        { personalName: "Ada Lovelace" },
      ]) {
        const semanticHostile = await client.callTool({
          name: "pixels_evaluate_event",
          arguments: {
            event: { name: "lead", properties },
            consent: { analytics: true, advertising: false },
            policy: { enabled: true, allowedProviders: ["google-analytics"] },
            providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
          },
        });
        expect(semanticHostile.isError).toBeTrue();
        expect(semanticHostile.structuredContent).toBeUndefined();
      }

      const safeTelecomEntity = await client.callTool({
        name: "pixels_evaluate_event",
        arguments: {
          event: { name: "page_view", properties: { safe0xCellularApp: "Dialer product" } },
          consent: { analytics: true, advertising: false },
          policy: { enabled: true, allowedProviders: ["google-analytics"] },
          providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
        },
      });
      expect(safeTelecomEntity.isError).not.toBeTrue();
      expect((safeTelecomEntity.structuredContent as { result?: { accepted?: boolean } }).result?.accepted).toBeTrue();
    });
  });
});
