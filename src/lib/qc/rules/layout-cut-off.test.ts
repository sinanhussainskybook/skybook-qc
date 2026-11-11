import { describe, expect, it } from "vitest";
import { assembleDetections } from "@/lib/analysis/assemble";
import { applyConfidencePolicy } from "@/lib/analysis/policy";
import { validateDesignAnalysis } from "@/lib/analysis/validate";
import { consolidateFindings } from "@/lib/qc/consolidate";
import type { DetectedText } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import { scoreFindings } from "@/lib/qc/scoring";
import { byRule, company, detections, golden, requirement, run, text } from "../../../../test/qc-fixtures";

/**
 * Real case (Nexus flyer, 11 Nov 2026): the headline ran off the left edge of the canvas — "SET UP YOUR" showed
 * as "ET UP YOUR" and "BUSINESS" as "INESS" — and was reported only as MINOR "touches the edge". Text CUT OFF by
 * the canvas is now MAJOR "Text cut off at the edge"; text merely close to an edge stays MINOR. Cut off needs the
 * edge position (within 1%), an incomplete word of the approved on-design wording at that edge (not just another
 * form of a complete word), and context: the rest of the line continuing that wording, or — for a one-word line —
 * a neighbouring word of it elsewhere on the design.
 */

type Box = { x: number; y: number; w: number; h: number };
const line = (value: string, box: Box, over: Partial<DetectedText> = {}) => text(value, { box, confidence: 0.9, ...over });
const HEADLINE = requirement("headline", "Set Up Your Business. Get Licensed.");

// The checked flyer (1080 × 1350): positions measured from its pixels. "ET UP YOUR" starts at 0 px; "INESS" at
// 5 px = 0.46% of the width (cut between letters, so its first visible letter starts a little in).
const nexus = (etX = 0, inessX = 0.0046, confidence = 0.9) => [
  line("ET UP YOUR", { x: etX, y: 0.135, w: 0.3, h: 0.045 }, { role: "headline", confidence }),
  line("INESS", { x: inessX, y: 0.215, w: 0.265, h: 0.125 }, { role: "headline", confidence }),
  line("GET", { x: 0.375, y: 0.375, w: 0.14, h: 0.07 }, { role: "headline", confidence }),
  line("LICENSED", { x: 0.185, y: 0.47, w: 0.345, h: 0.1 }, { role: "headline", confidence }),
  line("Mainland, Free Zone and Offshore Setup,", { x: 0.22, y: 0.775, w: 0.56, h: 0.03 }, { confidence }),
  line("Handled by Nexus", { x: 0.22, y: 0.805, w: 0.25, h: 0.03 }, { confidence }),
  line("LAUNCH YOUR BUSINESS", { x: 0.22, y: 0.848, w: 0.27, h: 0.022 }, { role: "cta", confidence }),
];

const edge = (findings: Finding[]) => byRule(findings, "layout.edge_margin").filter((f) => f.status !== "passed");
const edgeOf = (texts: DetectedText[], requirements = [HEADLINE], over: Parameters<typeof run>[0] = {}) =>
  edge(run({ requirements, detections: detections({ texts, textCoverage: 1 }), ...over }));
const summary = (fs: Finding[]) => fs.map((f) => [f.title, f.severity, f.detected]);
const titles = (fs: Finding[]) => fs.map((f) => [f.title, f.severity]);
const NEAR = ["Text near the edge", "minor"];
const CUT = ["Text cut off at the edge", "major"];
const L = (x: number, w = 0.3, y = 0.4): Box => ({ x, y, w, h: 0.05 });
const R = (w = 0.3, y = 0.4): Box => ({ x: 1 - w, y, w, h: 0.05 });
const middle = (y: number): Box => ({ x: 0.4, y, w: 0.2, h: 0.05 });
const req = (type: string, value: string) => requirement(type, value, { mandatory: false });

