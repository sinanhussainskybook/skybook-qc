import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { AddCompanyForm } from "@/components/company/add-company-form";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Add company · Skybook AI QC" };

export default async function NewCompanyPage() {
  const user = await requireUser();

  return (
    <AppShell
      user={user}
      hero={
        <>
          <Link href="/" className="hero-glass text-sm">
            <ArrowLeft className="size-4" aria-hidden />
            All companies
          </Link>
          <h1 className="display mt-6 text-4xl sm:text-6xl">Add a company</h1>
          <p className="mt-4 max-w-xl text-muted-foreground sm:text-lg">
            Start with the name. Contact details, brand guidelines and Golden Rules are added on
            the company page next.
          </p>
        </>
      }
    >
      <section className="mx-auto max-w-md">
        <AddCompanyForm />
      </section>
    </AppShell>
  );
}
