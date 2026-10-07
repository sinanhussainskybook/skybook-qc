import type { Checked } from "@/lib/company/validation";

/**
 * Checks for an uploaded logo (D3). Used on the server for every upload;
 * the browser runs the cheap parts (size, extension) only to give quick
 * feedback.
 *
 * The file's type is worked out from its contents. The file name's
 * extension and the type the browser declared must both agree with it.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export const LOGO_KINDS = {
  png: { mime: "image/png", ext: "png", extensions: ["png"], label: "PNG" },
  jpeg: { mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], label: "JPG" },
  webp: { mime: "image/webp", ext: "webp", extensions: ["webp"], label: "WEBP" },
  svg: { mime: "image/svg+xml", ext: "svg", extensions: ["svg"], label: "SVG" },
} as const;

export type LogoKind = keyof typeof LOGO_KINDS;

export const LOGO_ACCEPT = ".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml";

export const LOGO_MESSAGES = {
  missing: "Choose a logo file to upload.",
  empty: "That file is empty.",
  tooLarge: "That file is too large. Logos can be up to 2 MB.",
  wrongType: "Use a PNG, JPG, WEBP or SVG logo.",
  mismatch: "The file's name or type doesn't match what's inside it. Save it again as PNG, JPG, WEBP or SVG and retry.",
  unsafeSvg:
    "This SVG contains scripts, links or embedded content that aren't allowed in a logo. Export a plain SVG (or a PNG) and try again.",
} as const;

export type CheckedLogo = {
  kind: LogoKind;
  mime: string;
  ext: string;
  fileName: string;
  size: number;
  bytes: Uint8Array;
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function kindLabel(mime: string): string {
  return Object.values(LOGO_KINDS).find((kind) => kind.mime === mime)?.label ?? mime;
}

/** The name shown to people: no folders, no control characters, at most 255 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return [...(cleaned || "logo")].slice(-255).join("");
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** Recognise PNG, JPEG and WEBP by their first bytes, and SVG by its text. */
export function detectLogoKind(bytes: Uint8Array): LogoKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // RIFF
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8) // WEBP
  ) {
    return "webp";
  }
  const text = decodeUtf8(bytes);
  if (text !== null && isSvgDocument(text)) return "svg";
  return null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Text whose first element is <svg>, after an optional XML declaration,
 * comments and DOCTYPE. (Whether that DOCTYPE is safe is checked separately.)
 */
function isSvgDocument(text: string): boolean {
  const comments = /^(\s*<!--[\s\S]*?-->)*/;
  const withoutPreamble = text
    .replace(/^﻿/, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(comments, "")
    .replace(/^\s*<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, "")
    .replace(comments, "")
    .trimStart();
  return /^<svg[\s>]/i.test(withoutPreamble);
}

/**
 * Things a logo SVG never needs, and which could run code, load outside
 * resources or hide HTML. An SVG containing any of them is rejected — this
 * is a strict check, not a sanitiser (none is available in the project).
 */
const IN_FILE = "#|data:image\\/(?:png|jpe?g|gif|webp);base64,";

const UNSAFE_SVG: RegExp[] = [
  /<!DOCTYPE[^>]*\[/i, // a DOCTYPE with its own definitions (entity tricks); a plain public one is fine
  /<!ENTITY/i,
  /<\?xml-stylesheet/i,
  /<\s*([a-z0-9_-]+:)?(script|foreignObject|iframe|frame|embed|object|applet|audio|video|handler|listener|meta|link|base|form|input|button)\b/i,
  /\son[a-z]+\s*=/i, // event handlers: onload=, onclick= …
  /(javascript|vbscript|livescript)\s*:/i,
  /&#/, // character references can hide the patterns above
  /@import/i,
  /data\s*:(?!\s*image\/(png|jpe?g|gif|webp);base64,)/i, // only embedded raster images
  // Links and url(...) may only point inside the file (#id) or at an embedded image.
  // Each quote style is spelled out so an optional quote can't be skipped over.
  new RegExp(`\\bhref\\s*=\\s*(?:"\\s*(?!${IN_FILE})|'\\s*(?!${IN_FILE})|(?!["'\\s]|${IN_FILE}))`, "i"),
  new RegExp(`url\\(\\s*(?:"\\s*(?!${IN_FILE})|'\\s*(?!${IN_FILE})|(?!["'\\s]|${IN_FILE}))`, "i"),
  // Animations that would set an event handler or a link.
  /attributeName\s*=\s*["']?\s*(on[a-z]|(xlink:)?href)/i,
];

export function isSafeSvg(text: string): boolean {
  return !UNSAFE_SVG.some((pattern) => pattern.test(text));
}

/** Everything the server checks about an uploaded logo. */
export function checkLogoFile(file: {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}): Checked<CheckedLogo> {
  if (file.size === 0 || file.bytes.length === 0) return { ok: false, error: LOGO_MESSAGES.empty };
  if (file.size > LOGO_MAX_BYTES || file.bytes.length > LOGO_MAX_BYTES) {
    return { ok: false, error: LOGO_MESSAGES.tooLarge };
  }

  const kind = detectLogoKind(file.bytes);
  if (!kind) return { ok: false, error: LOGO_MESSAGES.wrongType };
  const spec = LOGO_KINDS[kind];

  const extension = extensionOf(file.name);
  const allExtensions = Object.values(LOGO_KINDS).flatMap((k) => k.extensions as readonly string[]);
  if (!allExtensions.includes(extension)) return { ok: false, error: LOGO_MESSAGES.wrongType };
  if (!(spec.extensions as readonly string[]).includes(extension)) {
    return { ok: false, error: LOGO_MESSAGES.mismatch };
  }

  // Browsers send the type they think the file is. It must agree too
  // (an empty type — some browsers send none — is allowed).
  const declared = file.type.split(";")[0].trim().toLowerCase();
  if (declared && declared !== spec.mime) return { ok: false, error: LOGO_MESSAGES.mismatch };

  if (kind === "svg" && !isSafeSvg(decodeUtf8(file.bytes) ?? "")) {
    return { ok: false, error: LOGO_MESSAGES.unsafeSvg };
  }

  return {
    ok: true,
    value: {
      kind,
      mime: spec.mime,
      ext: spec.ext,
      fileName: cleanFileName(file.name),
      size: file.bytes.length,
      bytes: file.bytes,
    },
  };
}

/** The quick checks the browser can do before sending (size, extension). */
export function precheckLogoFile(file: { name: string; size: number }): string | null {
  if (file.size === 0) return LOGO_MESSAGES.empty;
  if (file.size > LOGO_MAX_BYTES) return LOGO_MESSAGES.tooLarge;
  const extension = extensionOf(file.name);
  const allExtensions = Object.values(LOGO_KINDS).flatMap((k) => k.extensions as readonly string[]);
  return allExtensions.includes(extension) ? null : LOGO_MESSAGES.wrongType;
}
