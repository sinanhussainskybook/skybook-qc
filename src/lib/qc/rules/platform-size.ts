import type { QcFile, QcSession } from "@/lib/db/qc-sessions";
import { CONTENT_TYPES, type ContentType } from "@/lib/qc/content-types";
import type { Finding, Rule, Severity } from "@/lib/qc/findings";
import type { MediaInfo } from "@/lib/qc/media-info";
import {
  findPlacement,
  findPlatform,
  PRINT_SIZE_TOLERANCE_MM,
  RATIO_MATCH_TOLERANCE,
  type PlacementSpec,
  type Platform,
  type Size,
} from "@/lib/qc/platforms";
import { FILE_FORMATS, formatForMime, type FileFormat } from "@/lib/qc/qc-file";

/**
 * Platform / Size QC (plan 5.11, values per D4 in lib/qc/platforms.ts).
 *
 * Objective, technical checks on what was MEASURED from the uploaded
 * content (lib/qc/media-info.ts): format, file size, dimensions, aspect
 * ratio, resolution, length. Severities (approved 2026-10-01):
 *   MAJOR      — a published limit is broken
 *   SUGGESTION — below the recommended resolution, or a ratio the platform
 *                only recommends (no published tolerance)
 *   UNVERIFIED — something couldn't be measured, or needs visual analysis
 *                (safe zones — Phase 6). Never a guess.
 * Nothing here is CRITICAL. Nothing here decides PASS / FAIL (Phase 7).
 */

export type ContentFileFacts = {
  id: string;
  fileName: string;
  format: FileFormat | null;
  size: number;
  media: MediaInfo | null;
};

export type CustomChoice = {
  label: string | null;
  width: number;
  height: number;
  unit: "px" | "mm";
  minDpi: number | null;
  maxBytes: number | null;
};

/** Where text and the logo sit (fractions of the frame) — from content analysis (Phase 6); absent = not analysed. */
/** A detected text or logo and where it sits. `confidence`: how sure its detection is (0–1; absent = 1). */
export type PlacedElement = { label: string; box: { x: number; y: number; w: number; h: number }; fileId?: string; confidence?: number };

export type PlatformContext = {
  platform: string | null;
  placement: string | null;
  custom: CustomChoice | null;
  files: ContentFileFacts[];
  /** For the safe-zone check. Undefined until the content has been analysed. */
  elements?: PlacedElement[];
};

type SessionPlatformColumns = Pick<
  QcSession,
  | "platform"
  | "placement"
  | "custom_label"
  | "custom_width"
  | "custom_height"
  | "custom_unit"
  | "custom_min_dpi"
  | "custom_max_bytes"
>;

/** The session's custom size, when one was typed. */
export function customChoiceOf(session: SessionPlatformColumns): CustomChoice | null {
  if (!session.custom_width || !session.custom_height || !session.custom_unit) return null;
  return {
    label: session.custom_label,
    width: session.custom_width,
    height: session.custom_height,
    unit: session.custom_unit,
    minDpi: session.custom_min_dpi,
    maxBytes: session.custom_max_bytes,
  };
}

/** What was measured from a stored file, in the rules' terms. */
export function fileFactsOf(file: QcFile): ContentFileFacts {
  const format = formatForMime(file.mime_type);
  const measured =
    file.media_width !== null ||
    file.media_height !== null ||
    file.media_duration_ms !== null ||
    file.media_note !== null;
  return {
    id: file.id,
    fileName: file.file_name,
    format,
    size: file.file_size,
    media: measured
      ? {
          unit: format === "pdf" ? "pt" : "px",
          width: file.media_width ?? undefined,
          height: file.media_height ?? undefined,
          durationMs: file.media_duration_ms ?? undefined,
          dpi: file.media_dpi ?? undefined,
          pages: file.media_pages ?? undefined,
          note: file.media_note ?? undefined,
        }
      : null,
  };
}

