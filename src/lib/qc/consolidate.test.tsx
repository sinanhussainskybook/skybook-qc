import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, HUMAN_CHECK } from "@/lib/analysis/policy";
import { CategoryScores, Scoreboard } from "@/components/qc/scoreboard";
import type { QcRequirement, QcSession } from "@/lib/db/qc-sessions";
import type { ContentDetections } from "@/lib/qc/detections";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { consolidateFindings, GROUPED_RULES, groupOccurrences, MAX_LISTED } from "@/lib/qc/consolidate";
import type { QcInputRequirement } from "@/lib/qc/qc-input";
import type { QcContext } from "@/lib/qc/rules/context";
import { categoryScoreText, scoreFindings } from "@/lib/qc/scoring";
import { buildReportData } from "@/lib/report/report-data";
import { renderReportPdf } from "@/lib/report/report-pdf";
import { company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 2 — each underlying issue once: checks that found the same issue are merged, and one check's
 * repeats in a design are grouped. Counted once, every place still listed; distinct issues stay distinct.
 */

let n = 0;
const f = (ruleId: string, status: FindingStatus, severity: Severity = "major", over: Partial<Finding> = {}): Finding => ({
  ruleId,
  category: (ruleId.startsWith("accessibility") ? "accessibility" : ruleId.startsWith("layout") ? "design_layout" : ruleId.startsWith("brand") ? "brand" : "content") as Category,
  title: "Check",
  severity,
  status,
  kind: "fact",
  explanation: "Explained.",
  confidence: 1,
  detected: `place ${++n}`,
  ...over,
});
const failedOf = (fs: Finding[]) => fs.filter((x) => x.status === "failed");

describe("repeated occurrences of one problem in one design", () => {
  it("four low-contrast labels in one design: one issue, counted once, every place listed", () => {
    const four = ["One", "Two", "Three", "Four"].map((t, i) =>
      f("accessibility.contrast", "failed", "major", { title: "Text contrast", fileId: "f1", detected: `2.0 : 1 — "${t}"`, expected: "At least 4.5 : 1", confidence: 0.9 + i * 0.01, suggestedFix: "Darken the text." })
    );
    const [one] = groupOccurrences(four);
    expect(one).toMatchObject({ occurrences: 4, severity: "major", confidence: 0.9, expected: "At least 4.5 : 1", suggestedFix: "Darken the text." });
    expect(one.detected).toBe('Found 4 times: 2.0 : 1 — "One"; 2.0 : 1 — "Two"; 2.0 : 1 — "Three"; 2.0 : 1 — "Four"');
    expect(scoreFindings(four).issues.major).toBe(4); // before: one per label
    expect(scoreFindings([one]).issues.major).toBe(1); // after: one issue
  });

  it("the most serious severity and different expectations are kept", () => {
    const [one] = groupOccurrences([
      f("accessibility.contrast", "failed", "minor", { fileId: "f1", expected: "At least 3 : 1 (large text)" }),
      f("accessibility.contrast", "failed", "major", { fileId: "f1", expected: "At least 4.5 : 1" }),
    ]);
    expect(one).toMatchObject({ severity: "major", expected: "At least 3 : 1 (large text) / At least 4.5 : 1", occurrences: 2 });
  });

  it("long lists name the first places and say how many more", () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) => f("layout.edge_margin", "failed", "minor", { fileId: "f1", detected: `"T${i}" touches the edge` }));
    const [one] = groupOccurrences(many);
    expect(one.occurrences).toBe(MAX_LISTED + 3);
    expect(one.detected).toMatch(/^Found 8 times: "T0" touches the edge; .*"T4" touches the edge; and 3 more$/);
  });

  it("never grouped across designs, across kinds (to fix / to verify / passed), or across titles", () => {
    const out = groupOccurrences([
      f("accessibility.contrast", "failed", "major", { fileId: "a" }),
      f("accessibility.contrast", "failed", "major", { fileId: "b" }), // another design
      f("accessibility.contrast", "unverified", "major", { fileId: "a", explanation: `${HUMAN_CHECK}: unsure.` }), // to verify
      f("accessibility.contrast", "passed", "major", { fileId: "a" }),
      f("accessibility.contrast", "passed", "major", { fileId: "a" }),
    ]);
    expect(out.map((x) => [x.fileId, x.status, x.occurrences ?? 1])).toEqual([
      ["a", "failed", 1],
      ["b", "failed", 1],
      ["a", "unverified", 1],
      ["a", "passed", 2],
    ]);
  });

  it("checks that report distinct things are never grouped: requirements, banned terms, wrong numbers, Golden Rules", () => {
    const distinct = [
      f("brief.requirement.price", "failed", "critical", { requirementId: "r1", title: "Price" }),
      f("brief.requirement.price", "failed", "critical", { requirementId: "r2", title: "Price" }),
      f("brand.terms", "failed", "major", { title: "Terminology", detected: "cheap" }),
      f("brand.terms", "failed", "major", { title: "Terminology", detected: "bargain" }),
      f("content.contact_details.phone", "failed", "critical", { detected: "+971 4 000 0000" }),
      f("content.contact_details.phone", "failed", "critical", { detected: "+971 4 111 1111" }),
      f("golden_rules.rule.approved_font", "failed", "critical", { title: "Golden Rule: Headlines in Montserrat" }),
      f("golden_rules.rule.approved_font", "failed", "critical", { title: "Golden Rule: Body in Lato" }),
    ];
    expect(groupOccurrences(distinct)).toEqual(distinct);
    for (const ruleId of ["brief.requirement", "brand.terms", "content.contact_details.phone", "golden_rules.rule.approved_font"]) expect(GROUPED_RULES).not.toContain(ruleId);
  });

  it("order is kept: a group sits where its first occurrence was", () => {
    const out = groupOccurrences([f("content.placeholder", "failed"), f("layout.edge_margin", "failed", "minor", { fileId: "f1" }), f("brand.terms", "failed"), f("layout.edge_margin", "failed", "minor", { fileId: "f1" })]);
    expect(out.map((x) => x.ruleId)).toEqual(["content.placeholder", "layout.edge_margin", "brand.terms"]);
  });
});

