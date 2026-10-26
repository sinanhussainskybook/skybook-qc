import { containsText, normalizeWords } from "@/lib/qc/compare";
import type { Box, DetectedText } from "@/lib/qc/detections";
import type { Finding, Severity } from "@/lib/qc/findings";
import type { Scoreboard } from "@/lib/qc/scoring";

/**
 * Where each issue to fix is on the design, for the numbered circles drawn over it beside the result.
 *
 * Findings don't carry a position; the analysis does record where each piece of text sits. So an issue
 * is placed where the text it found ("Found …") was read — the same number as in "Issues to fix". An
 * issue with nothing on the design to point at (missing text, the size of the file) gets no circle, and
 * neither does one whose text was read without a position. Positions are approximate (the AI's own text
 * boxes); this is a pointer for the eye, never part of the result.
 */

export type IssueMarker = { n: number; fileId: string; box: Box; severity: Severity };

/** The counted issues in the order "Issues to fix" lists and numbers them (suggestions are listed apart). */
export function issuesToFix(board: Scoreboard): Finding[] {
  return board.counting.filter((f) => f.severity !== "suggestion");
}

export function issueMarkers(toFix: Finding[], texts: DetectedText[] | undefined, designFileIds: string[]): IssueMarker[] {
  if (!texts?.length || designFileIds.length === 0) return [];
  // Text read without a file id belongs to the only design, if there is just one.
  const fileOf = (t: DetectedText) => t.fileId ?? (designFileIds.length === 1 ? designFileIds[0] : undefined);
  const placed = texts.filter((t) => t.box && (t.page ?? 1) === 1 && fileOf(t));

  const markers: IssueMarker[] = [];
  toFix.forEach((f, i) => {
    // Something missing isn't on the design to circle.
    if (f.detected === "Not found") return;
    // "Found" can list several values ("AED 1,399, AED 1,499"); the first one read on the design is used.
    const values = (f.detected ?? "").split(/,\s+(?=\S)/).map((v) => v.trim()).filter((v) => normalizeWords(v).length >= 2);
    for (const value of values) {
      const hit = placed.find(
        (t) =>
          (!f.fileId || fileOf(t) === f.fileId) &&
          (containsText(t.text, value) || (normalizeWords(t.text).length >= 3 && containsText(value, t.text)))
      );
      if (hit) {
        markers.push({ n: i + 1, fileId: fileOf(hit)!, box: hit.box!, severity: f.severity });
        return;
      }
    }
  });
  return markers;
}