describe("the Nexus flyer: headline cut off by the canvas", () => {
  it("both cut lines are MAJOR 'Text cut off at the edge', naming the incomplete word (real positions: 0 px and 0.46%)", () => {
    expect(summary(edgeOf(nexus()))).toEqual([
      ["Text cut off at the edge", "major", '"ET UP YOUR" runs off the left edge ("set" is incomplete)'],
      ["Text cut off at the edge", "major", '"INESS" runs off the left edge ("business" is incomplete)'],
    ]);
  });

  it("realistic box positions around 1% (an AI box can start a little in): still cut off; beyond 1%: near the edge", () => {
    for (const x of [0.0046, 0.008, 0.01]) expect([x, titles(edgeOf(nexus(x, x)))]).toEqual([x, [CUT, CUT]]);
    expect(titles(edgeOf(nexus(0.012, 0.012)))).toEqual([NEAR, NEAR]);
  });

  it("merged into one MAJOR finding ('Found 2 times'); with Gemini's reading the result is NEEDS REVISION, as live", () => {
    // Through the confidence policy, as in the app: the headline mismatch read by AI is a possible critical to
    // check by eye (as in the live report), so the counted issue is the cut-off MAJOR.
    const d = detections({ texts: nexus(), textCoverage: 1 });
    const findings = consolidateFindings(applyConfidencePolicy(run({ requirements: [HEADLINE], detections: d }), d, { state: "done" }, { provider: "gemini" }));
    const cut = edge(findings);
    expect(cut).toHaveLength(1);
    expect([cut[0].title, cut[0].severity, cut[0].occurrences]).toEqual(["Text cut off at the edge", "major", 2]);
    expect(cut[0].detected).toMatch(/^Found 2 times: "ET UP YOUR" runs off the left edge/);
    expect(scoreFindings(findings).result).toBe("needs_revision");
  });

  it("Gemini confidence through the real policy: 'clear' (0.9) is a counted MAJOR; 'likely' (0.7) a MAJOR to check by eye, not counted", () => {
    const through = (confidence: number) => {
      const d = detections({ texts: nexus(0, 0.0046, confidence), textCoverage: 1 });
      return consolidateFindings(applyConfidencePolicy(run({ requirements: [HEADLINE], detections: d }), d, { state: "done" }, { provider: "gemini" }));
    };
    const clear = edge(through(0.9));
    expect(clear.map((f) => [f.status, f.severity])).toEqual([["failed", "major"]]);
    expect(scoreFindings(through(0.9)).issues.major).toBe(1);
    const likely = edge(through(0.7));
    expect(likely.map((f) => [f.status, f.severity])).toEqual([["unverified", "major"]]);
    expect(likely[0].explanation).toMatch(/^Needs a human check/);
    expect(scoreFindings(through(0.7)).issues.major).toBe(0);
  });

  it("under every confidence profile (Gemini, exact readings, Local AI): a counted MAJOR — never critical", () => {
    for (const provider of ["gemini", "google", "local"] as const) {
      const d = detections({ texts: nexus(), textCoverage: 1 });
      const findings = consolidateFindings(applyConfidencePolicy(run({ requirements: [HEADLINE], detections: d }), d, { state: "done" }, { provider }));
      expect([provider, edge(findings).map((f) => [f.status, f.severity])]).toEqual([provider, [["failed", "major"]]]);
    }
  });

  it("the same flyer correctly placed has no edge finding at all", () => {
    const fixed = [
      line("SET UP YOUR", { x: 0.185, y: 0.185, w: 0.335, h: 0.045 }, { role: "headline" }),
      line("BUSINESS", { x: 0.185, y: 0.235, w: 0.46, h: 0.13 }, { role: "headline" }),
      ...nexus().slice(2),
    ];
    expect(edgeOf(fixed)).toEqual([]);
  });
});