/** The platform / size check's input for one session: its choice and its ready content files. */
export function platformContextOf(session: SessionPlatformColumns, files: QcFile[]): PlatformContext {
  return {
    platform: session.platform,
    placement: session.placement,
    custom: customChoiceOf(session),
    files: files.filter((f) => f.kind === "content" && f.status === "ready").map(fileFactsOf),
  };
}

const ALL_TYPES = CONTENT_TYPES.map((t) => t.value) as ContentType[];
const CATEGORY = "platform_size" as const;

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

const KNOWN_RATIOS: [string, number][] = [
  ["1:1", 1], ["4:5", 4 / 5], ["9:16", 9 / 16], ["16:9", 16 / 9], ["1.91:1", 1.91],
  ["3:4", 3 / 4], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 3 / 2],
];

export function ratioLabel(value: number): string {
  const known = KNOWN_RATIOS.find(([, r]) => Math.abs(value / r - 1) <= 0.005);
  return known ? known[0] : `${value.toFixed(2)}:1`;
}

const sizeText = (s: Size) => `${s.w} × ${s.h}`;
const detectedSize = (m: MediaInfo) => `${m.width} × ${m.height}${m.unit === "pt" ? " pt" : ""}`;
const formatNames = (formats: readonly FileFormat[]) => formats.map((f) => FILE_FORMATS[f].label).join(" or ");
const seconds = (s: number) => (s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`);

type Where = { file: ContentFileFacts; source?: Finding["source"] };

function finding(
  where: Where,
  id: string,
  title: string,
  severity: Severity,
  status: Finding["status"],
  parts: Pick<Finding, "expected" | "detected" | "explanation" | "suggestedFix"> & { kind?: Finding["kind"]; confidence?: number }
): Finding {
  return {
    ruleId: id,
    category: CATEGORY,
    title,
    severity,
    status,
    kind: parts.kind ?? "fact",
    expected: parts.expected,
    detected: parts.detected,
    explanation: parts.explanation,
    suggestedFix: status === "failed" ? parts.suggestedFix : undefined,
    confidence: status === "unverified" ? 0 : (parts.confidence ?? 1),
    fileId: where.file.id,
    fileName: where.file.fileName,
    source: where.source,
  };
}

/** The measured pixel size, or an UNVERIFIED finding saying why there isn't one. */
function measuredPixels(where: Where, id: string): { size: Size } | { missing: Finding } {
  const m = where.file.media;
  if (m && m.width && m.height && m.unit === "px") return { size: { w: m.width, h: m.height } };
  const why =
    m?.unit === "pt"
      ? "A PDF's page size is in points; its size in pixels depends on how it's exported, so it can't be compared with a pixel requirement."
      : m?.note ?? "The size of this file couldn't be measured.";
  return {
    missing: finding(where, id, "Dimensions", "major", "unverified", {
      detected: "Not measured",
      explanation: why,
    }),
  };
}

// ---------------------------------------------------------------------------
// Checks for a published placement
// ---------------------------------------------------------------------------

function checkFormat(where: Where, spec: PlacementSpec): Finding[] {
  if (!spec.formats || !where.file.format) return [];
  const ok = spec.formats.includes(where.file.format);
  return [
    finding(where, "platform.format", "File format", "major", ok ? "passed" : "failed", {
      expected: formatNames(spec.formats),
      detected: FILE_FORMATS[where.file.format].label,
      explanation: ok
        ? `${spec.label} accepts this format.`
        : `${spec.label} accepts ${formatNames(spec.formats)} files only. (The format was read from the file's contents, not its name.)`,
      suggestedFix: `Export the creative as ${formatNames(spec.formats)}.`,
    }),
  ];
}

function checkFileSize(where: Where, maxBytes?: number, minBytes?: number, label?: string): Finding[] {
  if (maxBytes === undefined && minBytes === undefined) return [];
  const size = where.file.size;
  const tooBig = maxBytes !== undefined && size > maxBytes;
  const tooSmall = minBytes !== undefined && size < minBytes;
  const expected = label ?? (maxBytes !== undefined ? `At most ${decimalBytes(maxBytes)}` : `At least ${decimalBytes(minBytes!)}`);
  return [
    finding(where, "platform.file_size", "File size", "major", tooBig || tooSmall ? "failed" : "passed", {
      expected,
      detected: `${decimalBytes(size)} (${size.toLocaleString("en-GB")} bytes)`,
      explanation: tooBig
        ? "The file is larger than the platform allows."
        : tooSmall
          ? "The file is smaller than the platform accepts."
          : "The file size is within the platform's limit.",
      suggestedFix: tooBig
        ? "Export at a lower quality setting or re-compress the file to bring it under the limit."
        : "Re-export at a higher quality setting.",
    }),
  ];
}