/** Two different companies, so nothing depends on one customer's settings. */
const villas = () => company();
const dental = () =>
  company({
    company: { ...company().company, id: "c0000000-0000-4000-8000-000000000002", name: "Harbour Dental Clinic" },
    contact: { phone: "+44 20 7946 0000", additional_phone: null, whatsapp: null, email: "hello@harbourdental.co.uk", website: "https://harbourdental.co.uk" },
    brand: {
      ...company().brand,
      colors: [{ id: "d1", name: "Harbour Teal", hex: "#0F766E", cmyk: null, usage: null, created_at: new Date(), updated_at: new Date() }],
      fonts: [{ id: "d2", family: "Lato", weights: null, usage: null, size_guidance: null, created_at: new Date(), updated_at: new Date() }],
      terms: [],
    },
  });

/** What the app does: rules → confidence policy → consolidate. */
function results(over: Partial<QcContext>, provider: "google" | "gemini" = "google") {
  const d = (over.detections ?? null) as ContentDetections | null;
  return consolidateFindings(applyConfidencePolicy(run(over), d, { state: "done" }, { provider }));
}
const byRule = (fs: Finding[], prefix: string) => fs.filter((x) => x.ruleId === prefix || x.ruleId.startsWith(`${prefix}.`));

describe("the same issue found by different checks: merged, counted once", () => {
  for (const [name, config, approved, palette] of [
    ["Skybook Villas", villas, "Montserrat", "#1A64B4"],
    ["Harbour Dental Clinic", dental, "Lato", "#0F766E"],
  ] as const) {
    it(`${name}: a font neither the Golden Rule nor the brand allows is one issue (the Golden Rule's)`, () => {
      const c = { ...config(), goldenRules: [golden({ category: "approved_font", rule: `Only ${approved}`, approved_value: approved, mandatory: false })] };
      const fs = results({ company: c, detections: detections({ texts: [text("Hello")], fonts: [{ family: "Arial", confidence: 0.95 }, { family: approved, confidence: 0.95 }], textCoverage: 0.95 }) });
      const counted = failedOf(fs);
      expect(counted.map((x) => [x.ruleId, x.detected])).toEqual([["golden_rules.rule.approved_font", "Arial"]]);
      expect(counted[0].alsoCovers).toEqual([expect.objectContaining({ ruleId: "brand.fonts" })]);
    });

    it(`${name}: the approved colour, one of the brand colours, missing is one issue`, () => {
      const c = { ...config(), goldenRules: [golden({ category: "approved_color", rule: "Use the brand colour", approved_value: palette, mandatory: false })] };
      const fs = results({ company: c, detections: detections({ texts: [text("Hello")], colors: [{ hex: "#FF00FF", share: 0.6 }], textCoverage: 0.95 }) });
      expect(failedOf(fs).map((x) => x.ruleId)).toEqual(["golden_rules.rule.approved_color"]);
    });
  }

  it("a font the brand allows but the Golden Rule doesn't stays the Golden Rule's alone; a brand-only font stays the brand's", () => {
    const c = { ...villas(), brand: { ...villas().brand, fonts: [...villas().brand.fonts, { ...villas().brand.fonts[0], id: "x", family: "Lato" }] }, goldenRules: [golden({ category: "approved_font", approved_value: "Montserrat", mandatory: false })] };
    const fs = results({ company: c, detections: detections({ texts: [text("Hello")], fonts: [{ family: "Lato", confidence: 0.95 }], textCoverage: 0.95 }) });
    expect(failedOf(fs).map((x) => x.ruleId)).toEqual(["golden_rules.rule.approved_font"]); // Lato: brand-approved, so no brand finding to merge
    const brandOnly = results({ company: villas(), detections: detections({ texts: [text("Hello")], fonts: [{ family: "Arial", confidence: 0.95 }], textCoverage: 0.95 }) });
    expect(failedOf(brandOnly).map((x) => x.ruleId)).toEqual(["brand.fonts"]);
  });

  it("a colour Golden Rule outside the brand palette isn't merged with the brand colours (two different issues)", () => {
    const c = { ...villas(), goldenRules: [golden({ category: "approved_color", approved_value: "#123456", mandatory: false })] };
    const fs = results({ company: c, detections: detections({ texts: [text("Hello")], colors: [{ hex: "#FF00FF", share: 0.6 }], textCoverage: 0.95 }) });
    expect(failedOf(fs).map((x) => x.ruleId).sort()).toEqual(["brand.colors.present", "golden_rules.rule.approved_color"]);
  });

  describe("the platform's safe zone and text near the edge", () => {
    const placed = (placement: string) => ({ platform: "instagram", placement, custom: null, files: [{ id: "f1", fileName: "post.png", format: "png" as const, size: 400_000, media: { unit: "px", width: 1080, height: placement === "stories_image" ? 1920 : 1350 } as never }] });
    const at = (x: number, y: number) => ({ x, y, w: 0.3, h: 0.03 });
    const texts = [
      text("Swipe up for the summer offer", { fileId: "f1", box: at(0.3, 0.005) }), // touches the top edge
      text("Terms apply", { fileId: "f1", box: at(0.005, 0.5) }), // touches the left edge
      text("Summer", { fileId: "f1", box: at(0.3, 0.5) }), // clear of everything
    ];

    it("Stories: edge text is inside the unsafe area too — one issue each design (the safe zone's), every text listed", () => {
      const fs = results({ platform: placed("stories_image"), detections: detections({ texts, textCoverage: 0.95 }) });
      const zone = byRule(fs, "platform.safe_zone");
      expect(zone).toHaveLength(1);
      expect(zone[0].status).toBe("failed");
      expect(zone[0].detected).toContain('"Swipe up for the summer offer"');
      expect(zone[0].detected).toContain('"Terms apply"');
      expect(zone[0].alsoCovers).toEqual([expect.objectContaining({ ruleId: "layout.edge_margin" }), expect.objectContaining({ ruleId: "layout.edge_margin" })]);
      expect(failedOf(byRule(fs, "layout.edge_margin"))).toEqual([]);
      // Nothing else about where text sits is counted again.
      expect(failedOf(fs).filter((x) => /^(layout\.|platform\.safe_zone)/.test(x.ruleId)).map((x) => x.ruleId)).toEqual(["platform.safe_zone"]);
    });

    it("a placement with no safe zone (feed image): the edge issue stays — one finding, both texts listed", () => {
      const fs = results({ platform: placed("feed_image"), detections: detections({ texts, textCoverage: 0.95 }) });
      expect(byRule(fs, "platform.safe_zone")).toEqual([]);
      const edge = failedOf(byRule(fs, "layout.edge_margin"));
      expect(edge).toHaveLength(1);
      expect(edge[0]).toMatchObject({ occurrences: 2, detected: 'Found 2 times: "Swipe up for the summer offer" touches the edge; "Terms apply" touches the edge' });
    });
  });
});

