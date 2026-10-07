import type { Checked } from "@/lib/auth/user-input";

/**
 * Checks for everything typed on the company page. Each returns the value
 * to save (or null for "cleared") or a message to show. Nothing here
 * invents or adds information — values are only tidied (trimmed) and, for
 * websites and colours, written in one standard form.
 */

export type { Checked };

// Control characters other than tab and newline are never accepted.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function checkText(
  raw: string,
  options: { max: number; required?: boolean; multiline?: boolean; label?: string }
): Checked<string | null> {
  let value = raw.replace(/\r\n?/g, "\n");
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, error: "Remove the hidden control characters." };
  }
  value = options.multiline
    ? value.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : value.replace(/\s+/g, " ").trim();

  if (!value) {
    return options.required
      ? { ok: false, error: `Enter ${options.label ?? "a value"}.` }
      : { ok: true, value: null };
  }
  if ([...value].length > options.max) {
    return { ok: false, error: `Use at most ${options.max} characters.` };
  }
  return { ok: true, value };
}

export const COMPANY_NAME_MAX_LENGTH = 120;

export function checkCompanyName(raw: string): Checked<string> {
  const result = checkText(raw, {
    max: COMPANY_NAME_MAX_LENGTH,
    required: true,
    label: "the company name",
  });
  if (!result.ok) return result;
  if (!/[\p{L}\p{N}]/u.test(result.value!)) {
    return { ok: false, error: "The company name needs at least one letter or number." };
  }
  return { ok: true, value: result.value! };
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

const PHONE_CHARS = /^\+?[0-9 ().-]+$/;

function digitCount(value: string) {
  return value.replace(/\D/g, "").length;
}

/**
 * A phone number in any normal national or international layout, e.g.
 * "+971 4 123 4567", "(04) 123-4567". Saved exactly as typed (trimmed) —
 * never rewritten.
 */
export function checkPhone(raw: string): Checked<string | null> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: true, value: null };
  if (!PHONE_CHARS.test(value)) {
    return { ok: false, error: "Use only digits, spaces, + at the start, and - ( ) ." };
  }
  const digits = digitCount(value);
  if (digits < 7 || digits > 15) {
    return { ok: false, error: "A phone number has between 7 and 15 digits." };
  }
  if (value.length > 40) return { ok: false, error: "Use at most 40 characters." };
  return { ok: true, value };
}

/** WhatsApp needs the international form: + and the country code. Saved as typed. */
export function checkWhatsApp(raw: string): Checked<string | null> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: true, value: null };
  if (!value.startsWith("+") || !PHONE_CHARS.test(value)) {
    return {
      ok: false,
      error: "Start with + and the country code, e.g. +971 50 123 4567.",
    };
  }
  const digits = digitCount(value);
  if (digits < 8 || digits > 15 || value.replace(/[^0-9]/g, "").startsWith("0")) {
    return {
      ok: false,
      error: "Use + and the country code, then the number (8 to 15 digits in total).",
    };
  }
  if (value.length > 40) return { ok: false, error: "Use at most 40 characters." };
  return { ok: true, value };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkContactEmail(raw: string): Checked<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) {
    return { ok: false, error: "Enter a valid email address, like hello@company.com." };
  }
  return { ok: true, value };
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * A website address. "company.com" is saved as "https://company.com".
 * Only http and https are accepted. Nothing is fetched — this only checks
 * the address is well formed.
 */
export function checkWebsite(raw: string): Checked<string | null> {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const invalid = {
    ok: false as const,
    error: "Enter a website address, like company.com or https://www.company.com.",
  };
  if (/\s/.test(text) || text.length > 2048) return invalid;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  if (hasScheme && !/^https?:\/\//i.test(text)) return invalid;

  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return invalid;
  }
  if (url.username || url.password || !HOSTNAME.test(url.hostname)) return invalid;

  const href = url.pathname === "/" && !url.search && !url.hash ? url.origin : url.href;
  if (href.length > 2048) return invalid;
  return { ok: true, value: href };
}

// ---------------------------------------------------------------------------
// Brand colours
// ---------------------------------------------------------------------------

/** "#1a64b4", "1A64B4" or "#16b" → "#1A64B4". */
export function checkHex(raw: string): Checked<string> {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!match) {
    return { ok: false, error: "Enter a HEX colour, like #1A64B4." };
  }
  const digits =
    match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
  return { ok: true, value: `#${digits.toUpperCase()}` };
}

/** Optional CMYK: four numbers from 0 to 100, e.g. "85, 45, 0, 29". */
export function checkCmyk(raw: string): Checked<string | null> {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const parts = text.replace(/%/g, "").split(/[\s,/]+/).filter(Boolean);
  const numbers = parts.map(Number);
  if (
    parts.length !== 4 ||
    numbers.some((n, i) => !/^\d{1,3}$/.test(parts[i]) || n > 100)
  ) {
    return { ok: false, error: "Enter four numbers from 0 to 100, like 85, 45, 0, 29." };
  }
  return { ok: true, value: numbers.join(", ") };
}

/** "#1A64B4" → "26, 100, 180" (shown next to a colour; not stored). */
export function hexToRgb(hex: string): string {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)).join(", ");
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export function checkChoice<T extends string>(
  raw: string,
  choices: readonly { value: T }[],
  label: string
): Checked<T> {
  const found = choices.find((choice) => choice.value === raw);
  return found ? { ok: true, value: found.value } : { ok: false, error: `Choose ${label}.` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
