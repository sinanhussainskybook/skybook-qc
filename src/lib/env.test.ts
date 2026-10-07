import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPLOAD_LIMIT_MB,
  getUploadLimitBytes,
  parseMegabytes,
} from "@/lib/env";

const MB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseMegabytes", () => {
  it.each([
    ["1", 1],
    ["25", 25],
    [" 50 ", 50],
    ["500", 500],
  ])("accepts %j", (raw, expected) => {
    expect(parseMegabytes(raw)).toBe(expected);
  });

  it.each([undefined, "", "   ", "abc", "0", "-5", "2.5", "1e3", "501"])(
    "rejects %j",
    (raw) => {
      expect(parseMegabytes(raw)).toBeNull();
    }
  );
});

describe("getUploadLimitBytes", () => {
  it("uses the default when MAX_UPLOAD_MB is not set", () => {
    vi.stubEnv("MAX_UPLOAD_MB", undefined);
    expect(getUploadLimitBytes()).toBe(DEFAULT_UPLOAD_LIMIT_MB * MB);
  });

  it("uses MAX_UPLOAD_MB when it is valid", () => {
    vi.stubEnv("MAX_UPLOAD_MB", "100");
    expect(getUploadLimitBytes()).toBe(100 * MB);
  });

  it("falls back to the default when MAX_UPLOAD_MB is invalid", () => {
    vi.stubEnv("MAX_UPLOAD_MB", "lots");
    expect(getUploadLimitBytes()).toBe(DEFAULT_UPLOAD_LIMIT_MB * MB);
  });
});