describe("the seven false positives from the review stay MINOR 'Text near the edge'", () => {
  it("1. 'Summer Offer' at the right edge (approved 'Summer Offers')", () => {
    expect(titles(edgeOf([line("Summer Offer", R())], [req("headline", "Summer Offers")]))).toEqual([NEAR]);
  });

  it("2. 'OFFER' alone at the right edge (approved 'Exclusive Offers'), even with 'Exclusive' shown", () => {
    expect(titles(edgeOf([line("OFFER", R(0.2)), line("Exclusive", middle(0.3))], [req("headline", "Exclusive Offers")]))).toEqual([NEAR]);
  });

  it("3. 'Get License' at the right edge (approved 'Get Licensed')", () => {
    expect(titles(edgeOf([line("Get License", R())], [req("headline", "Get Licensed")]))).toEqual([NEAR]);
  });

  it("4. 'Book' alone at the right edge (approved CTA 'Booking')", () => {
    expect(titles(edgeOf([line("Book", R(0.2))], [req("cta", "Booking")]))).toEqual([NEAR]);
  });

  it("5. 'cover the city' at the left edge (approved 'Discover the city')", () => {
    expect(titles(edgeOf([line("cover the city", L(0))], [req("headline", "Discover the city")]))).toEqual([NEAR]);
  });

  it("6. 'LOCK' alone at the left edge (approved 'Unlock savings'), even with 'savings' shown", () => {
    expect(titles(edgeOf([line("LOCK", L(0, 0.2)), line("savings", middle(0.5))], [req("headline", "Unlock savings")]))).toEqual([NEAR]);
  });

  it("7. Arabic without the article or conjunction at the right (start) edge", () => {
    expect(titles(edgeOf([line("عروض الصيف", R())], [req("headline", "العروض الصيف")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("عروض", R(0.2)), line("أفضل", middle(0.3))], [req("headline", "أفضل العروض")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("عروض", R(0.2)), line("خصومات", middle(0.3))], [req("headline", "خصومات وعروض")]))).toEqual([NEAR]);
  });
});

describe("approved wording is only the wording meant to appear on the design", () => {
  it("target audience, special instruction, platform and 'other' brief fields never count (the line continues them word for word)", () => {
    expect(titles(edgeOf([line("ilies with children", L(0))], [req("target_audience", "Families with children")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("tional palette", L(0))], [req("special_instruction", "Use the promotional palette")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("agram Feed", L(0))], [req("platform", "Instagram Feed")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("ards ceremony", L(0))], [req("other", "Mention the awards ceremony")]))).toEqual([NEAR]);
  });

  it("Golden Rule wording (disclaimer, product name, CTA), the company name and approved terms do count", () => {
    const rules = { company: company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "Terms and conditions apply" })] }) };
    expect(titles(edgeOf([line("ditions apply", L(0, 0.3, 0.95))], [], rules))).toEqual([CUT]);
    expect(titles(edgeOf([line("ybook Villas", L(0, 0.3, 0.05))], []))).toEqual([CUT]); // company name "Skybook Villas"
  });

  it("a Golden Rule that isn't wording (colour, font, logo, other) never counts", () => {
    const rules = { company: company({ goldenRules: [golden({ category: "other", approved_value: "Mention the awards ceremony" })] }) };
    expect(titles(edgeOf([line("ards ceremony", L(0))], [], rules))).toEqual([NEAR]);
  });
});

describe("context: a one-word fragment needs the words around it on the design", () => {
  it("'INESS' alone with none of the headline's other words anywhere: near the edge", () => {
    expect(titles(edgeOf([line("INESS", L(0, 0.27))]))).toEqual([NEAR]);
  });

  it("'INESS' with 'GET' elsewhere on the design: cut off", () => {
    expect(titles(edgeOf([line("INESS", L(0, 0.27)), line("GET", middle(0.5))]))).toEqual([CUT]);
  });

  it("right edge: 'LICEN' of 'LICENSED' with 'GET' shown; 'GET LICEN' on one line", () => {
    expect(titles(edgeOf([line("GET", middle(0.3)), line("LICEN", R(0.25))]))).toEqual([CUT]);
    expect(summary(edgeOf([line("GET LICEN", R())]))).toEqual([["Text cut off at the edge", "major", '"GET LICEN" runs off the right edge ("licensed" is incomplete)']]);
  });

  it("a one-word approved wording can never be confirmed: 'ooking' alone (CTA 'Booking') stays near the edge", () => {
    expect(titles(edgeOf([line("ooking", L(0, 0.2))], [req("cta", "Booking")]))).toEqual([NEAR]);
  });
});

