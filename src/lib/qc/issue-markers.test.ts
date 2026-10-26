import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/qc/findings";
import { issueMarkers } from "@/lib/qc/issue-markers";

/** The numbered circles on the design: each issue placed where its "Found" text was read, numbered as listed. */

const issue = (over: Partial<Finding>): Finding => ({
  ruleId: "brief.requirement.price",
  category: "brief",
  title: "Price",
  severity: "critical",
  status: "failed",
  kind: "fact",
  explanation: "",
  confidence: 1,
  ...over,
});
const box = (x: number, y: number) => ({ x, y, w: 0.2, h: 0.05 });

describe("issueMarkers", () => {
  const texts = [
    { text: "Snow Has Arrived in Azerbaijan!", confidence: 0.95, fileId: "d1", box: box(0.1, 0.1) },
    { text: "AED 4,500", confidence: 0.95, fileId: "d1", box: box(0.6, 0.5) },
    { text: "Customised Packages", confidence: 0.95, fileId: "d1", box: box(0.6, 0.6) },
    { text: "Ready for a Snowy Ecsape?", confidence: 0.9, fileId: "d1", box: box(0.05, 0.9) },
  ];

  it("places each issue on the text it found, numbered as in Issues to fix", () => {
    const toFix = [
      issue({ detected: "AED 4,500" }),
      issue({ title: "Dimensions", ruleId: "platform.size", severity: "major", detected: "1254 × 1254 px" }), // nothing on the design
      issue({ title: "Required text", severity: "major", detected: "Customised Packages" }),
      issue({ title: "CTA", severity: "minor", detected: "ready for a snowy ecsape?" }),
    ];
    expect(issueMarkers(toFix, texts, ["d1"])).toEqual([
      { n: 1, fileId: "d1", box: box(0.6, 0.5), severity: "critical" },
      { n: 3, fileId: "d1", box: box(0.6, 0.6), severity: "major" },
      { n: 4, fileId: "d1", box: box(0.05, 0.9), severity: "minor" },
    ]);
  });

  it("a missing value, a value read without a position, or no analysis: no circle", () => {
    expect(issueMarkers([issue({ detected: undefined })], texts, ["d1"])).toEqual([]);
    // "Not found" is never looked for on the design, even if those words happen to be on it.
    expect(issueMarkers([issue({ detected: "Not found" })], [{ text: "Not found", confidence: 0.9, fileId: "d1", box: box(0.1, 0.1) }], ["d1"])).toEqual([]);
    expect(issueMarkers([issue({ detected: "AED 4,500" })], [{ text: "AED 4,500", confidence: 0.9, fileId: "d1" }], ["d1"])).toEqual([]);
    expect(issueMarkers([issue({ detected: "AED 4,500" })], undefined, ["d1"])).toEqual([]);
  });

  it("several values found: the first one on the design is circled; thousands commas aren't split", () => {
    expect(issueMarkers([issue({ detected: "AED 3,999, AED 4,500" })], texts, ["d1"])).toMatchObject([{ n: 1, box: box(0.6, 0.5) }]);
  });

  it("with several designs, an issue about one design is only placed on that design", () => {
    const two = [...texts, { text: "AED 4,500", confidence: 0.95, fileId: "d2", box: box(0.3, 0.3) }];
    expect(issueMarkers([issue({ detected: "AED 4,500", fileId: "d2" })], two, ["d1", "d2"])).toMatchObject([{ fileId: "d2", box: box(0.3, 0.3) }]);
  });

  it("text read without a file id belongs to the only design", () => {
    expect(issueMarkers([issue({ detected: "AED 4,500" })], [{ text: "AED 4,500", confidence: 0.9, box: box(0.5, 0.5) }], ["d1"])).toMatchObject([{ fileId: "d1" }]);
  });
});
