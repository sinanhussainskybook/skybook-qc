"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * A company row's logo: the saved logo, shown as it is and filling the logo slot it's placed in (no
 * circle, so wide logos stay readable) — or the initial letter in a rounded square when it has no logo
 * or the logo doesn't load (e.g. the link expired or Storage didn't answer).
 */
export function CompanyAvatar({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;

  if (showLogo) {
    return (
      <span className="relative block size-full">
        <Image
          src={logoUrl!}
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
    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-xl font-bold text-secondary-foreground uppercase sm:size-14">
      {name.slice(0, 1)}
    </span>
  );
}
