"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * A company card's badge: the company's saved logo, shown as it is — no circle around it, in a wide
 * area so wide logos stay readable — or its initial letter in a rounded square when it has no logo or
 * the logo doesn't load (e.g. the link expired or Storage didn't answer).
 */
export function CompanyAvatar({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;

  if (showLogo) {
    return (
      <span className="relative block h-14 w-24 shrink-0">
        <Image
          src={logoUrl!}
          alt="" // decorative: the company name is right beside it, in the same link
          fill
          unoptimized
          sizes="96px"
          className="object-contain"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-lg font-bold text-secondary-foreground uppercase">
      {name.slice(0, 1)}
    </span>
  );
}