describe("other text near the edge stays MINOR", () => {
  it("whole words at the edge — even exactly at it", () => {
    expect(titles(edgeOf([line("SET UP YOUR", L(0))]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("BUSINESS", L(0.015, 0.4))]))).toEqual([NEAR]);
  });

  it("an incomplete word more than 1% in (inside the 2% margin)", () => {
    expect(titles(edgeOf([line("INESS", L(0.015, 0.27)), line("GET", middle(0.5))]))).toEqual([NEAR]);
  });

  it("the rest of the line doesn't continue the approved wording", () => {
    expect(titles(edgeOf([line("ET UP THEIR", L(0))]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("over the city", L(0))], [req("required_text", "Discover more")]))).toEqual([NEAR]);
  });

  it("too short to tell: one letter, or a one-word line of 2 letters", () => {
    expect(titles(edgeOf([line("T UP YOUR", L(0))]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("ET", L(0, 0.05)), line("UP", middle(0.5))]))).toEqual([NEAR]);
  });

  it("the fragment is itself an approved word ('Book' is approved as well as 'Booking')", () => {
    expect(titles(edgeOf([line("BOOK", R(0.2))], [req("required_text", "Booking"), req("cta", "Book")]))).toEqual([NEAR]);
  });

  it("no approved wording to compare with: MINOR, as before", () => {
    expect(titles(edgeOf([line("INESS", L(0, 0.27)), line("GET", middle(0.5))], []))).toEqual([NEAR]);
  });

  it("top and bottom edges are never 'cut off' (words aren't cut that way)", () => {
    expect(titles(edgeOf([line("INESS", { x: 0.3, y: 0, w: 0.27, h: 0.1 }), line("GET", middle(0.5))]))).toEqual([NEAR]);
  });

  it("the end of a word at the right edge (left-to-right text) is not a cut there", () => {
    expect(titles(edgeOf([line("INESS", R(0.27)), line("GET", middle(0.5))]))).toEqual([NEAR]);
  });
});

describe("direction: the first letter of the line", () => {
  const ar = [req("headline", "عروض الصيف الحصرية")];

  it("Arabic: the line starts at the RIGHT edge — the end of its first word left there is a cut", () => {
    const cut = edgeOf([line("روض الصيف", R())], ar);
    expect(titles(cut)).toEqual([CUT]);
    expect(cut[0].detected).toContain("right edge");
    // Whole words at the right edge, or the same text at the left (end) edge: MINOR.
    expect(titles(edgeOf([line("عروض الصيف", R())], ar))).toEqual([NEAR]);
    expect(titles(edgeOf([line("روض الصيف", L(0))], ar))).toEqual([NEAR]);
  });

  it("a mixed line starting with Arabic is right to left, even when most of its letters are Latin", () => {
    const mixed = [req("headline", "عروض Skybook Villas")];
    expect(titles(edgeOf([line("روض Skybook Villas", R())], mixed))).toEqual([CUT]);
    expect(titles(edgeOf([line("روض Skybook Villas", L(0))], mixed))).toEqual([NEAR]);
  });

  it("a mixed line starting with Latin is left to right", () => {
    const mixed = [req("headline", "Skybook عروض الصيف")];
    expect(titles(edgeOf([line("ybook عروض الصيف", L(0))], mixed))).toEqual([CUT]);
  });
});

describe("the five one-word false positives from the second review stay MINOR (a common word elsewhere never confirms a cut)", () => {
  it("'LIGHTS' (approved 'Cheap flights to Dubai'), 'to' on the very next line but not starting it", () => {
    expect(titles(edgeOf([line("LIGHTS", L(0, 0.25, 0.4)), line("Fly to the sun", middle(0.5))], [req("headline", "Cheap flights to Dubai")]))).toEqual([NEAR]);
  });

  it("'AND' (approved 'Your brand, your way'), 'your' elsewhere — and 3 letters is too few alone", () => {
    expect(titles(edgeOf([line("AND", L(0, 0.1, 0.4)), line("Book your stay", middle(0.6))], [req("headline", "Your brand, your way")]))).toEqual([NEAR]);
  });

  it("'RANGE' (approved 'The orange collection'), 'the' on a line that isn't adjacent", () => {
    const texts = [line("RANGE", L(0, 0.25, 0.4)), line("New season", middle(0.5)), line("Shop the sale", middle(0.6))];
    expect(titles(edgeOf(texts, [req("headline", "The orange collection")]))).toEqual([NEAR]);
  });

  it("'ART' (approved 'Start your journey'), 'your' elsewhere", () => {
    expect(titles(edgeOf([line("ART", L(0, 0.1, 0.4)), line("Plan your trip", middle(0.6))], [req("headline", "Start your journey")]))).toEqual([NEAR]);
  });

  it("'ICE' (approved 'Best price in town'), 'in' on the next line", () => {
    expect(titles(edgeOf([line("ICE", L(0, 0.1, 0.4)), line("in", middle(0.5))], [req("headline", "Best price in town")]))).toEqual([NEAR]);
  });

  it("adjacency is what counts: 'INESS' with 'GET' further down but another line in between, and no 'your' before it", () => {
    const texts = [line("INESS", L(0, 0.27, 0.3)), line("Mainland and Offshore", middle(0.45)), line("GET", middle(0.6))];
    expect(titles(edgeOf(texts))).toEqual([NEAR]);
  });

  it("…and with the adjacent line continuing the wording it is a cut: 'GET' right after 'INESS'", () => {
    expect(titles(edgeOf([line("INESS", L(0, 0.27, 0.3)), line("GET", middle(0.45)), line("Mainland and Offshore", middle(0.6))]))).toEqual([CUT]);
  });
});

