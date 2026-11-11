import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignPreviews } from "@/components/qc/design-preview";

/**
 * The checked design beside the QC result (live report, 11 Nov 2026): a long file name, which can't wrap, widened
 * the design's column past its 22rem on the page, so the image covered the start of "Issues to fix". The list is
 * now ONE column that may shrink (grid-cols-1 = minmax(0, 1fr)), so the image keeps the column's width and the
 * file name is cut with "…" (truncate) instead of widening it. (Layout itself was checked in a browser.)
 */

const LONG_NAME = "Main-Set-Up-Your-Business.-Get-Licensed---Flyer-for-Nexushjkl.jpg.jpeg";
const preview = (fileName: string) => ({ id: "f1", fileName, url: "https://example.test/design.png", width: 1080, height: 1350 });
const markers = [{ n: 1, fileId: "f1", box: { x: 0, y: 0.135, w: 0.3, h: 0.045 }, severity: "major" as const }];
const listClasses = (html: string) => (/<ul[^>]*aria-label="Checked design"[^>]*class="([^"]+)"/.exec(html) ?? /<ul[^>]*class="([^"]+)"[^>]*aria-label="Checked design"/.exec(html))?.[1].split(" ") ?? [];

describe("the checked design beside the result keeps its column's width", () => {
  it("the list is one column that can shrink (grid-cols-1), so a long file name can't widen it", () => {
    const html = renderToStaticMarkup(<DesignPreviews previews={[preview(LONG_NAME)]} markers={markers} />);
    expect(listClasses(html)).toEqual(expect.arrayContaining(["grid", "grid-cols-1"]));
  });

  it("the file name stays on one line and is cut with '…' (truncate)", () => {
    const html = renderToStaticMarkup(<DesignPreviews previews={[preview(LONG_NAME)]} markers={markers} />);
    expect(html).toContain(`<span class="block truncate">${LONG_NAME}</span>`);
  });

  it("the image fills the column's width (no fixed width of its own)", () => {
    const html = renderToStaticMarkup(<DesignPreviews previews={[preview(LONG_NAME)]} markers={markers} />);
    expect(html).toMatch(/<a [^>]*class="relative block w-full [^"]*"/);
    expect(html).not.toMatch(/<a [^>]*style="[^"]*width:/);
  });

  it("several designs, and a file shown by name only, use the same shrinkable list", () => {
    const html = renderToStaticMarkup(
      <DesignPreviews previews={[preview(LONG_NAME), { ...preview(`${LONG_NAME}.pdf`), id: "f2", url: null }]} markers={markers} />
    );
    expect(listClasses(html)).toContain("grid-cols-1");
    expect(html).toContain(`<span class="min-w-0 truncate font-medium">${LONG_NAME}.pdf</span>`);
  });
});
