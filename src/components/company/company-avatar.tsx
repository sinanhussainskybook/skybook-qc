"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * A company row's logo: the saved logo, shown as it is and filling the logo slot it's placed in (no
 * circle, so wide logos stay readable) — or the initial letter in a rounded square when it has no logo
 * or the logo doesn't load (e.g. the link expired or Storage didn't answer).
 * `small`: a smaller initial square, for the slim logo slot of a table row.
 */
export function CompanyAvatar({ name, logoUrl, small = false }: { name: string; logoUrl?: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <span className="relative block size-full">
        <Image
          src={logoUrl}
          alt="" // decorative: the company name is right beside it, in the same link
          fill
          unoptimized
          sizes="144px"
          className="object-contain"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className={
        small
          ? "flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-bold text-secondary-foreground uppercase"
          : "flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-xl font-bold text-secondary-foreground uppercase sm:size-14"
      }
    >
      {name.slice(0, 1)}
    </span>
  );
}
