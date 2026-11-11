import { describe, expect, it, vi } from "vitest";
import { applyConfidencePolicy } from "@/lib/analysis/policy";
import { validateDesignAnalysis } from "@/lib/analysis/validate";
import { joinHyphenatedLines } from "@/lib/qc/compare";
import { textReadings } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import { byRule, company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * A4 live follow-up (release test 2026-11-11): the poster shows "Book-" / "ing your trip is easy." on two lines;
 * the live reading had them on ONE line ("Book- ing …" — an AI reading can give both lines as one text, and
 * validation makes its spaces single), so the required wording "booking" was reported as "book ing".
 * joinHyphenatedLines({ sameLine: true }) joins "Book- ing" as an EXTRA reading, used only to find wording.
 */

// "legacy" switches the new reading off (the readings are then exactly the previous ones) — for comparing outcomes.
const mode = vi.hoisted(() => ({ legacy: false }));
vi.mock("@/lib/qc/compare", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/qc/compare")>();
  return { ...m, joinHyphenatedLines: (t: string, o?: { sameLine?: boolean }) => m.joinHyphenatedLines(t, mode.legacy ? undefined : o) };
});

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l, { confidence: 0.9 })), textCoverage: 1 });
const brief = (type: string, value: string, d: ReturnType<typeof read>, mandatory = false) =>
  byRule(run({ requirements: [requirement(type, value, { mandatory })], detections: d }), "brief.requirement")[0];

describe("joinHyphenatedLines sameLine: the narrow join", () => {
  it("joins 'Book- ing' (a letter, a hyphen, spaces, a lower-case letter)", () => {
    expect(joinHyphenatedLines("Book- ing your trip is easy.", { sameLine: true })).toBe("Booking your trip is easy.");
    expect(joinHyphenatedLines("Terms and condi-  tions apply", { sameLine: true })).toBe("Terms and conditions apply");
  });

  it("without the option nothing changes (every existing reading is the same)", () => {
    expect(joinHyphenatedLines("Book- ing your trip is easy.")).toBe("Book- ing your trip is easy.");
    expect(joinHyphenatedLines("Terms and condi-\ntions apply")).toBe("Terms and conditions apply");
  });

  it("suspended hyphens are never joined: and, or, to, nor, &", () => {
    for (const t of ["pre- and post-season offers", "short- or long-term stays", "5- to 7-day trips", "one- nor two-bedroom", "pre- & post-season"]) {
      expect([t, joinHyphenatedLines(t, { sameLine: true })]).toEqual([t, t]);
    }
  });

  it("a capital after the hyphen is a real pair: 'Dubai- Abu Dhabi' stays", () => {
    expect(joinHyphenatedLines("Dubai- Abu Dhabi tours", { sameLine: true })).toBe("Dubai- Abu Dhabi tours");
  });

  it("a hyphen without a space is an ordinary hyphenated word: 're-sign' never becomes 'resign'", () => {
    expect(joinHyphenatedLines("re-sign today", { sameLine: true })).toBe("re-sign today");
    expect(joinHyphenatedLines("Book-ing your trip", { sameLine: true })).toBe("Book-ing your trip");
  });
});

