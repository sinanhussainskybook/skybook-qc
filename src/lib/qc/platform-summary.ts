import { FILE_FORMATS } from "@/lib/qc/qc-file";
import type { PlacementSpec, Size } from "@/lib/qc/platforms";

/**
 * Plain-language lines describing a placement's approved requirements (D4),
 * shown under the platform picker so the designer sees what will be checked.
 */
export function placementSummary(spec: PlacementSpec): string[] {
  if (spec.notConfigured) return [spec.notConfigured];
  const size = (s: Size) => `${s.w} × ${s.h}`;
  const lines: string[] = [];
  if (spec.formats) lines.push(`Format: ${spec.formats.map((f) => FILE_FORMATS[f].label).join(", ")}`);
  if (spec.exactSizes) lines.push(`Size: exactly one of ${spec.exactSizes.length} listed ad sizes (e.g. 300 × 250, 728 × 90)`);
  if (spec.ratio) {
    const r = `${spec.ratio.recommended.w}:${spec.ratio.recommended.h}`.replace("191:100", "1.91:1");
    lines.push(
      spec.ratio.allowed
        ? `Ratio: ${r} recommended; allowed ${spec.ratio.allowed.min.toFixed(2)}–${spec.ratio.allowed.max.toFixed(2)} (width ÷ height)`
        : spec.ratio.tolerance !== undefined
          ? `Ratio: ${r} (±${spec.ratio.tolerance * 100}%)`
          : `Ratio: ${r} recommended`
    );
  }
  if (spec.ratioVariants) lines.push(`Ratio: ${spec.ratioVariants.map((v) => v.label).join(", ")}`);
  if (spec.recommended) lines.push(`Recommended: ${size(spec.recommended)}`);
  if (spec.min) {
    const min = spec.min.w && spec.min.h ? size(spec.min as Size) : spec.min.w ? `${spec.min.w} px wide` : `${spec.min.h} px tall`;
    lines.push(
      `Minimum: ${min}${spec.minWidthFromSeconds ? ` (${spec.minWidthFromSeconds.width} px wide from ${spec.minWidthFromSeconds.seconds} s)` : ""}`
    );
  }
  if (spec.max) lines.push(`Maximum: ${size(spec.max)}`);
  if (spec.squareOrVertical) lines.push("Orientation: square or vertical");
  if (spec.resolutionGuide) lines.push(`Resolution: ${size(spec.resolutionGuide.min)} to ${size(spec.resolutionGuide.max)}`);
  if (spec.bytesLabel) lines.push(`File size: ${spec.bytesLabel.includes("–") ? spec.bytesLabel : `up to ${spec.bytesLabel}`}`);
  if (spec.durationSec) {
    const t = (s: number) => (s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`);
    const d = spec.durationSec;
    lines.push(`Length: ${d.min ? `${t(d.min)} to ` : "up to "}${d.max !== undefined ? t(d.max) : ""}`);
  }
  if (spec.safeZone) lines.push(`Safe zone: keep the top ${spec.safeZone.top}% and bottom ${spec.safeZone.bottom}% clear (checked visually in a later phase)`);
  return lines;
}
