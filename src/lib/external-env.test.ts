import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalEnvFile, loadExternalEnv } from "@/lib/external-env";

describe("secrets file outside the project", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-env-"));
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lives in <home>/.skybook-qc/.env.local", () => {
    expect(externalEnvFile("C:\\Users\\someone")).toBe(
      path.join("C:\\Users\\someone", ".skybook-qc", ".env.local")
    );
  });

  it("loads values that aren't set yet, and never overwrites ones that are", () => {
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "QC_TEST_NEW=from-outside\nQC_TEST_SET=from-outside\n");
    vi.stubEnv("QC_TEST_NEW", undefined);
    vi.stubEnv("QC_TEST_SET", "from-project");

    expect(loadExternalEnv(file)).toBe(true);
    expect(process.env.QC_TEST_NEW).toBe("from-outside");
    expect(process.env.QC_TEST_SET).toBe("from-project");
  });

  it("does nothing when the file doesn't exist", () => {
    expect(loadExternalEnv(path.join(dir, "missing", ".env.local"))).toBe(false);
  });
});
