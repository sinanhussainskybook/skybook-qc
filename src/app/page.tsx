import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { addCompanyButtonClass, CompanyList } from "@/components/company/company-list";
import { getCompaniesForCurrentUser } from "@/lib/company/access";

/**
 * Home: the companies this user may open (admins: all; designers: the ones
 * they are a member of — D13). Pick one to check a design for it.
 */
export default async function DashboardPage() {
  const { user, companies } = await getCompaniesForCurrentUser();

  return (
    <AppShell user={user}>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="eyebrow">Hi {user.name.split(" ")[0]}</p>
          <h1 className="display mt-3 text-4xl sm:text-5xl">Which company is the design for?</h1>
          <p className="mt-4 text-muted-foreground">Choose a company to check a design against its brief and brand rules.</p>
        </div>
        {companies.length > 0 && (
          <Link href="/companies/new" className={addCompanyButtonClass}>
            <Plus aria-hidden />
            Add company
          </Link>
        )}
      </div>

      <div className="mt-10">
        <CompanyList companies={companies} />
      </div>
    </AppShell>
  );
}