describe("numbers and contact details (brief values and the company's saved contact details)", () => {
  const phone = [req("phone", "+971 4 123 4567")];

  it("a phone number cut at the left or right edge is MAJOR — Western and Arabic digits", () => {
    expect(summary(edgeOf([line("71 4 123 4567", L(0))], phone))).toEqual([["Text cut off at the edge", "major", '"71 4 123 4567" runs off the left edge ("971" is incomplete)']]);
    expect(titles(edgeOf([line("٧١ ٤ ١٢٣ ٤٥٦٧", L(0))], phone))).toEqual([CUT]);
    expect(titles(edgeOf([line("+971 4 123 45", R())], phone))).toEqual([CUT]);
  });

  it("the company's saved contact details count without a brief: phone, email and website", () => {
    // test company: +971 4 123 4567, sales@skybookvillas.com, https://skybookvillas.com
    expect(titles(edgeOf([line("71 4 123 4567", L(0))], []))).toEqual([CUT]);
    expect(summary(edgeOf([line("les@skybookvillas.com", L(0))], []))).toEqual([["Text cut off at the edge", "major", '"les@skybookvillas.com" runs off the left edge ("sales" is incomplete)']]);
    expect(titles(edgeOf([line("kybookvillas.com", L(0))], []))).toEqual([CUT]);
  });

  it("a price, a percentage and a date cut off are MAJOR", () => {
    expect(titles(edgeOf([line("ED 1,299", L(0, 0.2))], [req("price", "AED 1,299")]))).toEqual([CUT]);
    expect(titles(edgeOf([line("AED 1,29", R(0.2))], [req("price", "AED 1,299")]))).toEqual([CUT]);
    expect(titles(edgeOf([line("0% OFF", L(0, 0.2))], [req("percentage", "50% off")]))).toEqual([CUT]);
    expect(titles(edgeOf([line("ecember 2026", L(0))], [req("date", "15 December 2026")]))).toEqual([CUT]);
    expect(titles(edgeOf([line("15 Decem", R())], [req("date", "15 December 2026")]))).toEqual([CUT]);
  });

  it("formatting differences are never a cut: no '+', '00' prefix, local form, punctuation, case, digit style", () => {
    expect(titles(edgeOf([line("971 4 123 4567", L(0))], [req("phone", "00971 4 123 4567")]))).toEqual([NEAR]); // missing "00": formatting
    expect(titles(edgeOf([line("+971-4-123-4567", L(0))], phone))).toEqual([NEAR]);
    expect(titles(edgeOf([line("04 123 4567", L(0))], phone))).toEqual([NEAR]);
    expect(titles(edgeOf([line("+٩٧١ ٤ ١٢٣ ٤٥٦٧", L(0))], phone))).toEqual([NEAR]);
    expect(titles(edgeOf([line("SALES@SKYBOOKVILLAS.COM", L(0))], []))).toEqual([NEAR]);
    expect(titles(edgeOf([line("www.skybookvillas.com", L(0))], []))).toEqual([NEAR]);
  });

  it("currency symbols, separators and other forms of the same amount are never a cut", () => {
    const price = [req("price", "AED 1,299")];
    expect(titles(edgeOf([line("AED 1299", L(0, 0.2))], price))).toEqual([NEAR]);
    expect(titles(edgeOf([line("1,299 AED", L(0, 0.2))], price))).toEqual([NEAR]);
    expect(titles(edgeOf([line("Dhs. 1,299", L(0, 0.2))], price))).toEqual([NEAR]);
    expect(titles(edgeOf([line("١٬٢٩٩ درهم", R(0.2))], price))).toEqual([NEAR]);
    expect(titles(edgeOf([line("$49.99", L(0, 0.2))], [req("price", "USD 49.99")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("50% OFF", L(0, 0.2))], [req("percentage", "50% off")]))).toEqual([NEAR]);
  });

  it("other numbers and dates are never taken for a cut one", () => {
    expect(titles(edgeOf([line("71 5 555 5555", L(0))], phone))).toEqual([NEAR]); // another number
    expect(titles(edgeOf([line("2026 SUMMER SALE", L(0))], [req("date", "15 December 2026")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("15/12/2026", L(0, 0.2))], [req("date", "15 December 2026")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("10:00 AM", L(0, 0.2))], [req("time", "10:00 AM")]))).toEqual([NEAR]);
    // A single cut digit is too little to tell (stays near the edge): "5 December" for "15 December", "0:00" for "10:00".
    expect(titles(edgeOf([line("5 December 2026", L(0))], [req("date", "15 December 2026")]))).toEqual([NEAR]);
    expect(titles(edgeOf([line("0:00 AM", L(0, 0.2))], [req("time", "10:00 AM")]))).toEqual([NEAR]);
  });
});

