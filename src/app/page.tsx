import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { addCompanyButtonClass, CompanyList } from "@/components/company/company-list";
import { getCompaniesForCurrentUser } from "@/lib/company/access";

/**
 * Dashboard: the companies this user may open (admins: all; designers:
 * the ones they are a member of — D13), and Add company.
 */
export default async function DashboardPage() {
  const { user, companies } = await getCompaniesForCurrentUser();

  return (
    <AppShell user={user}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-primary">
            Welcome, {user.name.split(" ")[0]}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Companies</h1>
          <p className="mt-2 text-muted-foreground">
            Choose the company whose content you are checking.{" "}
            {user.role === "admin"
              ? "As an admin you see every company."
              : "You see the companies you added or were added to."}
          </p>
        </div>
        {companies.length > 0 && (
          <Link href="/companies/new" className={addCompanyButtonClass}>
            <Plus aria-hidden />
            Add company
          </Link>
        )}
      </div>

      <div className="mt-8">
        <CompanyList companies={companies} />
      </div>
    </AppShell>
  );
}