function checkRatio(where: Where, spec: PlacementSpec, size: Size): Finding[] {
  const rule = spec.ratio;
  if (!rule) return [];
  const actual = size.w / size.h;
  const recommended = rule.recommended.w / rule.recommended.h;
  const findings: Finding[] = [];
  const detected = `${ratioLabel(actual)} (${sizeText(size)})`;

  if (rule.allowed && rule.tolerance !== undefined) {
    const inRange = actual >= rule.allowed.min * (1 - rule.tolerance) && actual <= rule.allowed.max * (1 + rule.tolerance);
    findings.push(
      finding(where, "platform.ratio", "Aspect ratio", "major", inRange ? "passed" : "failed", {
        expected: `Between ${ratioLabel(rule.allowed.min)} and ${ratioLabel(rule.allowed.max)}`,
        detected,
        explanation: inRange
          ? "The aspect ratio is within the range the platform allows."
          : `${spec.label} only allows ratios between ${ratioLabel(rule.allowed.min)} and ${ratioLabel(rule.allowed.max)} (±${rule.tolerance * 100}%).`,
        suggestedFix: `Resize or crop the creative to ${ratioLabel(recommended)} (e.g. ${sizeText(spec.recommended ?? rule.recommended)}).`,
      })
    );
    if (inRange) {
      const onRecommended = Math.abs(actual / recommended - 1) <= rule.tolerance;
      findings.push(
        finding(where, "platform.ratio_recommended", "Recommended aspect ratio", "suggestion", onRecommended ? "passed" : "failed", {
          expected: ratioLabel(recommended),
          detected,
          explanation: onRecommended
            ? "The creative uses the ratio the platform recommends."
            : `The ratio is allowed, but ${spec.label} recommends ${ratioLabel(recommended)}.`,
          suggestedFix: `Consider ${ratioLabel(recommended)} (${sizeText(spec.recommended ?? rule.recommended)}) for the best fit.`,
        })
      );
    }
    return findings;
  }

  const tolerance = rule.tolerance ?? RATIO_MATCH_TOLERANCE;
  const matches = Math.abs(actual / recommended - 1) <= tolerance;
  const hard = rule.tolerance !== undefined;
  findings.push(
    finding(where, "platform.ratio", "Aspect ratio", hard ? "major" : "suggestion", matches ? "passed" : "failed", {
      expected: hard ? `${ratioLabel(recommended)} (±${rule.tolerance! * 100}%)` : `${ratioLabel(recommended)} (recommended)`,
      detected,
      explanation: matches
        ? "The aspect ratio matches."
        : hard
          ? `${spec.label} requires ${ratioLabel(recommended)}; this creative is ${ratioLabel(actual)}, so it will be cropped or rejected.`
          : `${spec.label} recommends ${ratioLabel(recommended)} but publishes no exact tolerance, so this is a recommendation.`,
      suggestedFix: `Resize or export the creative at ${ratioLabel(recommended)}${spec.recommended ? ` (${sizeText(spec.recommended)})` : ""}.`,
    })
  );
  return findings;
}

