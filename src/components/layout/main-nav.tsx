"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { House, Users, type LucideIcon } from "lucide-react";
import { USERS_PATH } from "@/lib/auth/route-access";
import type { Role } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/layout/theme-toggle";

type NavItem = { href: string; label: string; icon: LucideIcon; isActive: (path: string) => boolean; adminOnly?: boolean };

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Home",
    icon: House,
    // Home, and everything under a company (adding one, its page and its QC check).
    isActive: (path) => path === "/" || path.startsWith("/companies/"),
  },
  { href: USERS_PATH, label: "Users", icon: Users, isActive: (path) => path.startsWith(USERS_PATH), adminOnly: true },
];

/**
 * The main navigation: one pill, the current page in a dark pill inside it,
 * the light / dark switch, and `children` (who is signed in, Sign out) at its right end. Users is
 * shown to admins only (the page itself checks the role on the server).
 * "Add company" is on the Home page, not here. On a phone only icons show.
 */
export function MainNav({ role, children }: { role: Role; children?: ReactNode }) {
  const path = usePathname() ?? "";
  const items = ITEMS.filter((item) => !item.adminOnly || role === "admin");

  return (
    <nav aria-label="Main" className="flex items-center gap-1 rounded-full bg-white/[0.07] p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/15 backdrop-blur">
      <ul className="flex items-center gap-0.5">
        {items.map(({ href, label, icon: Icon, isActive }) => {
          const active = isActive(path);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-full px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-4",
                  active
                    ? "bg-white/15 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]"
                    : "text-white/75 hover:bg-white/10 hover:text-white"
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <ThemeToggle />
      {children && (
        <>
          <span className="mx-1 h-6 w-px bg-white/15" aria-hidden />
          {children}
        </>
      )}
    </nav>
  );
}