describe("brief requirements for the same value: one mistake, both requirements answered", () => {
  const reqs = (...list: [string, string, boolean?][]): QcInputRequirement[] => list.map(([type, value, mandatory = false], i) => requirement(type, value, { id: `q${i}`, mandatory }));
  const designWith = (words: string) => detections({ texts: [text(words)], textCoverage: 0.95 });

  it("'20%' and '20% off' with 25% on the design → one issue (the fuller requirement), covering both", () => {
    const fs = results({ requirements: reqs(["percentage", "20%"], ["offer", "20% off"]), detections: designWith("Summer sale 25% off") });
    const counted = failedOf(byRule(fs, "brief"));
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ requirementId: "q1", expected: "20% off", alsoCovers: [expect.objectContaining({ requirementId: "q0" })] });
  });

  it("'AED 1,299' (mandatory) and 'From AED 1,299' → one issue at the more serious severity", () => {
    const fs = results({ requirements: reqs(["price", "AED 1,299", true], ["required_text", "From AED 1,299"]), detections: designWith("Now AED 1,499") });
    const counted = failedOf(byRule(fs, "brief"));
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ severity: "critical", expected: "From AED 1,299" });
  });

  it("not merged when one is met (only one mistake), or when the values are unrelated", () => {
    const met = results({ requirements: reqs(["price", "AED 1,299"], ["required_text", "Book now for AED 1,299"]), detections: designWith("Only AED 1,299") });
    expect(failedOf(byRule(met, "brief")).map((x) => x.expected)).toEqual(["Book now for AED 1,299"]);
    expect(byRule(met, "brief.requirement.price")[0].status).toBe("passed");
    const unrelated = results({ requirements: reqs(["price", "AED 1,299"], ["cta", "Book now"]), detections: designWith("Now AED 1,499, call us") });
    expect(failedOf(byRule(unrelated, "brief.requirement")).map((x) => x.requirementId).sort()).toEqual(["q0", "q1"]);
  });
});