function checkMinMax(where: Where, label: string, size: Size, min?: Partial<Size>, max?: Size, minWidthNote?: string): Finding[] {
  const findings: Finding[] = [];
  if (min && (min.w || min.h)) {
    const ok = (!min.w || size.w >= min.w) && (!min.h || size.h >= min.h);
    const expected = min.w && min.h ? `At least ${min.w} × ${min.h}` : min.w ? `At least ${min.w} px wide` : `At least ${min.h} px tall`;
    findings.push(
      finding(where, "platform.size_min", "Minimum size", "major", ok ? "passed" : "failed", {
        expected: minWidthNote ? `${expected} (${minWidthNote})` : expected,
        detected: sizeText(size),
        explanation: ok ? "Meets the minimum size." : `${label} doesn't accept creatives this small.`,
        suggestedFix: "Export the creative at a larger size (from the original artwork, not by enlarging this file).",
      })
    );
  }
  if (max) {
    const ok = size.w <= max.w && size.h <= max.h;
    findings.push(
      finding(where, "platform.size_max", "Maximum size", "major", ok ? "passed" : "failed", {
        expected: `At most ${sizeText(max)}`,
        detected: sizeText(size),
        explanation: ok ? "Within the maximum size." : `${label} doesn't accept creatives this large.`,
        suggestedFix: `Export the creative at or below ${sizeText(max)}.`,
      })
    );
  }
  return findings;
}

function checkRecommended(where: Where, label: string, size: Size, recommended?: Size): Finding[] {
  if (!recommended) return [];
  const ok = size.w >= recommended.w && size.h >= recommended.h;
  return [
    finding(where, "platform.resolution_recommended", "Recommended resolution", "suggestion", ok ? "passed" : "failed", {
      expected: `${sizeText(recommended)} or larger`,
      detected: sizeText(size),
      explanation: ok
        ? "Meets the recommended resolution."
        : `${label} recommends ${sizeText(recommended)}; a smaller creative is accepted but may look less sharp.`,
      suggestedFix: `Export at ${sizeText(recommended)} if the original artwork allows it.`,
    }),
  ];
}

function checkDuration(where: Where, label: string, range?: { min?: number; max?: number }): Finding[] {
  if (!range) return [];
  const ms = where.file.media?.durationMs;
  const expected =
    range.min !== undefined && range.max !== undefined
      ? `${seconds(range.min)} to ${seconds(range.max)}`
      : range.max !== undefined
        ? `Up to ${seconds(range.max)}`
        : `At least ${seconds(range.min!)}`;
  if (ms === undefined) {
    return [
      finding(where, "platform.duration", "Length", "major", "unverified", {
        expected,
        detected: "Not measured",
        explanation: where.file.media?.note ?? "The video's length couldn't be measured.",
      }),
    ];
  }
  const s = ms / 1000;
  const ok = (range.min === undefined || s >= range.min) && (range.max === undefined || s <= range.max);
  return [
    finding(where, "platform.duration", "Length", "major", ok ? "passed" : "failed", {
      expected,
      detected: seconds(Math.round(s * 10) / 10),
      explanation: ok ? "The length is within the platform's limits." : `${label} doesn't accept videos of this length.`,
      suggestedFix: range.max !== undefined && s > range.max ? `Trim the video to ${seconds(range.max)} or less.` : "Extend the video to the minimum length.",
    }),
  ];
}

function checkSafeZone(where: Where, spec: PlacementSpec, elements: PlacedElement[] | undefined): Finding[] {
  const z = spec.safeZone;
  if (!z) return [];
  const sides = z.left !== undefined ? `, ${z.left}% on each side` : "";
  const expected = `Keep the top ${z.top}% and bottom ${z.bottom}%${sides} free of text, logos and key elements`;
  if (!elements) {
    return [
      finding(where, "platform.safe_zone", "Safe zone", "minor", "unverified", {
        kind: "judgement",
        expected,
        detected: "Not checked yet",
        explanation: "Checking where text and logos sit needs their positions from content analysis, which isn't available. This is not counted for or against the result.",
      }),
    ];
  }
  const top = z.top / 100;
  const bottom = 1 - z.bottom / 100;
  const left = (z.left ?? 0) / 100;
  const right = 1 - (z.right ?? 0) / 100;
  const outside = elements
    .filter((e) => !e.fileId || e.fileId === where.file.id)
    .filter((e) => e.box.y < top || e.box.y + e.box.h > bottom || e.box.x < left || e.box.x + e.box.w > right);
  return [
    finding(where, "platform.safe_zone", "Safe zone", "minor", outside.length ? "failed" : "passed", {
      expected,
      detected: outside.length ? `In the unsafe area: ${outside.map((e) => e.label).join(", ")}` : "Text and logo inside the safe area",
      explanation: outside.length
        ? `${spec.label} covers these areas with its own buttons and captions, so anything there may be hidden.`
        : "Text and logo stay clear of the areas the platform covers.",
      suggestedFix: "Move the text or logo into the middle of the frame, away from the top and bottom.",
      // Based on detected positions, not the file itself: as sure as the least sure element it's about.
      ...(outside.length ? { confidence: Math.min(...outside.map((e) => e.confidence ?? 1)) } : {}),
    }),
  ];
}

