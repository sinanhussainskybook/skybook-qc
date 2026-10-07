import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

/**
 * Shown for a company that doesn't exist *or* that the user may not open —
 * deliberately the same message, so an ID in a URL reveals nothing.
 */
export default function CompanyNotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground">
        <SearchX className="size-5" aria-hidden />
      </span>
      <h1 className="mt-4 text-xl font-semibold">Company not found</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        It doesn&apos;t exist, or you haven&apos;t been given access to it.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to your companies
      </Link>
    </main>
  );
}
