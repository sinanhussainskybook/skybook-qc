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
      hero={
        <>
          <p className="eyebrow hero-glass">Hi {user.name.split(" ")[0]}</p>
          <h1 className="display mt-5 max-w-3xl text-4xl sm:text-6xl">Which company is the design for?</h1>
          <p className="mt-4 max-w-xl text-muted-foreground sm:text-lg">Choose a company to check a design against its brief and brand rules.</p>
          <QcSteps />
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

const STEPS = ["Upload the brief", "Upload the design", "Check Design", "Result + PDF report"];

/**
 * A short "about" in the hero: how a QC check works, in one line, and what it checks, one click away.
 * Text only — the company cards below stay the main thing on Home.
 */
function QcSteps() {
  return (
    <>
      <ol aria-label="How a QC check works" className="mt-6 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 text-xs sm:text-sm">
        {STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-white/45">
                →
              </span>
            )}
            <span className="hero-glass py-1 pl-1 text-white/90">
              <span aria-hidden className="flex size-5 items-center justify-center rounded-full bg-[#4b8cff] text-[10px] font-bold text-white">
                {i < STEPS.length - 1 ? i + 1 : "✓"}
              </span>
              {step}
            </span>
          </li>
        ))}
      </ol>
      <details className="group mt-3 w-full max-w-xl">
        <summary className="mx-auto w-fit cursor-pointer list-none text-sm text-[#9cc2ff] underline underline-offset-4 hover:text-white">
          What does QC check?
        </summary>
        <div className="mt-3 grid gap-2 rounded-2xl bg-white/[0.07] p-4 text-left text-sm text-white/85 ring-1 ring-white/15 backdrop-blur-sm">
          <p>
            <strong className="text-white">The brief:</strong> prices, dates, offers, contact details and required text are read from the client&apos;s brief.
          </p>
          <p>
            <strong className="text-white">The design:</strong> checked against the brief, the company&apos;s brand colours, fonts and Golden Rules, and the platform size.
          </p>
          <p>
            <strong className="text-white">The result:</strong> PASS, NEEDS REVISION or FAIL, each issue circled on the design, and a PDF report to download.
          </p>
          <p className="text-white/65">
            Anything the AI isn&apos;t sure about says &ldquo;Please verify&rdquo;. Use sample designs only while Gemini is on the free tier. Checks are deleted after 24 hours.
          </p>
        </div>
      </details>
    </>
  );
}