describe("integration: the real Gemini answer → validateDesignAnalysis → assembleDetections → rules → policy → merging → scoring", () => {
  // The Nexus flyer as Gemini answers it: box_2d is [ymin, xmin, ymax, xmax] on a 0–1000 scale.
  const answer = (inessXmin: number, certainty: "clear" | "likely") =>
    JSON.stringify({
      texts: [
        { text: "ET UP YOUR", box_2d: [135, 0, 180, 300], role: "headline", fontFamily: null, bold: true, certainty },
        { text: "INESS", box_2d: [215, inessXmin, 340, 270], role: "headline", fontFamily: null, bold: true, certainty },
        { text: "GET", box_2d: [375, 375, 445, 515], role: "headline", fontFamily: null, bold: true, certainty },
        { text: "LICENSED", box_2d: [470, 185, 570, 530], role: "headline", fontFamily: null, bold: true, certainty },
        { text: "Mainland, Free Zone and Offshore Setup,", box_2d: [775, 220, 805, 780], role: "body", fontFamily: null, bold: false, certainty },
        { text: "LAUNCH YOUR BUSINESS", box_2d: [848, 220, 870, 490], role: "cta", fontFamily: null, bold: true, certainty },
      ],
      fonts: [],
      logo: { present: true, matchesCompanyLogo: null, box: null, certainty: "clear" },
      focalPoint: null,
      imageIssues: [],
      colorOnlyMeaning: { present: false, certainty: "clear", note: "" },
    });
  const pipeline = (inessXmin: number, certainty: "clear" | "likely") => {
    const checked = validateDesignAnalysis(answer(inessXmin, certainty), 1080, 1350);
    if (!checked.ok) throw new Error(checked.reason);
    const d = assembleDetections({
      provider: "gemini",
      frames: [{ fileId: "f1", frame: { width: 1080, height: 1350 }, ocr: checked.value.ocr, judgement: checked.value.judgement, colours: null }],
      analysedShare: 1,
      hasCompanyLogo: false,
    });
    const findings = consolidateFindings(applyConfidencePolicy(run({ requirements: [HEADLINE], detections: d }), d, { state: "done" }, { provider: "gemini" }));
    return { edge: edge(findings).map((f) => [f.title, f.status, f.severity, f.occurrences ?? 1]), board: scoreFindings(findings) };
  };

  it("'INESS' at the real 5/1000 and at 10/1000, read clearly: one counted MAJOR covering both lines; NEEDS REVISION", () => {
    for (const x of [5, 10]) {
      const { edge: found, board } = pipeline(x, "clear");
      expect([x, found]).toEqual([x, [["Text cut off at the edge", "failed", "major", 2]]]);
      expect([board.result, board.issues.major]).toEqual(["needs_revision", 1]);
    }
  });

  it("'INESS' at 12/1000: 'ET UP YOUR' is still the cut-off MAJOR; 'INESS' is near the edge", () => {
    expect(pipeline(12, "clear").edge).toEqual([
      ["Text cut off at the edge", "failed", "major", 1],
      ["Text near the edge", "failed", "minor", 1],
    ]);
  });

  it("read as 'likely' (0.7): a MAJOR to check by eye, not counted", () => {
    const { edge: found, board } = pipeline(5, "likely");
    expect(found).toEqual([["Text cut off at the edge", "unverified", "major", 2]]);
    expect(board.issues.major).toBe(0);
  });
});