function checkPublished(file: ContentFileFacts, spec: PlacementSpec, platform: Platform, elements?: PlacedElement[]): Finding[] {
  const where: Where = { file, source: spec.source };
  const label = `${platform.label} ${spec.label}`;
  const findings: Finding[] = [...checkFormat(where, spec), ...checkFileSize(where, spec.maxBytes, spec.minBytes, spec.bytesLabel)];

  const measured = measuredPixels(where, "platform.dimensions");
  if ("missing" in measured) {
    findings.push(measured.missing);
  } else {
    const size = measured.size;
    if (spec.exactSizes) {
      const match = spec.exactSizes.find((s) => s.w === size.w && s.h === size.h);
      findings.push(
        finding(where, "platform.exact_size", "Ad size", "major", match ? "passed" : "failed", {
          expected: `One of: ${spec.exactSizes.map(sizeText).join(", ")}`,
          detected: match ? `${sizeText(size)} (${match.name})` : sizeText(size),
          explanation: match ? "This is one of the accepted ad sizes." : "Uploaded image ads must be exactly one of the listed sizes.",
          suggestedFix: "Export the ad at one of the listed sizes, e.g. 300 × 250 or 728 × 90.",
        })
      );
    }
    findings.push(...checkRatio(where, { ...spec, label }, size));

    if (spec.ratioVariants) {
      const actual = size.w / size.h;
      const variant = spec.ratioVariants.find((v) => Math.abs(actual / (v.ratio.w / v.ratio.h) - 1) <= RATIO_MATCH_TOLERANCE);
      findings.push(
        finding(where, "platform.ratio", "Aspect ratio", "major", variant ? "passed" : "failed", {
          expected: `One of: ${spec.ratioVariants.map((v) => v.label).join(", ")}`,
          detected: `${ratioLabel(actual)} (${sizeText(size)})`,
          explanation: variant ? `Matches ${variant.label}.` : `${label} supports ${spec.ratioVariants.map((v) => v.label).join(", ")} only.`,
          suggestedFix: "Export the video in one of the supported ratios.",
        })
      );
      if (variant) {
        findings.push(...checkMinMax(where, label, size, variant.min, variant.max));
        findings.push(...checkRecommended(where, label, size, variant.recommended));
      }
    }

    let min = spec.min;
    let minNote: string | undefined;
    if (spec.minWidthFromSeconds) {
      const ms = file.media?.durationMs;
      if (ms !== undefined && ms >= spec.minWidthFromSeconds.seconds * 1000) {
        min = { ...min, w: spec.minWidthFromSeconds.width };
        minNote = `for videos of ${spec.minWidthFromSeconds.seconds} s or longer`;
      }
    }
    findings.push(...checkMinMax(where, label, size, min, spec.max, minNote));
    if (!spec.ratioVariants) findings.push(...checkRecommended(where, label, size, spec.recommended));

    if (spec.resolutionGuide) {
      const g = spec.resolutionGuide;
      const ok = size.w >= g.min.w && size.h >= g.min.h && size.w <= g.max.w && size.h <= g.max.h;
      findings.push(
        finding(where, "platform.resolution_guide", "Resolution", "suggestion", ok ? "passed" : "failed", {
          expected: `Between ${sizeText(g.min)} and ${sizeText(g.max)}`,
          detected: sizeText(size),
          explanation: ok ? "Within YouTube's listed resolutions." : "Outside the resolutions YouTube lists for upload.",
          suggestedFix: "Export at one of YouTube's listed resolutions, e.g. 1920 × 1080.",
        })
      );
    }
    if (spec.squareOrVertical) {
      const ok = size.w <= size.h;
      findings.push(
        finding(where, "platform.orientation", "Square or vertical", "major", ok ? "passed" : "failed", {
          expected: "Square or vertical (width ≤ height)",
          detected: `${sizeText(size)} (${size.w > size.h ? "horizontal" : size.w === size.h ? "square" : "vertical"})`,
          explanation: ok ? "Square or vertical, as Shorts require." : "Horizontal videos aren't categorised as Shorts.",
          suggestedFix: "Export the video vertically (e.g. 1080 × 1920) or square.",
        })
      );
    }
  }
  findings.push(...checkDuration(where, label, spec.durationSec));
  findings.push(...checkSafeZone(where, spec, elements));
  return findings;
}

