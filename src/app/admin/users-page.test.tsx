import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const requireRole = vi.fn();
const listUsers = vi.fn();

vi.mock("@/lib/auth/current-user", () => ({ requireRole }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/db/users", () => ({ listUsers }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/lib/auth/user-admin-actions", () => ({
  createUserAction: vi.fn(),
  setUserActiveAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  deleteUserAction: vi.fn(),
}));

const { default: UsersPage } = await import("@/app/admin/users/page");

const ada = { id: "a1", name: "Ada Admin", email: "ada@skybook.com", role: "admin", active: true, mustChangePassword: false };
const now = new Date();

describe("User Management page", () => {
  beforeEach(() => {
    requireRole.mockReset().mockResolvedValue(ada);
    listUsers.mockReset().mockResolvedValue([
      { ...ada, createdAt: now },
      { id: "d1", name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: false, mustChangePassword: true, createdAt: now },
    ]);
  });

  it("asks for the admin role before loading anything", async () => {
    requireRole.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(UsersPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireRole).toHaveBeenCalledWith("admin");
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("lists users with role and status, and the add-user form", async () => {
    const html = renderToStaticMarkup(await UsersPage());
    expect(html).toContain("Add a user");
    expect(html).toContain("dee@skybook.com");
    expect(html).toContain("Switched off");
    expect(html).toContain("Temporary password");
    expect(html).toContain("Switch on");
    expect(html).not.toMatch(/scrypt|password_hash/);
  });

  it("offers no switch-off, reset or delete on your own row", async () => {
    const html = renderToStaticMarkup(await UsersPage());
    const own = html.slice(html.indexOf("Ada Admin"), html.indexOf("Dee Designer"));
    expect(own).toContain("(you)");
    expect(own).toContain("Change your password");
    expect(own).not.toMatch(/Switch off|Reset password|>Delete</);
  });
});
