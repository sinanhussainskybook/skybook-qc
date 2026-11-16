import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryChecks } from "@/components/qc/category-checks";
import type { Finding } from "@/lib/qc/findings";

/** The checks by category: the brief's and the design's words are isolated (<bdi>) so Arabic reads correctly. */
describe("CategoryChecks", () => {
  it("shows Expected and Detected values inside <bdi>", () => {
    const ar = "عرض الصيف";
    const finding: Finding = {
      ruleId: "brief.headline",
      category: "brief",
      title: "Headline",
      severity: "major",
      status: "failed",
      kind: "fact",
      explanation: "The headline differs from the brief.",
      confidence: 1,
      expected: ar,
      detected: "Summer offer",
    };
    const html = renderToStaticMarkup(<CategoryChecks findings={[finding]} />);
    expect(html).toContain(`Expected: <bdi>${ar}</bdi>`);
    expect(html).toContain("Detected: <bdi>Summer offer</bdi>");
  });
});
