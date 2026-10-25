import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { addCompanyButtonClass, CompanyList } from "@/components/company/company-list";
import { getCompaniesForCurrentUser } from "@/lib/company/access";
import { companyLogoUrls } from "@/lib/company/logo";
import { getDatabase } from "@/lib/db/client";
import { getLogoStorage } from "@/lib/storage/logo-storage";
import { cn } from "@/lib/utils";

/**
 * Home: the companies this user may open (admins: all; designers: the ones
 * they are a member of — D13), each with its saved logo. Pick one to check a design for it.
 */
export default async function DashboardPage() {
  const { user, companies } = await getCompaniesForCurrentUser();
  const logoUrls = await companyLogoUrls(getDatabase(), getLogoStorage(), companies.map((company) => company.id));

  return (
    <AppShell
      user={user}
      background="home"
      hero={
        <>
          <p className="eyebrow hero-glass">Hi {user.name.split(" ")[0]}</p>
          <h1 className="display mt-5 max-w-3xl text-4xl sm:text-6xl">Which company is the design for?</h1>
          <p className="mt-4 max-w-xl text-muted-foreground sm:text-lg">Choose a company to check a design against its brief and brand rules.</p>
          {companies.length > 0 && (
            <Link href="/companies/new" className={cn(addCompanyButtonClass, "btn-glossy mt-8 h-11 px-5")}>
              <Plus aria-hidden />
              Add company
            </Link>
          )}
        </>
      }
    >
      <CompanyList companies={companies} logoUrls={logoUrls} />
    </AppShell>
  );
}
