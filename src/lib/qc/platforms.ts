import type { FileFormat } from "@/lib/qc/qc-file";
import type { ContentMedia } from "@/lib/qc/content-types";

/**
 * Platform / placement specifications — decision D4, approved 2026-10-01.
 *
 * Every value below was taken from the platform's OWN published page
 * (see `source` on each placement) and approved by the user before being
 * coded. Nothing is guessed: where a platform publishes no value, the field
 * is left out and the matching check reports NOT VERIFIED or doesn't run.
 *
 * This file is the single source of platform values. To change a value,
 * change it here (and its source note).
 *
 * Units: sizes in pixels; ratios as width ÷ height; file sizes in bytes,
 * using the stricter decimal reading (1 MB = 1,000,000 bytes, 1 KB = 1,000);
 * durations in seconds.
 */

export type Size = { w: number; h: number };
export type Source = { label: string; url: string };

export type RatioRule = {
  /** The ratio the platform asks for / recommends. */
  recommended: Size;
  /** A wider allowed range (width ÷ height), when the platform publishes one. */
  allowed?: { min: number; max: number };
  /**
   * The published tolerance (0.01 = 1 %). Present → a ratio outside it is a
   * hard break (MAJOR). Absent → the platform publishes no tolerance, so a
   * different ratio is only a SUGGESTION.
   */
  tolerance?: number;
};

export type RatioVariant = { label: string; ratio: Size; min: Size; max?: Size; recommended?: Size };

export type PlacementSpec = {
  key: string;
  label: string;
  media: ContentMedia; // "visual" (images / PDF) or "video"
  /** Platform spec isn't published / not configured: every check is NOT VERIFIED. */
  notConfigured?: string;
  formats?: readonly FileFormat[];
  ratio?: RatioRule;
  /** Several allowed ratios, each with its own size range (LinkedIn video). */
  ratioVariants?: readonly RatioVariant[];
  recommended?: Size;
  min?: Partial<Size>;
  max?: Size;
  /** Minimum width that applies from this length on (Instagram Reels: 500 px from 30 s). */
  minWidthFromSeconds?: { seconds: number; width: number };
  /** The image must be exactly one of these sizes (display ads). */
  exactSizes?: readonly (Size & { name: string })[];
  maxBytes?: number;
  minBytes?: number;
  bytesLabel?: string;
  durationSec?: { min?: number; max?: number };
  /** Square or vertical (width ≤ height) — YouTube Shorts. */
  squareOrVertical?: boolean;
  /** Published resolutions are recommendations only (YouTube): outside them is a SUGGESTION. */
  resolutionGuide?: { min: Size; max: Size };
  /** % of each edge to keep free of text, logos and key elements. */
  safeZone?: { top: number; bottom: number; left?: number; right?: number };
  source: Source;
};

export type CustomSpecKind = {
  /** px: exact pixel size; mm: physical size (print), optional minimum DPI. */
  units: readonly ("px" | "mm")[];
  dpi?: boolean;
  needsLabel?: boolean;
};

export type Platform = {
  key: string;
  label: string;
  /** Spec platforms have placements; custom ones use the size the designer types. */
  placements?: readonly PlacementSpec[];
  custom?: CustomSpecKind;
  media: readonly ContentMedia[];
};

const MB = 1_000_000;
const GB = 1_000_000_000;

const META_ADS = (path: string, label: string): Source => ({
  label: `Meta Ads Guide — ${label}`,
  url: `https://www.facebook.com/business/ads-guide/update/${path}`,
});
const META_STORY_SAFE = { top: 14, bottom: 35, left: 6, right: 6 };

