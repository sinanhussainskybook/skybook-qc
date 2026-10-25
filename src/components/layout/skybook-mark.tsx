import Image from "next/image";
import mark from "@/components/layout/skybook-mark.png";

/**
 * The Skybook brand mark: the official logo's mark (the book, the sweep and the arrow), cut from the
 * logo file with a transparent background so it sits on the dark header. A static image, served with
 * the app's build files, so it also shows on the sign-in page. Visual only — no behaviour lives here.
 */
export function SkybookMark({
  className = "h-9 w-auto",
  title = "Skybook",
}: {
  className?: string;
  title?: string;
}) {
  // The file's own size (223 × 192), given explicitly so it also renders where images aren't imported as objects (tests).
  return <Image src={mark} width={223} height={192} alt={title} className={className} priority />;
}

/** The mark with the SKYBOOK wordmark and a product label underneath. */
export function SkybookLogo({
  className = "",
  sub = "AI QC",
}: {
  className?: string;
  sub?: string;
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <SkybookMark className="h-8 w-auto shrink-0" />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-[0.16em]">
          SKYBOOK
        </span>
        <span className="mt-1 font-mono text-[9px] tracking-[0.28em] text-muted-foreground">
          {sub}
        </span>
      </span>
    </span>
  );
}