// ---------------------------------------------------------------------------
// Checks for a typed custom size (website / email banner, print, slide, other)
// ---------------------------------------------------------------------------

function checkCustom(file: ContentFileFacts, custom: CustomChoice, platform: Platform): Finding[] {
  const where: Where = { file };
  const label = custom.label ? `${platform.label} (${custom.label})` : platform.label;
  const findings: Finding[] = [];
  if (custom.maxBytes) findings.push(...checkFileSize(where, custom.maxBytes, undefined, `At most ${decimalBytes(custom.maxBytes)}`));

  const m = file.media;
  const expectedRatio = custom.width / custom.height;
  const typed = `${custom.width} × ${custom.height} ${custom.unit}`;

  if (!m || !m.width || !m.height) {
    findings.push(
      finding(where, "platform.dimensions", "Dimensions", "major", "unverified", {
        expected: typed,
        detected: "Not measured",
        explanation: m?.note ?? "The size of this file couldn't be measured.",
      })
    );
    return findings;
  }

  const actualRatio = m.width / m.height;
  const ratioOk = Math.abs(actualRatio / expectedRatio - 1) <= RATIO_MATCH_TOLERANCE;

  if (custom.unit === "px") {
    if (m.unit === "px") {
      const ok = m.width === custom.width && m.height === custom.height;
      findings.push(
        finding(where, "platform.custom_size", "Required size", "major", ok ? "passed" : "failed", {
          expected: `${custom.width} × ${custom.height}`,
          detected: detectedSize(m),
          explanation: ok ? "Exactly the size you set." : `${label} needs exactly ${custom.width} × ${custom.height} pixels.`,
          suggestedFix: `Resize or export the creative at ${custom.width} × ${custom.height}.`,
        })
      );
    } else {
      findings.push(
        finding(where, "platform.ratio", "Aspect ratio", "major", ratioOk ? "passed" : "failed", {
          expected: `${ratioLabel(expectedRatio)} (from ${custom.width} × ${custom.height})`,
          detected: `${ratioLabel(actualRatio)} (page ${detectedSize(m)})`,
          explanation: ratioOk ? "The page has the right shape." : "The PDF page has a different shape from the size you set.",
          suggestedFix: `Set the page to the ${ratioLabel(expectedRatio)} shape and export again.`,
        }),
        finding(where, "platform.custom_size", "Required size", "major", "unverified", {
          expected: `${custom.width} × ${custom.height} px`,
          detected: `Page ${detectedSize(m)}`,
          explanation: "A PDF's page size is in points; its pixel size depends on how it's exported, so the exact pixel size can't be checked.",
        })
      );
    }
    return findings;
  }

  // Physical size in millimetres (print).
  if (m.unit === "pt") {
    const wMm = (m.width * 25.4) / 72;
    const hMm = (m.height * 25.4) / 72;
    const ok = Math.abs(wMm - custom.width) <= PRINT_SIZE_TOLERANCE_MM && Math.abs(hMm - custom.height) <= PRINT_SIZE_TOLERANCE_MM;
    findings.push(
      finding(where, "platform.print_size", "Print size", "major", ok ? "passed" : "failed", {
        expected: `${custom.width} × ${custom.height} mm (±${PRINT_SIZE_TOLERANCE_MM} mm)`,
        detected: `${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm`,
        explanation: ok ? "The page is the size you set." : "The PDF page isn't the size you set for print.",
        suggestedFix: `Set the document size to ${custom.width} × ${custom.height} mm (plus any bleed the printer asks for) and export again.`,
      })
    );
    if (custom.minDpi) {
      findings.push(
        finding(where, "platform.print_resolution", "Print resolution", "major", "unverified", {
          expected: `At least ${custom.minDpi} DPI`,
          detected: "Not measured",
          explanation: "The resolution of images inside a PDF can't be read without opening its contents, which isn't done in this phase.",
        })
      );
    }
    return findings;
  }

  findings.push(
    finding(where, "platform.ratio", "Aspect ratio", "major", ratioOk ? "passed" : "failed", {
      expected: `${ratioLabel(expectedRatio)} (from ${custom.width} × ${custom.height} mm)`,
      detected: `${ratioLabel(actualRatio)} (${detectedSize(m)})`,
      explanation: ratioOk ? "The image has the right shape for the print size." : "The image has a different shape from the print size, so it would be cropped or distorted.",
      suggestedFix: `Crop or re-export the artwork to the ${ratioLabel(expectedRatio)} shape.`,
    })
  );
  if (custom.minDpi) {
    const effective = Math.floor(Math.min(m.width / (custom.width / 25.4), m.height / (custom.height / 25.4)));
    const ok = effective >= custom.minDpi;
    findings.push(
      finding(where, "platform.print_resolution", "Print resolution", "major", ok ? "passed" : "failed", {
        expected: `At least ${custom.minDpi} DPI at ${custom.width} × ${custom.height} mm`,
        detected: `${effective} DPI (${detectedSize(m)} printed at that size${m.dpi ? `; file says ${m.dpi} DPI` : ""})`,
        explanation: ok
          ? "Enough pixels for this print size."
          : "Printed at this size, the image has fewer dots per inch than required and may look soft or pixelated.",
        suggestedFix: `Export at least ${Math.ceil((custom.width / 25.4) * custom.minDpi)} × ${Math.ceil((custom.height / 25.4) * custom.minDpi)} pixels from the original artwork.`,
      })
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

function choiceFinding(id: string, title: string, explanation: string): Finding {
  return { ruleId: id, category: CATEGORY, title, severity: "major", status: "unverified", kind: "fact", explanation, confidence: 0 };
}

export const platformSizeRule: Rule<PlatformContext> = {
  id: "platform.size",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["platform choice (D4)", "measured content"],
  defaultSeverity: "major",
  mandatory: true,
  run(context) {
    const platform = findPlatform(context.platform);
    if (!platform) {
      // The platform is optional: without one, its checks are simply not run (never a failure).
      return [choiceFinding("platform.choice", "Platform", "No platform was chosen (it's optional), so the platform-specific checks — its size, ratio, format and file size — weren't run.")];
    }
    if (platform.custom) {
      if (!context.custom) {
        return [choiceFinding("platform.choice", "Required size", "No required size has been set for this platform.")];
      }
      return context.files.flatMap((file) => checkCustom(file, context.custom!, platform));
    }
    const spec = findPlacement(platform, context.placement);
    if (!spec) return [choiceFinding("platform.choice", "Placement", "No placement has been chosen.")];
    if (spec.notConfigured) {
      return [{ ...choiceFinding("platform.not_configured", "Platform requirements", spec.notConfigured), source: spec.source }];
    }
    return context.files.flatMap((file) => checkPublished(file, spec, platform, context.elements));
  },
};

/** The platform / size rules registered with the engine this round. */
export const PLATFORM_RULES: readonly Rule<PlatformContext>[] = [platformSizeRule];

/** Platform limits are published in decimal units (1 MB = 1,000,000 bytes). */
export function decimalBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${+(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${+(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${+(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}
