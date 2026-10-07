import type { PlatformChoice } from "@/lib/db/qc-sessions";
import { contentMedia, type ContentType } from "@/lib/qc/content-types";
import { findPlacement, findPlatform, placementsFor } from "@/lib/qc/platforms";

/**
 * Checks the platform / placement the designer picked (Phase 5, D4). Only
 * keys from lib/qc/platforms.ts are accepted, and only ones that fit the
 * content type's media. For platforms with no official spec the designer
 * types the required size; "Other" also needs a short description.
 */

export const PLATFORM_FIELD_LIMITS = {
  label: 120,
  sizeMax: 100_000,
  dpiMax: 2400,
  maxBytes: 52_428_800,
} as const;

export const PLATFORM_MESSAGES = {
  platform: "Choose a platform.",
  platformMedia: "That platform isn't available for this content type.",
  placement: "Choose a placement.",
  label: `Describe where the content will be used (up to ${PLATFORM_FIELD_LIMITS.label} characters).`,
  size: "Enter the required width and height as whole numbers.",
  unit: "Choose a unit for the size.",
  dpi: `Minimum DPI must be a whole number from 1 to ${PLATFORM_FIELD_LIMITS.dpiMax}.`,
  maxBytes: "Maximum file size must be a number of MB from 0.001 to 50.",
} as const;

export type PlatformForm = {
  platform?: string | null;
  placement?: string | null;
  label?: string | null;
  width?: string | null;
  height?: string | null;
  unit?: string | null;
  minDpi?: string | null;
  maxMb?: string | null;
};

const text = (v: string | null | undefined) => (v ?? "").trim();

function wholeNumber(v: string | null | undefined, max: number): number | null | "bad" {
  const t = text(v);
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "bad";
  const n = Number(t);
  return n >= 1 && n <= max ? n : "bad";
}

export function parsePlatformChoice(
  form: PlatformForm,
  contentType: ContentType
): { ok: true; value: PlatformChoice } | { ok: false; error: string } {
  const platform = findPlatform(text(form.platform));
  if (!platform) return { ok: false, error: PLATFORM_MESSAGES.platform };
  const media = contentMedia(contentType);
  if (!platform.media.includes(media)) return { ok: false, error: PLATFORM_MESSAGES.platformMedia };

  if (platform.placements) {
    const placement = findPlacement(platform, text(form.placement));
    if (!placement || !placementsFor(platform, media).includes(placement)) {
      return { ok: false, error: PLATFORM_MESSAGES.placement };
    }
    return {
      ok: true,
      value: {
        platform: platform.key,
        placement: placement.key,
        customLabel: null,
        customWidth: null,
        customHeight: null,
        customUnit: null,
        customMinDpi: null,
        customMaxBytes: null,
      },
    };
  }

  const custom = platform.custom!;
  const label = text(form.label).replace(/\s+/g, " ");
  if (custom.needsLabel && (!label || label.length > PLATFORM_FIELD_LIMITS.label)) {
    return { ok: false, error: PLATFORM_MESSAGES.label };
  }
  if (label.length > PLATFORM_FIELD_LIMITS.label) return { ok: false, error: PLATFORM_MESSAGES.label };

  const width = wholeNumber(form.width, PLATFORM_FIELD_LIMITS.sizeMax);
  const height = wholeNumber(form.height, PLATFORM_FIELD_LIMITS.sizeMax);
  if (typeof width !== "number" || typeof height !== "number") return { ok: false, error: PLATFORM_MESSAGES.size };

  const unitText = text(form.unit) || (custom.units.length === 1 ? custom.units[0] : "");
  const unit = custom.units.find((u) => u === unitText);
  if (!unit) return { ok: false, error: PLATFORM_MESSAGES.unit };

  let minDpi: number | null = null;
  if (custom.dpi) {
    const dpi = wholeNumber(form.minDpi, PLATFORM_FIELD_LIMITS.dpiMax);
    if (dpi === "bad") return { ok: false, error: PLATFORM_MESSAGES.dpi };
    // DPI only means something for a physical (mm) size.
    minDpi = unit === "mm" ? dpi : null;
  }

  let maxBytes: number | null = null;
  const mb = text(form.maxMb);
  if (mb) {
    if (!/^\d+(\.\d+)?$/.test(mb)) return { ok: false, error: PLATFORM_MESSAGES.maxBytes };
    maxBytes = Math.round(Number(mb) * 1_000_000);
    if (maxBytes < 1_000 || maxBytes > 50_000_000) return { ok: false, error: PLATFORM_MESSAGES.maxBytes };
  }

  return {
    ok: true,
    value: {
      platform: platform.key,
      placement: null,
      customLabel: label || null,
      customWidth: width,
      customHeight: height,
      customUnit: unit,
      customMinDpi: minDpi,
      customMaxBytes: maxBytes,
    },
  };
}