describe("website and PDF: the same consolidated issues and counts", () => {
  const session = { id: "s1", company_id: "c1", user_id: "u1", content_type: "social_post", platform: null, placement: null, status: "ready" } as unknown as QcSession;
  const req = (id: string, type: string, value: string): QcRequirement =>
    ({ id, session_id: "s1", type, label: null, expected_value: value, notes: null, mandatory: false, confirmed: true, source: "manual" }) as unknown as QcRequirement;

  it("repeated low contrast + overlapping brief values: counted once on both, with every place and both requirements answered", async () => {
    const low = (t: string, y: number) => text(t, { fileId: "f1", color: "#999999", background: "#AAAAAA", box: { x: 0.3, y, w: 0.2, h: 0.05 }, fontSizePx: 60 });
    const d = detections({ frame: { width: 1080, height: 1080 }, texts: [low("Summer", 0.2), low("sale", 0.4), low("25% off", 0.6)], textCoverage: 0.95 });
    const findings = results({ company: dental(), requirements: [requirement("percentage", "20%", { id: "q0" }), requirement("offer", "20% off", { id: "q1" })], detections: d });
    const board = scoreFindings(findings);
    const contrast = failedOf(byRule(findings, "accessibility.contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0].occurrences).toBe(3);
    expect(board.counting.filter((x) => x.ruleId.startsWith("brief"))).toHaveLength(1);

    const web = renderToStaticMarkup(<Scoreboard board={board} findings={findings} />).replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const data = buildReportData({ config: dental(), session, requirements: [req("q0", "percentage", "20%"), req("q1", "offer", "20% off")], files: [], findings, board, sampleData: false, provider: null, generatedAt: new Date("2026-10-18T10:00:00Z"), timeZone: "Asia/Dubai" });
    const pdf = (await renderReportPdf(data, null)).lines.join(" ");

    // The same issues on both: contrast once with its three places, the brief value once.
    expect(data.issuesToFix.filter((x) => x.title === "Text contrast")).toHaveLength(1);
    for (const out of [web, pdf]) {
      expect(out).toContain("Found 3 times:");
      expect(out.split("Found 3 times:")).toHaveLength(2); // once
      expect(out).toContain("Also required by the brief — counted once.");
    }
    // Both requirements are answered by the one issue.
    expect(data.requirements.map((r) => [r.value, r.status])).toEqual([
      ["20%", expect.stringMatching(/^To fix/)],
      ["20% off", expect.stringMatching(/^To fix/)],
    ]);
    expect(data.issues).toEqual(board.issues);
  });
});

describe("Stage 2 review: edge cases", () => {
  const zone = (labels: string) => f("platform.safe_zone", "failed", "minor", { title: "Safe zone", fileId: "f1", detected: `In the unsafe area: ${labels}` });
  const edge = (quote: string) => f("layout.edge_margin", "failed", "minor", { title: "Text near the edge", fileId: "f1", detected: `"${quote}" touches the edge` });

  it("safe zone + edge: a different text that only starts the same is NOT the same issue", () => {
    const out = consolidateFindings([zone('"Sale ends Sunday"'), edge("Sale")]);
    expect(out.map((x) => x.ruleId)).toEqual(["platform.safe_zone", "layout.edge_margin"]);
  });

  it("safe zone + edge: the same text, cut off at different lengths, IS the same issue", () => {
    const long = "Swipe up for the summer offer and get 20% off today";
    const out = consolidateFindings([zone(`"${long.slice(0, 30)}…"`), edge(`${long.slice(0, 40)}…`)]);
    expect(out.map((x) => x.ruleId)).toEqual(["platform.safe_zone"]);
    // …and exactly the same short text, uncut.
    expect(consolidateFindings([zone('"Sale"'), edge("Sale")]).map((x) => x.ruleId)).toEqual(["platform.safe_zone"]);
  });

  it("brief overlap: a mandatory requirement merged into an optional one keeps the PDF's MANDATORY note", () => {
    const shown = f("brief.requirement.required_text", "failed", "minor", { requirementId: "q1", title: "Required text", expected: "From AED 1,299", detected: "Not found", explanation: "The brief asks for this, but it isn't in the content." });
    const mandatory = f("brief.requirement.price", "failed", "critical", { requirementId: "q0", title: "Price", expected: "AED 1,299", detected: "AED 1,499", explanation: "The content shows a different price from the brief. The brief marks it as mandatory." });
    const [one] = consolidateFindings([mandatory, shown]);
    expect(one).toMatchObject({ requirementId: "q1", severity: "critical" });
    expect(one.explanation).toMatch(/The brief marks it as mandatory\./);
  });

  it("grouped passes and not-verified items keep their own wording — 'Found N times' is only for problems", () => {
    const passes = groupOccurrences([1, 2, 3].map((i) => f("accessibility.contrast", "passed", "major", { fileId: "f1", detected: `7.${i} : 1 — "T${i}"` })));
    expect(passes).toHaveLength(1);
    expect(passes[0].detected).not.toMatch(/^Found/);
    const notChecked = groupOccurrences([1, 2].map(() => f("accessibility.contrast", "unverified", "major", { fileId: "f1", detected: "Not checked", explanation: "The colours couldn't be read." })));
    expect(notChecked).toHaveLength(1);
    expect(notChecked[0].detected).toBe("Not checked");
  });

  it("missing or unusual text never breaks consolidation", () => {
    const odd = [
      f("platform.safe_zone", "failed", "minor", { fileId: "f1", detected: undefined }),
      f("layout.edge_margin", "failed", "minor", { fileId: "f1", detected: '"He said "hi"" touches the edge' }),
      f("brief.requirement.offer", "failed", "minor", { expected: undefined, detected: undefined }),
      f("brief.requirement.cta", "failed", "minor", { expected: "  ", detected: "" }),
      f("golden_rules.rule.approved_font", "failed", "major", { detected: ",,", title: "Golden Rule: Fonts" }),
      f("brand.fonts", "failed", "major", { detected: "" }),
      f("golden_rules.rule.approved_color", "failed", "major", { expected: "navy", title: "Golden Rule: Colour" }),
      f("brand.colors.present", "failed", "minor", { expected: undefined }),
      f("accessibility.contrast", "failed", "major", { fileId: "f1", detected: undefined, expected: undefined, suggestedFix: undefined }),
      f("accessibility.contrast", "failed", "major", { fileId: "f1", detected: undefined, expected: undefined, suggestedFix: undefined }),
    ];
    const out = consolidateFindings(odd);
    // Nothing is merged on empty or garbled text; only the two identical contrast findings are grouped.
    expect(out).toHaveLength(odd.length - 1);
    expect(out.find((x) => x.ruleId === "accessibility.contrast")).toMatchObject({ occurrences: 2 });
  });
});

describe("invariants: consolidation changes counting, never the verdict", () => {
  const scenarios: [string, Partial<QcContext>][] = [];
  const low = (t: string, y: number, fileId = "f1") => text(t, { fileId, color: "#999999", background: "#AAAAAA", box: { x: 0.3, y, w: 0.2, h: 0.04 }, fontSizePx: 60, confidence: 0.95 });
  for (const [name, c] of [["villas", villas], ["dental", dental]] as const) {
    scenarios.push([`${name}: repeated contrast + overlapping brief values`, {
      company: c(),
      requirements: [requirement("percentage", "20%", { id: "a" }), requirement("offer", "20% off", { id: "b" }), requirement("price", "AED 1,299", { id: "c", mandatory: true })],
      detections: detections({ frame: { width: 1080, height: 1080 }, texts: [low("Summer", 0.2), low("25% off", 0.4), low("AED 1,299", 0.6)], textCoverage: 0.95 }),
    }]);
    scenarios.push([`${name}: fonts and colours against Golden Rules`, {
      company: { ...c(), goldenRules: [golden({ category: "approved_font", approved_value: c().brand.fonts[0].family, mandatory: true }), golden({ category: "approved_color", approved_value: c().brand.colors[0].hex, mandatory: false })] },
      requirements: [requirement("cta", "Book now", { id: "d" })],
      detections: detections({ texts: [text("Book now", { role: "cta" })], fonts: [{ family: "Arial", confidence: 0.95 }], colors: [{ hex: "#FF00FF", share: 0.5 }], textCoverage: 0.95 }),
    }]);
    scenarios.push([`${name}: two designs, a passing brief`, {
      company: c(),
      requirements: [requirement("price", "AED 1,299", { id: "e" })],
      detections: detections({ texts: [low("AED 1,299", 0.2, "f1"), low("AED 1,299", 0.3, "f2")], textCoverage: 0.95 }),
    }]);
  }

  for (const [name, over] of scenarios)
    it(name, () => {
      const d = (over.detections ?? null) as ContentDetections | null;
      const before = applyConfidencePolicy(run(over), d, { state: "done" }, { provider: "google" });
      const after = consolidateFindings(before);
      const [b, a] = [scoreFindings(before), scoreFindings(after)];
      expect(a.result).toBe(b.result);
      expect(a.possibleCriticals > 0).toBe(b.possibleCriticals > 0);
      const severities = ["critical", "major", "minor", "suggestion"] as const;
      for (const s of severities) expect(a.issues[s]).toBeLessThanOrEqual(b.issues[s]);
      // The most serious issue is never lost (a merged duplicate is counted at the more serious severity).
      const worst = (x: typeof a) => severities.find((s) => x.issues[s] > 0) ?? null;
      expect(worst(a)).toBe(worst(b));
      // Every requirement any finding answered is still answered.
      const ids = (fs: Finding[]) => new Set(fs.flatMap((x) => [x.requirementId, ...(x.alsoCovers ?? []).map((c) => c.requirementId)]).filter(Boolean));
      expect(ids(after)).toEqual(ids(before));
      // Every occurrence is accounted for: grouped counts add up.
      const grouped = (fs: Finding[], status: string) => fs.filter((x) => GROUPED_RULES.includes(x.ruleId) && x.status === status).reduce((n, x) => n + (x.occurrences ?? 1), 0);
      const dropped = before.length - after.length - after.reduce((n, x) => n + (x.occurrences ?? 1) - 1, 0);
      expect(grouped(after, "failed")).toBeLessThanOrEqual(grouped(before, "failed"));
      expect(dropped).toBe(after.reduce((n, x) => n + (x.alsoCovers?.length ?? 0), 0) - before.reduce((n, x) => n + (x.alsoCovers?.length ?? 0), 0));
    });
});

describe("score table: a category whose check was merged into another category still shows that it ran", () => {
  // Brand's only finding — Arial — is the same issue as the Golden Rule's: merged into it.
  const fontCase = () => {
    const c = { ...villas(), brand: { ...villas().brand, colors: [], terms: [] }, logo: null, goldenRules: [golden({ category: "approved_font", rule: "Only Montserrat", approved_value: "Montserrat", mandatory: false })] };
    // Optional, so both are counted issues (a mandatory AI-judged font would be a possible critical to verify instead).
    const d = detections({ texts: [text("Hello")], fonts: [{ family: "Arial", confidence: 0.95 }], textCoverage: 0.95 });
    const before = applyConfidencePolicy(run({ company: c as never, detections: d }), d, { state: "done" }, { provider: "google" });
    return { before, after: consolidateFindings(before) };
  };
  const brandOf = (board: ReturnType<typeof scoreFindings>) => board.categories.find((x) => x.category === "brand")!;

  it("Brand: 'Checked — see Golden Rules', not 'Not checked'; its score stays out of the average", () => {
    const { after } = fontCase();
    const board = scoreFindings(after);
    expect(brandOf(board)).toMatchObject({ score: null, seeAlso: ["Golden Rules"] });
    expect(categoryScoreText(brandOf(board))).toBe("Checked — see Golden Rules");
    // The issue is counted once, under Golden Rules.
    expect(board.categories.find((x) => x.category === "golden_rules")!.issues.major).toBe(1);
  });

  it("scores, the overall score, the result and the findings are unchanged by this", () => {
    const { after } = fontCase();
    const board = scoreFindings(after);
    const withoutSeeAlso = scoreFindings(after.map((x) => ({ ...x, alsoCovers: undefined })));
    expect(board.score).toBe(withoutSeeAlso.score);
    expect(board.result).toBe(withoutSeeAlso.result);
    expect(board.categories.map((x) => [x.category, x.score, x.issues])).toEqual(withoutSeeAlso.categories.map((x) => [x.category, x.score, x.issues]));
    expect(withoutSeeAlso.categories.find((x) => x.category === "brand")!.seeAlso).toEqual([]);
  });

  it("only when the category has no score of its own; a category that never ran still says 'Not checked'", () => {
    expect(categoryScoreText({ score: 85, seeAlso: ["Golden Rules"] })).toBe("85");
    expect(categoryScoreText({ score: null, seeAlso: [] })).toBe("Not checked");
    expect(categoryScoreText({ score: null, seeAlso: ["Golden Rules", "Brief"] })).toBe("Checked — see Golden Rules, Brief");
    // A merge inside one category (two brief requirements) never points a category at itself.
    const brief = scoreFindings(results({ requirements: [requirement("percentage", "20%", { id: "a" }), requirement("offer", "20% off", { id: "b" })], detections: detections({ texts: [text("25% off")], textCoverage: 0.95 }) }));
    expect(brief.categories.find((x) => x.category === "brief")!.seeAlso).toEqual([]);
  });

  it("the website table and the report data say the same", () => {
    const { after } = fontCase();
    const board = scoreFindings(after);
    const html = renderToStaticMarkup(<CategoryScores board={board} />).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toMatch(/Brand Checked — see Golden Rules/);
    const session = { id: "s1", company_id: "c1", user_id: "u1", content_type: "social_post", platform: null, placement: null, status: "ready" } as unknown as QcSession;
    const data = buildReportData({ config: villas(), session, requirements: [], files: [], findings: after, board, sampleData: false, provider: null, generatedAt: new Date("2026-10-19T10:00:00Z"), timeZone: "Asia/Dubai" });
    expect(data.categories.find((x) => x.label === "Brand")!.score).toBe("Checked — see Golden Rules");
  });
});

describe("Stage 2 final review: nested brief values", () => {
  const req = (id: string, type: string, expected: string, severity: Severity = "minor") =>
    f(`brief.requirement.${type}`, "failed", severity, { requirementId: id, title: type, expected, detected: "Not found", explanation: "The brief asks for this, but it isn't in the content." });

  it("three nested values are one issue whatever order the requirements came in", () => {
    const a = req("a", "price", "AED 1,299", "critical");
    const b = req("b", "required_text", "From AED 1,299");
    const c = req("c", "offer", "From AED 1,299 per night");
    for (const order of [[a, b, c], [b, a, c], [b, c, a], [c, b, a], [a, c, b], [c, a, b]]) {
      const out = consolidateFindings(order);
      expect(out.map((x) => x.requirementId)).toEqual(["c"]); // the fullest is shown
      expect(out[0].severity).toBe("critical");
      expect(new Set(out[0].alsoCovers!.map((x) => x.requirementId))).toEqual(new Set(["a", "b"]));
    }
  });
});

describe("Stage 2 final review: a category shown under several others", () => {
  it("Brand's terms check shown under Content and its fonts check under Golden Rules → 'Checked — see Content, Golden Rules', the same on the website and in the report", async () => {
    const findings: Finding[] = [
      f("content.company_name", "failed", "major", { category: "content", title: "Company name spelling", alsoCovers: [{ ruleId: "brand.terms", category: "brand", title: "Terminology" }] }),
      f("golden_rules.rule.approved_font", "failed", "major", { category: "golden_rules", title: "Golden Rule: Only Montserrat", mandatory: false, alsoCovers: [{ ruleId: "brand.fonts", category: "brand", title: "Brand fonts" }] }),
      f("brief.requirement.cta", "passed", "major", { category: "brief", title: "CTA" }),
    ];
    const board = scoreFindings(findings);
    const brand = board.categories.find((x) => x.category === "brand")!;
    expect(brand).toMatchObject({ score: null, seeAlso: ["Content", "Golden Rules"] });
    expect(categoryScoreText(brand)).toBe("Checked — see Content, Golden Rules");
    // The categories the issues are counted in keep their own scores; the overall average is theirs alone.
    expect(board.categories.filter((x) => x.score !== null).map((x) => x.category)).toEqual(["content", "golden_rules", "brief"]);
    expect(board.score).toBe(Math.round((85 + 85 + 100) / 3));

    const web = renderToStaticMarkup(<CategoryScores board={board} />).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const session = { id: "s1", company_id: "c1", user_id: "u1", content_type: "social_post", platform: null, placement: null, status: "ready" } as unknown as QcSession;
    const data = buildReportData({ config: villas(), session, requirements: [], files: [], findings, board, sampleData: false, provider: null, generatedAt: new Date("2026-10-19T10:00:00Z"), timeZone: "Asia/Dubai" });
    for (const c of data.categories) expect(web).toContain(`${c.label} ${c.score}`); // every row: the same label and score text
    expect(data.categories.find((x) => x.label === "Brand")!.score).toBe("Checked — see Content, Golden Rules");
  });
});
