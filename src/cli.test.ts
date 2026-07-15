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
    const directory = mkdtempSync(join(tmpdir(), "pixels-cli-test-"));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, "request.json");
    writeFileSync(requestPath, JSON.stringify({
      event: { name: "lead", properties: { billingcontactphone: 15551234567 } },
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
  });
});
