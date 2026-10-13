"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db/client";
import { requireRole } from "@/lib/auth/current-user";
import { deleteCompany } from "@/lib/company/delete-company";
import { getLogoStorage } from "@/lib/storage/logo-storage";
import { getQcStorage } from "@/lib/storage/qc-storage";

/**
 * Delete a company — administrators only. requireRole("admin") runs first,
 * so a designer gets "not found" whatever the page showed; the rules are in
 * delete-company.ts. On success the admin is taken back to Home.
 */

export type DeleteCompanyState = { error?: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function deleteCompanyAction(_previous: DeleteCompanyState, formData: FormData): Promise<DeleteCompanyState> {
  const admin = await requireRole("admin");
  let result;
  try {
    result = await deleteCompany(
      getDatabase(),
      admin,
      { companyId: field(formData, "companyId"), confirmName: field(formData, "confirmName") },
      { logos: getLogoStorage(), qc: getQcStorage() }
    );
  } catch (error) {
    console.error("Delete company failed:", error);
    return { error: "The company couldn't be deleted. Please try again." };
  }
  if (!result.ok) return { error: result.error };
  revalidatePath("/");
  redirect("/");
}
