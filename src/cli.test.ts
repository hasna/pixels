import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pixels CLI", () => {
  test("rejects compact PII before returning an evaluation", async () => {
    for (const properties of [
      { billingcontactphone: 15551234567 },
      { cellNumber: 15551234567 },
      { cellularNumber: 15551234567 },
      { personalName: "Ada Lovelace" },
      { phóne: 15551234567 },
      { ["phóne".normalize("NFD")]: 15551234567 },
      { phοne: 15551234567 },
      { clíent_ip: "synthetic" },
      { profile: { pHONE: 15551234567 } },
      { profile: { pҺØՆE: 15551234567 } },
      { emAil: "synthetic@example.invalid" },
      { aDdress: "synthetic" },
      { sTreet: "synthetic" },
      { postaL_code: "synthetic" },
      { zIp: "synthetic" },
      { cLient_ip: "synthetic" },
      { pһone: 15551234567 },
      { cӏient_ip: "synthetic" },
      { poѕtal_code: "synthetic" },
      { phoնe: 15551234567 },
      { phøne: 15551234567 },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "pixels-cli-test-"));
      temporaryDirectories.push(directory);
      const requestPath = join(directory, "request.json");
      writeFileSync(requestPath, JSON.stringify({
        event: { name: "lead", properties },
        consent: { analytics: true, advertising: false },
        policy: { enabled: true, allowedProviders: ["google-analytics"] },
        providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
      }));

      const subprocess = Bun.spawn([process.execPath, "run", "src/cli.ts", "evaluate", requestPath], {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("direct personal information");
    }
  });

  test("accepts safe non-person telecom entity metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pixels-cli-safe-test-"));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, "request.json");
    writeFileSync(requestPath, JSON.stringify({
      event: {
        name: "page_view",
        properties: {
          safe0x_cellular_app: "Dialer product",
          "région_du_réseau": "Europe",
          "categoria_móvil": "actualités",
          "équipe_cellulaire": "plateforme",
          "cellular_οrganization": "Opérateur réseau",
          "cellular_οRGANIZATION": "Opérateur réseau",
          "сellular_app": "lector",
        },
      },
      consent: { analytics: true, advertising: false },
      policy: { enabled: true, allowedProviders: ["google-analytics"] },
      providers: [{ provider: "google-analytics", enabled: true, measurementId: "G-ABC12345" }],
    }));

    const subprocess = Bun.spawn([process.execPath, "run", "src/cli.ts", "evaluate", requestPath], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).result.accepted).toBeTrue();
    expect(stderr).toBe("");
  });
});