describe("required wording on the design", () => {
  it("live case: 'Book- ing your trip is easy.' → 'booking' present (was: 'book ing')", () => {
    const f = brief("required_text", "booking", read("Book- ing your trip is easy."));
    expect([f.status, f.detected]).toEqual(["passed", "booking"]);
  });

  it("'Book-\\ning' inside ONE Gemini text, after the existing validation (spaces made single) → present", () => {
    const answer = JSON.stringify({
      texts: [{ text: "Book-\ning your trip is easy.", box_2d: [700, 100, 780, 600], role: "body", fontFamily: null, bold: true, certainty: "clear" }],
      fonts: [],
      logo: { present: false, matchesCompanyLogo: null, box: null, certainty: "clear" },
      focalPoint: null,
      imageIssues: [],
      colorOnlyMeaning: { present: false, certainty: "clear", note: "" },
    });
    const checked = validateDesignAnalysis(answer, 1080, 1350);
    expect(checked.ok).toBe(true);
    const line = checked.ok ? checked.value.ocr.blocks[0].text : "";
    expect(line).toBe("Book- ing your trip is easy."); // validate.ts is unchanged: the line break is gone
    const f = brief("required_text", "booking", read(line));
    expect([f.status, f.detected]).toEqual(["passed", "booking"]);
  });

  it("two separate lines ('Book-' / 'ing …') still pass as before", () => {
    expect(brief("required_text", "booking", read("Book-", "ing your trip is easy.")).status).toBe("passed");
  });

  it("suspended hyphens and capitals don't make other wording present", () => {
    expect(brief("required_text", "preand", read("pre- and post-season offers")).status).not.toBe("passed");
    expect(textReadings(read("Dubai- Abu Dhabi tours")).some((r) => r.includes("DubaiAbu"))).toBe(false);
  });

  it("'re-sign' on the design doesn't pass a required 'resign'", () => {
    expect(brief("required_text", "resign", read("Please re-sign the form")).status).not.toBe("passed");
  });

  it("missing required wording stays missing", () => {
    const f = brief("required_text", "booking", read("Plan your trip today."));
    expect([f.status, f.detected]).toEqual(["failed", "Not found"]);
  });

  it("legal disclaimer and Golden Rule disclaimer use the extra reading too", () => {
    const legal = byRule(run({ requirements: [requirement("disclaimer", "Terms and conditions apply", { mandatory: false })], detections: read("Terms and condi- tions apply") }), "legal.disclaimer")[0];
    expect(legal.status).toBe("passed");
    const rule = golden({ category: "mandatory_disclaimer", approved_value: "Terms and conditions apply", mandatory: true });
    const g = byRule(run({ company: company({ goldenRules: [rule] }), detections: read("Terms and condi- tions apply") }), "golden_rules")[0];
    expect(g.status).toBe("passed");
  });
});