export const PLATFORMS: readonly Platform[] = [
  {
    key: "instagram",
    label: "Instagram",
    media: ["visual", "video"],
    placements: [
      {
        key: "feed_image", label: "Feed image", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 4, h: 5 }, allowed: { min: 400 / 500, max: 191 / 100 }, tolerance: 0.01 },
        recommended: { w: 1440, h: 1800 }, min: { w: 500 }, maxBytes: 30 * MB, bytesLabel: "30 MB",
        source: META_ADS("image/instagram-feed", "Instagram Feed image"),
      },
      {
        key: "stories_image", label: "Stories image", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 9, h: 16 }, tolerance: 0.01 },
        recommended: { w: 1440, h: 2560 }, min: { w: 500 }, maxBytes: 30 * MB, bytesLabel: "30 MB",
        safeZone: META_STORY_SAFE,
        source: META_ADS("image/instagram-story", "Instagram Stories image"),
      },
      {
        key: "feed_video", label: "Feed video", media: "video", formats: ["mp4", "mov"],
        ratio: { recommended: { w: 9, h: 16 }, tolerance: 0.01 },
        recommended: { w: 1080, h: 1920 }, min: { w: 250 }, maxBytes: 4 * GB, bytesLabel: "4 GB",
        durationSec: { min: 1, max: 60 * 60 },
        source: META_ADS("video/instagram-feed", "Instagram Feed video"),
      },
      {
        key: "stories_video", label: "Stories video", media: "video", formats: ["mp4", "mov"],
        ratio: { recommended: { w: 9, h: 16 }, tolerance: 0.01 },
        recommended: { w: 1440, h: 2560 }, min: { w: 250 }, maxBytes: 4 * GB, bytesLabel: "4 GB",
        durationSec: { min: 1, max: 60 * 60 }, safeZone: META_STORY_SAFE,
        source: META_ADS("video/instagram-story", "Instagram Stories video"),
      },
      {
        key: "reels", label: "Reels", media: "video", formats: ["mp4", "mov"],
        ratio: { recommended: { w: 9, h: 16 } }, // no tolerance published
        recommended: { w: 1440, h: 2560 }, min: { w: 250 }, minWidthFromSeconds: { seconds: 30, width: 500 },
        maxBytes: 4 * GB, bytesLabel: "4 GB", durationSec: { min: 0, max: 15 * 60 }, safeZone: META_STORY_SAFE,
        source: META_ADS("video/instagram-reels", "Instagram Reels"),
      },
    ],
  },
  {
    key: "facebook",
    label: "Facebook",
    media: ["visual", "video"],
    placements: [
      {
        key: "feed_image", label: "Feed image", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 4, h: 5 }, tolerance: 0.03 },
        recommended: { w: 1440, h: 1800 }, min: { w: 600, h: 750 }, maxBytes: 30 * MB, bytesLabel: "30 MB",
        source: META_ADS("image", "Facebook Feed image"),
      },
      {
        key: "stories_image", label: "Stories image", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 9, h: 16 }, tolerance: 0.01 },
        recommended: { w: 1440, h: 2560 }, min: { w: 500 }, maxBytes: 30 * MB, bytesLabel: "30 MB",
        safeZone: META_STORY_SAFE,
        source: META_ADS("image/facebook-story", "Facebook Stories image"),
      },
      {
        key: "feed_video", label: "Feed video", media: "video", formats: ["mp4", "mov"],
        ratio: { recommended: { w: 4, h: 5 } }, // no tolerance published
        recommended: { w: 1440, h: 1800 }, min: { w: 120, h: 120 }, maxBytes: 4 * GB, bytesLabel: "4 GB",
        durationSec: { min: 1, max: 241 * 60 },
        source: META_ADS("video", "Facebook Feed video"),
      },
      {
        key: "stories_video", label: "Stories video", media: "video", formats: ["mp4", "mov"],
        ratio: { recommended: { w: 9, h: 16 }, tolerance: 0.01 },
        recommended: { w: 1440, h: 2560 }, min: { w: 250 }, maxBytes: 4 * GB, bytesLabel: "4 GB",
        durationSec: { min: 1, max: 3 * 60 }, safeZone: { top: 14, bottom: 20 },
        source: META_ADS("video/facebook-story", "Facebook Stories video"),
      },
      {
        key: "reels", label: "Reels", media: "video",
        notConfigured: "Meta's Facebook Reels specification page wasn't available when the values were set (D4), so no Reels values are configured.",
        source: META_ADS("video", "Facebook Reels — not configured"),
      },
    ],
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    media: ["visual", "video"],
    placements: [
      {
        key: "image_landscape", label: "Image — landscape", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 191, h: 100 } }, recommended: { w: 1200, h: 628 },
        min: { w: 640, h: 360 }, max: { w: 7680, h: 4320 }, maxBytes: 5 * MB, bytesLabel: "5 MB",
        source: { label: "LinkedIn Help — Single Image Ads specs", url: "https://www.linkedin.com/help/lms/answer/a426534" },
      },
      {
        key: "image_square", label: "Image — square", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 1, h: 1 } }, recommended: { w: 1200, h: 1200 },
        min: { w: 360, h: 360 }, max: { w: 4320, h: 4320 }, maxBytes: 5 * MB, bytesLabel: "5 MB",
        source: { label: "LinkedIn Help — Single Image Ads specs", url: "https://www.linkedin.com/help/lms/answer/a426534" },
      },
      {
        key: "image_vertical", label: "Image — vertical", media: "visual", formats: ["jpeg", "png"],
        ratio: { recommended: { w: 4, h: 5 } }, recommended: { w: 720, h: 900 },
        min: { w: 360, h: 640 }, max: { w: 2430, h: 4320 }, maxBytes: 5 * MB, bytesLabel: "5 MB",
        source: { label: "LinkedIn Help — Single Image Ads specs", url: "https://www.linkedin.com/help/lms/answer/a426534" },
      },
      {
        key: "video", label: "Video", media: "video", formats: ["mp4"],
        ratioVariants: [
          { label: "Horizontal 16:9", ratio: { w: 16, h: 9 }, min: { w: 640, h: 360 }, recommended: { w: 1920, h: 1080 } },
          { label: "Square 1:1", ratio: { w: 1, h: 1 }, min: { w: 360, h: 360 }, max: { w: 1920, h: 1920 } },
          { label: "Vertical 4:5", ratio: { w: 4, h: 5 }, min: { w: 360, h: 450 }, max: { w: 1080, h: 1350 }, recommended: { w: 720, h: 900 } },
          { label: "Vertical 9:16", ratio: { w: 9, h: 16 }, min: { w: 360, h: 640 }, max: { w: 1080, h: 1920 }, recommended: { w: 720, h: 1280 } },
        ],
        minBytes: 75_000, maxBytes: 500 * MB, bytesLabel: "75 KB – 500 MB", durationSec: { min: 3, max: 30 * 60 },
        source: { label: "LinkedIn Help — Video Ads specs", url: "https://www.linkedin.com/help/lms/answer/a424737" },
      },
    ],
  },
  {
    key: "youtube",
    label: "YouTube",
    media: ["video"],
    placements: [
      {
        key: "video", label: "Video", media: "video",
        ratio: { recommended: { w: 16, h: 9 } }, // the standard; other ratios get padding
        resolutionGuide: { min: { w: 426, h: 240 }, max: { w: 7680, h: 4320 } },
        source: { label: "YouTube Help — aspect ratio & resolutions", url: "https://support.google.com/youtube/answer/6375112" },
      },
      {
        key: "shorts", label: "Shorts", media: "video",
        squareOrVertical: true, durationSec: { max: 3 * 60 },
        source: { label: "YouTube Help — Shorts length & aspect ratio", url: "https://support.google.com/youtube/answer/15424877" },
      },
    ],
  },
  {
    key: "display_ad",
    label: "Display ad",
    media: ["visual"],
    placements: [
      {
        key: "google_uploaded_image", label: "Google Ads uploaded image ad", media: "visual", formats: ["jpeg", "png"],
        maxBytes: 150_000, bytesLabel: "150 KB",
        exactSizes: [
          { w: 200, h: 200, name: "Small square" }, { w: 240, h: 400, name: "Vertical rectangle" },
          { w: 250, h: 250, name: "Square" }, { w: 250, h: 360, name: "Triple widescreen" },
          { w: 300, h: 250, name: "Inline rectangle" }, { w: 336, h: 280, name: "Large rectangle" },
          { w: 580, h: 400, name: "Netboard" }, { w: 120, h: 600, name: "Skyscraper" },
          { w: 160, h: 600, name: "Wide skyscraper" }, { w: 300, h: 600, name: "Half-page ad" },
          { w: 300, h: 1050, name: "Portrait" }, { w: 468, h: 60, name: "Banner" },
          { w: 728, h: 90, name: "Leaderboard" }, { w: 930, h: 180, name: "Top banner" },
          { w: 970, h: 90, name: "Large leaderboard" }, { w: 970, h: 250, name: "Billboard" },
          { w: 980, h: 120, name: "Panorama" }, { w: 300, h: 50, name: "Mobile banner" },
          { w: 320, h: 50, name: "Mobile banner" }, { w: 320, h: 100, name: "Large mobile banner" },
        ],
        source: { label: "Google Ads Help — uploaded image ads", url: "https://support.google.com/google-ads/answer/1722096" },
      },
    ],
  },
  // No official specification exists for these: the designer types the required size.
  { key: "website_banner", label: "Website banner", media: ["visual"], custom: { units: ["px"] } },
  { key: "email_banner", label: "Email banner", media: ["visual"], custom: { units: ["px"] } },
  { key: "print", label: "Print", media: ["visual"], custom: { units: ["mm"], dpi: true } },
  { key: "presentation_slide", label: "Presentation slide", media: ["visual"], custom: { units: ["px"] } },
  { key: "other", label: "Other", media: ["visual", "video"], custom: { units: ["px", "mm"], dpi: true, needsLabel: true } },
];

/**
 * Where the platform publishes no tolerance but a size must still be matched
 * to a ratio (LinkedIn video's list of ratios, a typed custom size), ratios
 * within this fraction count as the same. An app setting, not a platform value.
 */
export const RATIO_MATCH_TOLERANCE = 0.01;

/** A typed physical size (print) counts as met within this many millimetres. */
export const PRINT_SIZE_TOLERANCE_MM = 1;

export function findPlatform(key: string | null | undefined): Platform | null {
  return PLATFORMS.find((p) => p.key === key) ?? null;
}

export function findPlacement(platform: Platform | null, key: string | null | undefined): PlacementSpec | null {
  return platform?.placements?.find((p) => p.key === key) ?? null;
}

/** Platforms that fit the content type's media (images/PDF vs video). */
export function platformsFor(media: ContentMedia): Platform[] {
  return PLATFORMS.filter((p) => p.media.includes(media));
}

export function placementsFor(platform: Platform, media: ContentMedia): PlacementSpec[] {
  return (platform.placements ?? []).filter((p) => p.media === media);
}
