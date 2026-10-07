import { describe, expect, it } from "vitest";
import { DEFAULT_COST, getDummyHash, hashPassword, verifyPassword } from "@/lib/auth/password";
import { TEST_COST } from "../../../test/db";

describe("password hashing", () => {
  it("never contains the password, and verifies it", async () => {
    const hash = await hashPassword("correct horse battery", TEST_COST);
    expect(hash).not.toContain("correct horse battery");
    expect(hash.startsWith("scrypt$10$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery", TEST_COST);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("uses a new salt every time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same password here", TEST_COST),
      hashPassword("same password here", TEST_COST),
    ]);
    expect(a).not.toBe(b);
  });

  it("treats differently-encoded but identical characters as the same password", async () => {
    const hash = await hashPassword("café password!", TEST_COST); // é as one character
    expect(await verifyPassword("café password!", hash)).toBe(true); // e + accent
  });

  it("never matches a malformed or out-of-bounds hash", async () => {
    const good = await hashPassword("a long password", TEST_COST);
    const parts = good.split("$");
    const variants = [
      "",
      "plain-text-password",
      parts.slice(0, 5).join("$"),
      ["bcrypt", ...parts.slice(1)].join("$"),
      ["scrypt", "30", ...parts.slice(2)].join("$"), // would need 1 TB of memory
      [...parts.slice(0, 4), "c2hvcnQ=", parts[5]].join("$"), // salt too short
    ];
    for (const stored of variants) {
      expect(await verifyPassword("a long password", stored), stored).toBe(false);
    }
  });

  it("uses the strong default cost in the app", async () => {
    expect(DEFAULT_COST).toEqual({ logN: 16, r: 8, p: 2 });
    const dummy = await getDummyHash();
    expect(dummy.startsWith("scrypt$16$8$2$")).toBe(true);
  });
});