describe("a word split across lines on purpose, with its continuation flush against the canvas edge, is never a cut", () => {
  it("hyphenated: 'Book-' / 'ing your trip is easy' (approved 'Booking your trip is easy')", () => {
    const texts = [line("Book-", L(0.004, 0.15, 0.6)), line("ing your trip is easy", L(0.004, 0.6, 0.67))];
    const found = edgeOf(texts, [req("required_text", "Booking your trip is easy")]);
    expect(found.some((f) => f.title === "Text cut off at the edge")).toBe(false);
    expect(titles(found)).toEqual([NEAR, NEAR]);
  });

  it("no hyphen: 'BUSI' / 'NESS' / 'SETUP' (approved 'Business setup')", () => {
    const texts = [line("BUSI", L(0.004, 0.3, 0.2)), line("NESS", L(0.004, 0.3, 0.27)), line("SETUP", L(0.004, 0.3, 0.34))];
    const found = edgeOf(texts, [req("headline", "Business setup")]);
    expect(found.some((f) => f.title === "Text cut off at the edge")).toBe(false);
    expect(titles(found)).toEqual([NEAR, NEAR, NEAR]);
  });

  it("at the other edge: 'GET LICEN' / 'SED' — the missing letters start the next line", () => {
    const texts = [line("GET LICEN", R(0.3, 0.4)), line("SED", middle(0.47))];
    expect(edgeOf(texts).some((f) => f.title === "Text cut off at the edge")).toBe(false);
  });

  it("a single letter or digit ending the line before never hides a real cut: 'ENJOY A' / 'ED 1,299' (price 'AED 1,299')", () => {
    const found = edgeOf([line("ENJOY A", L(0.2, 0.3, 0.3)), line("ED 1,299", L(0, 0.2, 0.37))], [req("price", "AED 1,299")]);
    expect(summary(found)).toEqual([["Text cut off at the edge", "major", '"ED 1,299" runs off the left edge ("aed" is incomplete)']]);
    const phone = edgeOf([line("OPEN FROM 9", L(0.3, 0.3, 0.8)), line("71 4 123 4567", L(0, 0.3, 0.87))], [req("phone", "+971 4 123 4567")]);
    expect(titles(phone)).toEqual([CUT]);
  });

  it("a real cut next to a different line is still MAJOR (the line before doesn't end with the missing letters)", () => {
    const found = edgeOf([line("Book your", L(0.004, 0.3, 0.6)), line("ing your trip is easy", L(0.004, 0.6, 0.67))], [req("required_text", "Booking your trip is easy")]);
    expect(summary(found.filter((f) => f.severity === "major"))).toEqual([["Text cut off at the edge", "major", '"ing your trip is easy" runs off the left edge ("booking" is incomplete)']]);
  });
});

describe("merging", () => {
  it("cut-off and near-edge findings are never merged with each other", () => {
    const texts = [...nexus(), line("Call 04 123 4567", { x: 0.6, y: 0.99, w: 0.3, h: 0.01 })];
    const merged = edge(consolidateFindings(run({ requirements: [HEADLINE], detections: detections({ texts, textCoverage: 1 }) })));
    expect(merged.map((f) => [f.title, f.severity, f.occurrences ?? 1])).toEqual([
      ["Text cut off at the edge", "major", 2],
      ["Text near the edge", "minor", 1],
    ]);
  });
});
