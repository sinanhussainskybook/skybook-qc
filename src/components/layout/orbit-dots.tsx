/**
 * The travelling lights on the hero's curved lines (styles in
 * globals.css, "skyqc-orbit-…"). Purely decorative: hidden from screen
 * readers, no pointer events, and off for reduced motion.
 */

/** Inside the page hero (.app-hero): one dot on each of its two rings. */
export function HeroOrbitDots() {
  return (
    <div className="skyqc-orbit-layer" aria-hidden>
      <div className="skyqc-orbit-center">
        <span className="skyqc-orbit-dot skyqc-orbit-dot--hero-inner" />
        <span className="skyqc-orbit-dot skyqc-orbit-dot--hero-outer" />
      </div>
    </div>
  );
}