describe("the extra reading can never introduce a failure", () => {
  const designs: string[][] = [
    ["Book- ing your trip is easy."],
    ["Book-", "ing your trip is easy."],
    ["pre- and post-season offers", "Book now"],
    ["short- or long-term stays", "5- to 7-day trips"],
    ["Dubai- Abu Dhabi tours", "Terms and condi- tions apply"],
    ["Please re-sign the form", "Offer valid un- til 31 Dec 2026"],
    ["Book-ing your trip", "احجز الآن"],
    ["Plan your trip today.", "Terms and conditions ap- ply"],
    // A5 across languages, with the English phrase split on one line: a wrong date / price, and the right ones.
    ["Offer valid un- til 30 Dec 2026"],
    ["Offer valid un- til 31 Dec 2026"],
    ["Start- ing from AED 99"],
    ["Start- ing from AED 100"],
    // Golden Rule CTA with nothing labelled as the CTA (no roles here at all).
    ["Book- ing now"],
  ];
  const AR_OFFER = "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦"; // "Offer valid until 31 Dec 2026"
  const AR_FROM = "ابتداءً من ١٠٠ درهم"; // "Starting from AED 100"
  const requirements = [
    requirement("required_text", "booking", { mandatory: false }),
    requirement("required_text", "Booking your trip is easy", { mandatory: true }),
    requirement("required_text", "pre and post season", { mandatory: false }),
    requirement("required_text", "resign", { mandatory: false }),
    requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: true }),
    requirement("headline", "Booking your trip is easy", { mandatory: false }),
    requirement("cta", "Book now", { mandatory: true }),
    requirement("disclaimer", "Terms and conditions apply", { mandatory: true }),
    // Cross-language (A5) date and price, optional and mandatory, in the brief and as legal wording.
    requirement("required_text", AR_OFFER, { mandatory: false, label: "offer optional" }),
    requirement("required_text", AR_OFFER, { mandatory: true, label: "offer mandatory" }),
    requirement("required_text", AR_FROM, { mandatory: false, label: "from optional" }),
    requirement("required_text", AR_FROM, { mandatory: true, label: "from mandatory" }),
    requirement("disclaimer", AR_OFFER, { mandatory: false, label: "offer legal optional" }),
    requirement("disclaimer", AR_FROM, { mandatory: true, label: "from legal mandatory" }),
  ];
  const goldenRules = [
    golden({ category: "mandatory_disclaimer", approved_value: "Terms and conditions apply", mandatory: true }),
    golden({ category: "approved_cta", approved_value: "Booking now", mandatory: true }),
  ];
  const RANK: Record<string, number> = { passed: 0, not_applicable: 0, unverified: 1, failed: 2 };
  const SEVERITY: Record<string, number> = { suggestion: 0, minor: 1, major: 2, critical: 3 };
  const PROFILES = ["gemini", "google", "local"] as const;
  const outcome = (legacy: boolean, lines: string[], provider: (typeof PROFILES)[number]) => {
    mode.legacy = legacy;
    try {
      const d = read(...lines);
      return applyConfidencePolicy(run({ requirements, company: company({ goldenRules }), detections: d }), d, { state: "done" }, { provider });
    } finally {
      mode.legacy = false;
    }
  };
  const key = (f: Finding) => `${f.ruleId}|${f.expected ?? ""}|${f.title}`;
  const isA5 = (f: Finding) => f.expected === AR_OFFER || f.expected === AR_FROM;

  it("for every design, rule and requirement: never worse than before (status, then severity), under all three policy profiles", () => {
    let compared = 0;
    let improved = 0;
    let a5Compared = 0;
    for (const lines of designs) {
      for (const provider of PROFILES) {
        // Paired by rule, title, expected value and occurrence — except Golden Rules, paired by rule and title
        // (one finding per rule; its "not applicable" has no expected value). Findings can come back in another
        // order, and several unlabelled requirements share a title.
        const keyed = (fs: Finding[]) => {
          const seen = new Map<string, number>();
          return new Map(
            fs.map((f) => {
              const k = `${f.ruleId}|${f.title}|${f.ruleId.startsWith("golden_rules") ? "" : (f.expected ?? "")}`;
              const n = (seen.get(k) ?? 0) + 1;
              seen.set(k, n);
              return [`${k}#${n}`, f] as const;
            })
          );
        };
        const before = keyed(outcome(true, lines, provider));
        const after = keyed(outcome(false, lines, provider));
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [k, f] of after) {
          const old = before.get(k)!;
          compared++;
          const worse = RANK[f.status] > RANK[old.status] || (RANK[f.status] === RANK[old.status] && f.status !== "passed" && SEVERITY[f.severity] > SEVERITY[old.severity]);
          expect(worse ? [lines, key(f), provider, old.status, old.severity, f.status, f.severity] : null).toBeNull();
          if (RANK[f.status] < RANK[old.status]) improved++;
          // A5 never sees the extra readings: its outcomes are identical, finding for finding.
          if (isA5(f)) {
            a5Compared++;
            expect([key(f), provider, f.status, f.severity, f.detected, f.explanation]).toEqual([key(f), provider, old.status, old.severity, old.detected, old.explanation]);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(a5Compared).toBeGreaterThan(100);
    expect(improved).toBeGreaterThan(0); // the live case and its kind now pass
  });

  it("the review case: an optional Arabic offer vs 'un- til 30 Dec' stays failed / minor 'Not found' (never major)", () => {
    const f = brief("required_text", AR_OFFER, read("Offer valid un- til 30 Dec 2026"));
    expect([f.status, f.severity, f.detected]).toEqual(["failed", "minor", "Not found"]);
  });

  it("Golden Rule CTA with no labelled CTA: 'Book- ing now' passes 'Booking now' (was: not applicable)", () => {
    const rule = golden({ category: "approved_cta", approved_value: "Booking now", mandatory: true });
    const g = byRule(run({ company: company({ goldenRules: [rule] }), detections: read("Book- ing now") }), "golden_rules")[0];
    expect(g.status).toBe("passed");
  });

  it("Local AI profile: the live case passes", () => {
    const d = read("Book- ing your trip is easy.");
    const f = byRule(applyConfidencePolicy(run({ requirements: [requirement("required_text", "booking", { mandatory: false })], detections: d }), d, { state: "done" }, { provider: "local" }), "brief.requirement")[0];
    expect(f.status).toBe("passed");
  });
});
