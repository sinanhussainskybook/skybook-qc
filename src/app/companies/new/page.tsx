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
    <AppShell user={user}>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All companies
      </Link>

      <section className="mx-auto mt-8 max-w-md rounded-3xl bg-card p-6 ring-1 ring-foreground/8 sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Add a company</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Start with the name. Contact details, brand guidelines and Golden Rules are added on
          the company page next.
        </p>
        <AddCompanyForm />
      </section>
    </AppShell>
  );
}
