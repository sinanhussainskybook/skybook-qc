import { isRole, ROLES, type Role } from "@/lib/auth/roles";

/**
 * Checks for the details typed when a user is created (npm run user:create).
 * Each returns either the cleaned value or a message to show.
 */

export const NAME_MAX_LENGTH = 100;
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Emails are stored trimmed and lower-case, so sign-in is not case-sensitive. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function checkName(raw: string): Checked<string> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, error: "Enter the person's name." };
  if (value.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `Use at most ${NAME_MAX_LENGTH} characters.` };
  }
  return { ok: true, value };
}

// Deliberately simple: something@something.something, no spaces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmail(raw: string): Checked<string> {
  const value = normalizeEmail(raw);
  if (!value) return { ok: false, error: "Enter an email address." };
  if (value.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(value)) {
    return { ok: false, error: "Enter a valid email address, like name@skybook.com." };
  }
  return { ok: true, value };
}

export function checkRole(raw: string): Checked<Role> {
  const value = raw.trim().toLowerCase();
  if (isRole(value)) return { ok: true, value };
  return { ok: false, error: `Choose one of: ${ROLES.join(", ")}.` };
}

/** Passwords are never trimmed or changed — what is typed is what is hashed. */
export function checkPassword(
  password: string,
  confirmation: string,
  email?: string
): Checked<string> {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Use at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `Use at most ${PASSWORD_MAX_LENGTH} characters.` };
  }
  if (!password.trim()) return { ok: false, error: "The password can't be only spaces." };
  if (email && normalizeEmail(password) === normalizeEmail(email)) {
    return { ok: false, error: "The password can't be the email address." };
  }
  if (password !== confirmation) {
    return { ok: false, error: "The two passwords don't match." };
  }
  return { ok: true, value: password };
}
