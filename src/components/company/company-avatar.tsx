"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * A company card's round badge: the company's saved logo, or its initial
 * letter when it has no logo or the logo doesn't load (e.g. the link expired
 * or Storage didn't answer).
 */
export function CompanyAvatar({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;

  return (
    <span className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-base font-bold text-secondary-foreground uppercase">
      {showLogo ? (
        <Image
          src={logoUrl!}
          alt="" // decorative: the company name is right beside it, in the same link
          fill
          unoptimized
          sizes="44px"
          className="object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
}
