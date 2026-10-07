/**
 * What the designer is checking. All four share ONE session / requirements
 * model and one QC workflow — the content type only decides which content
 * files are accepted (and, from Phase 5, which extra checks apply). Only the
 * static design types are offered for now (OFFERED_CONTENT_TYPES).
 */

export const CONTENT_TYPES = [
  { value: "design_poster", label: "Design / Poster", media: "visual" },
  { value: "social_post", label: "Social Media Post", media: "visual" },
  { value: "reel_short", label: "Reel / Short", media: "video" },
  { value: "youtube_video", label: "YouTube Video", media: "video" },
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number]["value"];
export type ContentMedia = (typeof CONTENT_TYPES)[number]["media"];

export function isContentType(value: unknown): value is ContentType {
  return CONTENT_TYPES.some((type) => type.value === value);
}

/**
 * What Start QC offers now: static designs only (JPG / PNG / WEBP / PDF).
 * Reel / Short and YouTube Video stay defined — their rules, video analysis
 * and platform specs are kept for future use — but can't be chosen for a
 * new or changed session. Add a type back here to offer it again.
 */
export const OFFERED_CONTENT_TYPES = CONTENT_TYPES.filter((type) => type.media === "visual");

export function isOfferedContentType(value: unknown): value is ContentType {
  return OFFERED_CONTENT_TYPES.some((type) => type.value === value);
}

export function contentTypeLabel(value: string): string {
  return CONTENT_TYPES.find((type) => type.value === value)?.label ?? value;
}

export function contentMedia(value: ContentType): ContentMedia {
  return CONTENT_TYPES.find((type) => type.value === value)!.media;
}
