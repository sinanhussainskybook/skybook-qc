"use server";

import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db/client";
import { requireRole } from "@/lib/auth/current-user";
import { USERS_PATH } from "@/lib/auth/route-access";
import {
  adminCreateUser,
  adminDeleteUser,
  adminResetPassword,
  adminSetUserActive,
  type AdminResult,
} from "@/lib/auth/user-admin";

/**
 * Server actions for the User Management page (/admin/users). Each one first
 * calls requireRole("admin") — a designer gets "not found", a signed-out
 * visitor the sign-in page — so the check never depends on what the page
 * showed. The rules themselves are in user-admin.ts.
 */

const SAVE_FAILED = "That couldn't be saved. Please try again.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export type CreateUserFormState = {
  ok?: boolean;
  message?: string;
  errors?: Partial<Record<"name" | "email" | "role" | "password" | "form", string>>;
  values?: { name: string; email: string; role: string };
};

export async function createUserAction(
  _previous: CreateUserFormState,
  formData: FormData
): Promise<CreateUserFormState> {
  const admin = await requireRole("admin");
  const values = { name: field(formData, "name"), email: field(formData, "email"), role: field(formData, "role") };
  try {
    const result = await adminCreateUser(getDatabase(), admin, {
      ...values,
      password: field(formData, "password"),
      passwordConfirmation: field(formData, "passwordConfirmation"),
    });
    if (!result.ok) return { errors: result.errors, values };
    revalidatePath(USERS_PATH);
    return {
      ok: true,
      message: `${result.user.name} was added. Give them the temporary password privately — they must choose their own when they sign in.`,
    };
  } catch (error) {
    console.error("Create user failed:", error);
    return { errors: { form: SAVE_FAILED }, values };
  }
}

export type UserActionState = { ok?: boolean; message?: string; error?: string };

async function run(action: () => Promise<AdminResult>): Promise<UserActionState> {
  try {
    const result = await action();
    if (!result.ok) return { error: result.error };
    revalidatePath(USERS_PATH);
    return { ok: true, message: result.message };
  } catch (error) {
    console.error("User Management action failed:", error);
    return { error: SAVE_FAILED };
  }
}

export async function setUserActiveAction(_previous: UserActionState, formData: FormData): Promise<UserActionState> {
  const admin = await requireRole("admin");
  return run(() => adminSetUserActive(getDatabase(), admin, field(formData, "userId"), field(formData, "active") === "true"));
}

export async function resetPasswordAction(_previous: UserActionState, formData: FormData): Promise<UserActionState> {
  const admin = await requireRole("admin");
  return run(() =>
    adminResetPassword(getDatabase(), admin, {
      userId: field(formData, "userId"),
      password: field(formData, "password"),
      passwordConfirmation: field(formData, "passwordConfirmation"),
    })
  );
}

export async function deleteUserAction(_previous: UserActionState, formData: FormData): Promise<UserActionState> {
  const admin = await requireRole("admin");
  return run(() =>
    adminDeleteUser(getDatabase(), admin, { userId: field(formData, "userId"), confirmEmail: field(formData, "confirmEmail") })
  );
}
