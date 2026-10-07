import { describe, expect, it } from "vitest";
import {
  checkCmyk,
  checkCompanyName,
  checkContactEmail,
  checkHex,
  checkPhone,
  checkText,
  checkWebsite,
  checkWhatsApp,
  hexToRgb,
  isUuid,
} from "@/lib/company/validation";

const ok = (value: unknown) => ({ ok: true, value });

describe("company name", () => {
  it("is trimmed and inner spaces tidied", () => {
    expect(checkCompanyName("  Acme   Properties  ")).toEqual(ok("Acme Properties"));
  });

  it("is required", () => {
    for (const empty of ["", "   ", "\n\t"]) {
      expect(checkCompanyName(empty)).toMatchObject({ ok: false, error: /company name/ });
    }
  });

  it("rejects too-long, symbol-only and control-character names", () => {
    expect(checkCompanyName("x".repeat(121)).ok).toBe(false);
    expect(checkCompanyName("x".repeat(120)).ok).toBe(true);
    expect(checkCompanyName("---").ok).toBe(false);
    expect(checkCompanyName("Acme\u0000").ok).toBe(false);
  });

  it("accepts names in any script", () => {
    expect(checkCompanyName("شركة أكمي").ok).toBe(true);
    expect(checkCompanyName("7-Eleven").ok).toBe(true);
  });
});

describe("free text", () => {
  it("turns empty into null (cleared) when not required", () => {
    expect(checkText("   ", { max: 10 })).toEqual(ok(null));
  });

  it("keeps line breaks in multi-line text, without piles of blank lines", () => {
    expect(checkText(" Line 1  \r\n\n\n\nLine 2 ", { max: 100, multiline: true })).toEqual(
      ok("Line 1\n\nLine 2")
    );
  });

  it("counts characters, not bytes", () => {
    expect(checkText("é".repeat(10), { max: 10 }).ok).toBe(true);
  });
});

describe("phone", () => {
  it("accepts normal layouts and keeps them exactly as typed", () => {
    for (const phone of ["+971 4 123 4567", "(04) 123-4567", "04.123.4567", "+1 (212) 555-0100"]) {
      expect(checkPhone(` ${phone} `)).toEqual(ok(phone));
    }
  });

  it("rejects letters, misplaced + and wrong digit counts", () => {
    for (const bad of ["call us", "12345", "+971 4 123 4567 890 12", "04+1234567", "123-abc-4567"]) {
      expect(checkPhone(bad).ok, bad).toBe(false);
    }
  });

  it("allows clearing", () => {
    expect(checkPhone("")).toEqual(ok(null));
  });
});

describe("WhatsApp", () => {
  it("needs the international form", () => {
    expect(checkWhatsApp("+971 50 123 4567")).toEqual(ok("+971 50 123 4567"));
    expect(checkWhatsApp("050 123 4567").ok).toBe(false);
    expect(checkWhatsApp("+0 50 123 4567").ok).toBe(false);
    expect(checkWhatsApp("+97150").ok).toBe(false);
    expect(checkWhatsApp("+971 50 123 4567 8901").ok).toBe(false);
  });
});

describe("contact email", () => {
  it("accepts valid addresses as typed", () => {
    expect(checkContactEmail(" Hello@Acme.com ")).toEqual(ok("Hello@Acme.com"));
  });

  it("rejects invalid ones", () => {
    for (const bad of ["hello", "hello@", "hello@acme", "he llo@acme.com", "@acme.com"]) {
      expect(checkContactEmail(bad).ok, bad).toBe(false);
    }
  });
});

describe("website", () => {
  it("adds https:// when missing and keeps paths", () => {
    expect(checkWebsite("acme.com")).toEqual(ok("https://acme.com"));
    expect(checkWebsite("www.Acme.com/")).toEqual(ok("https://www.acme.com"));
    expect(checkWebsite("http://acme.com/en/about?x=1")).toEqual(
      ok("http://acme.com/en/about?x=1")
    );
    expect(checkWebsite("HTTPS://shop.acme.co.uk")).toEqual(ok("https://shop.acme.co.uk"));
  });

  it("rejects anything that isn't a normal http(s) website address", () => {
    for (const bad of [
      "acme",
      "localhost",
      "javascript:alert(1)",
      "ftp://acme.com",
      "mailto:hello@acme.com",
      "https://user:pass@acme.com",
      "acme .com",
      "http://",
      "https://-acme.com",
      "https://1.2.3.4",
    ]) {
      expect(checkWebsite(bad).ok, bad).toBe(false);
    }
  });

  it("allows clearing", () => {
    expect(checkWebsite("  ")).toEqual(ok(null));
  });
});

describe("brand colours", () => {
  it("writes HEX in one standard form", () => {
    expect(checkHex("#1a64b4")).toEqual(ok("#1A64B4"));
    expect(checkHex("1A64B4")).toEqual(ok("#1A64B4"));
    expect(checkHex("#16b")).toEqual(ok("#1166BB"));
  });

  it("rejects bad HEX", () => {
    for (const bad of ["", "#12345", "#GGGGGG", "blue", "#1234567"]) {
      expect(checkHex(bad).ok, bad).toBe(false);
    }
  });

  it("accepts optional CMYK as four numbers 0–100", () => {
    expect(checkCmyk("")).toEqual(ok(null));
    expect(checkCmyk("85% 45% 0% 29%")).toEqual(ok("85, 45, 0, 29"));
    expect(checkCmyk("85,45,0,29")).toEqual(ok("85, 45, 0, 29"));
    expect(checkCmyk("85, 45, 0").ok).toBe(false);
    expect(checkCmyk("101, 0, 0, 0").ok).toBe(false);
    expect(checkCmyk("-1, 0, 0, 0").ok).toBe(false);
  });

  it("works out RGB from HEX for display", () => {
    expect(hexToRgb("#1A64B4")).toBe("26, 100, 180");
  });
});

describe("isUuid", () => {
  it("accepts only UUIDs", () => {
    expect(isUuid("0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01")).toBe(true);
    expect(isUuid("1")).toBe(false);
    expect(isUuid("../admin")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
