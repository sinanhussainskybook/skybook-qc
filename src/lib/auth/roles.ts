/**
 * The two roles (D2). Stored on each user and checked on the server.
 *
 * - `designer` — runs QC checks.
 * - `admin` — everything a designer can do, plus administrative features
 *   added later. There is no admin screen yet.
 */

export const ROLES = ["admin", "designer"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  designer: "Designer",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Does `user` have the permissions of `required`? An admin counts as a
 * designer as well; a designer never counts as an admin.
 */
export function hasRole(user: { role: Role }, required: Role): boolean {
  return required === "designer" ? isRole(user.role) : user.role === "admin";
}
