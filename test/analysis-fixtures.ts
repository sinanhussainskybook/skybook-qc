/**
 * Recorded-style provider responses for Phase 6 tests (plan 6.11): the same
 * shapes the real services return, built in code. No live calls.
 */

export type FixtureParagraph = {
  text: string;
  /** Pixel box in the image that was read. */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
};

/** A Cloud Vision DOCUMENT_TEXT_DETECTION response (the fields we read). */
export function visionResponse(paragraphs: FixtureParagraph[], pageConfidence = 0.97): string {
  const poly = (x: number, y: number, w: number, h: number) => ({
    vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });
  const blocks = paragraphs.map((p) => {
    const words = p.text.split(" ");
    const wordW = p.w / words.length;
    return {
      confidence: p.confidence ?? 0.98,
      paragraphs: [
        {
          boundingBox: poly(p.x, p.y, p.w, p.h),
          confidence: p.confidence ?? 0.98,
          words: words.map((word, i) => ({
            boundingBox: poly(Math.round(p.x + i * wordW), p.y, Math.round(wordW), p.h),
            confidence: p.confidence ?? 0.98,
            symbols: [...word].map((ch, j) => ({
              text: ch,
              ...(j === word.length - 1 && i < words.length - 1 ? { property: { detectedBreak: { type: "SPACE" } } } : {}),
            })),
          })),
        },
      ],
    };
  });
  return JSON.stringify({
    responses: [{ fullTextAnnotation: { pages: [{ confidence: paragraphs.length ? pageConfidence : undefined, blocks }] } }],
  });
}

export function judgement(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    blocks: [],
    fonts: [],
    logo: { present: false, matchesCompanyLogo: null, box: null, certainty: "clear" },
    focalPoint: null,
    imageIssues: [],
    colorOnlyMeaning: { present: false, certainty: "clear", note: "" },
    ...over,
  });
}
