import {
  capitalizationDifference,
  containsText,
  ctaMatches,
  datesMatch,
  datesWrittenOneWay,
  emailsMatch,
  findDates,
  findEmails,
  findName,
  findPercentages,
  findPhones,
  findPrices,
  findTimes,
  findWebsites,
  normalizeWords,
  oldPrices,
  parseDimensions,
  parsePercentage,
  parsePrice,
  phonesMatch,
  pricesMatch,
  textMatches,
  type Price,
  websitesMatch,
} from "@/lib/qc/compare";
import { allText, roleBasedConfidence, type ContentDetections } from "@/lib/qc/detections";
import type { Finding, Rule, Severity } from "@/lib/qc/findings";
import type { QcInputRequirement } from "@/lib/qc/qc-input";
import { requirementTypeLabel } from "@/lib/qc/requirements";
import type { ContentFileFacts } from "@/lib/qc/rules/platform-size";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, severityFor, type QcContext } from "@/lib/qc/rules/context";

/**
 * Brief QC (plan 5.10): every CONFIRMED requirement against the content —
 *   missing    the requirement isn't there at all,
 *   wrong      something of that kind is there, but a different value,
 *   mismatched it's there, but written slightly differently (misspelt,
 *              currency or country code left out),
 *   unexpected prices, percentages or dates in the content that the brief
 *              doesn't ask for (an old offer left in, for example).
 * A mandatory requirement missing or wrong is CRITICAL; optional: wrong is
 * MAJOR, missing MINOR. Video counts what's said as well as what's shown.
 * Disclaimers are Legal (5.12); platform is Platform / Size (5.11).
 *
 * Two exact checks for what the client confirmed:
 *   dimensions  an exact pixel size ("1080 × 1080") is compared with each
 *               design's measured size — no platform choice needed. Any other
 *               dimensions wording is left to the Platform / Size check.
 *   capitals    a MANDATORY required text whose words are all there but with
 *               different capitals ("T&C Apply" for "T&C apply") is MINOR.
 * A product or service name the brief only describes (not Must have) isn't
 * reported as missing: briefs often describe the offer ("Customized Azerbaijan
 * Travel Packages") without asking for those words on the design. Shown, or
 * misspelt, it is still checked; a Must have one must be there.
 */

const CATEGORY = "brief" as const;
const RULE_ID = "brief.requirement";

type Outcome =
  | { kind: "present"; detected: string; confidence?: number }
  | { kind: "mismatched"; detected: string; why: string; fix: string; confidence?: number }
  | { kind: "wrong"; detected: string; confidence?: number }
  | { kind: "missing" };

/**
 * Free-text requirement: whole words present, else a close misspelling, else — the same words with other
 * numbers ("iPhone 15" for "iPhone 16") — a wrong value, else missing.
 */
function textOutcome(expected: string, raw: string): Outcome {
  // Dates in the brief's wording and on the design are compared as dates, however they're written
  // ("31 Dec 2026" = "31 December 2026" = "31/12/2026"); another date is then the same words with
  // another number — a wrong value — never "missing" plus an unexpected date.
  const text = datesWrittenOneWay(raw);
  if (containsText(text, datesWrittenOneWay(expected))) return { kind: "present", detected: expected };
  const name = findName(text, datesWrittenOneWay(expected));
  if (name.status === "misspelt") return { kind: "mismatched", detected: name.found, why: "It appears, but written differently.", fix: `Write it exactly as "${expected}".` };
  if (name.status === "different") return { kind: "wrong", detected: name.found };
  return { kind: "missing" };
}

/** Typed values: find all of that kind; one equal → present; others → wrong; none → missing. */
function valueOutcome<T>(found: T[], same: (value: T) => boolean, show: (value: T) => string): Outcome {
  const hit = found.find(same);
  if (hit !== undefined) return { kind: "present", detected: show(hit) };
  return found.length ? { kind: "wrong", detected: found.map(show).join(", ") } : { kind: "missing" };
}

function check(r: QcInputRequirement, d: ContentDetections): Outcome | "unchecked" {
  const text = allText(d) ?? "";
  const value = r.expectedValue;
  switch (r.type) {
    case "phone":
    case "whatsapp": {
      const found = findPhones(text);
      const results = found.map((p) => ({ p, m: phonesMatch(value, p) }));
      const exact = results.find((x) => x.m === "match");
      if (exact) return { kind: "present", detected: exact.p };
      const local = results.find((x) => x.m === "match_without_country_code");
      if (local) return { kind: "mismatched", detected: local.p, why: "The number is shown without its country code.", fix: `Show it as ${value}.` };
      return found.length ? { kind: "wrong", detected: found.join(", ") } : { kind: "missing" };
    }
    case "email":
      return valueOutcome(findEmails(text), (e) => emailsMatch(value, e), (e) => e);
    case "website":
      return valueOutcome(findWebsites(text), (w) => websitesMatch(value, w), (w) => w);
    case "price": {
      const expected = parsePrice(value);
      if (!expected) return textOutcome(value, text);
      const found = findPrices(text);
      const exact = found.find((p) => pricesMatch(expected, p) === "match");
      if (exact) return { kind: "present", detected: exact.text };
      const noCurrency = found.find((p) => pricesMatch(expected, p) === "currency_missing");
      if (noCurrency) return { kind: "mismatched", detected: noCurrency.text, why: "The amount is right but the currency isn't shown.", fix: `Show the price as ${expected.text}.` };
      if (found.length) return { kind: "wrong", detected: found.map((p) => p.text).join(", ") };
      return containsText(text, value) ? { kind: "present", detected: value } : { kind: "missing" };
    }
    case "percentage": {
      const expected = parsePercentage(value);
      if (expected === null) return textOutcome(value, text);
      return valueOutcome(findPercentages(text), (p) => p === expected, (p) => `${p}%`);
    }
    case "date": {
      // Day and month without a year ("18/10") can match the brief's date; only full dates can be "wrong".
      const [expected] = findDates(value, { withoutYear: true });
      if (!expected) return textOutcome(value, text);
      const hit = findDates(text, { withoutYear: true }).find((m) => datesMatch(expected, m));
      if (hit) return { kind: "present", detected: value };
      const found = findDates(text);
      return found.length ? { kind: "wrong", detected: `${found.length} other date${found.length === 1 ? "" : "s"}` } : { kind: "missing" };
    }
    case "time": {
      const [expected] = findTimes(value);
      if (expected === undefined) return textOutcome(value, text);
      const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return valueOutcome(findTimes(text), (t) => t === expected, clock);
    }
    case "cta": {
      const ctas = (d.texts ?? []).filter((t) => t.role === "cta");
      const hit = ctas.find((t) => ctaMatches(value, t.text));
      if (hit) return { kind: "present", detected: hit.text, confidence: hit.confidence };
      if (containsText(text, value)) return { kind: "present", detected: value };
      // Another text labelled the CTA: only as sure as that text and its role (never "certain" by default).
      return ctas.length ? { kind: "wrong", detected: ctas.map((t) => t.text).join(", "), confidence: roleBasedConfidence(ctas) } : { kind: "missing" };
    }
    case "headline": {
      const headlines = (d.texts ?? []).filter((t) => t.role === "headline");
      const hit = headlines.find((t) => textMatches(value, t.text));
      if (hit) return { kind: "present", detected: hit.text, confidence: hit.confidence };
      const outcome = textOutcome(value, text);
      if (outcome.kind === "missing" && headlines.length) {
        return { kind: "wrong", detected: headlines.map((t) => t.text).join(" / "), confidence: roleBasedConfidence(headlines) };
      }
      return outcome;
    }
    case "required_text":
    case "offer":
    case "product_name":
    case "service_name":
    case "location":
    case "campaign_name":
      return textOutcome(value, text);
    default:
      return "unchecked"; // target audience, special instruction, other, or a new type
  }
}

/** Brief items that may only describe the offer: not "missing" unless they are Must have. */
const DESCRIBED_TYPES = new Set(["product_name", "service_name"]);

/** Requirement types whose wording must be copied exactly, capitals included, when mandatory. */
const EXACT_WORDING = new Set(["required_text"]);

/** A confirmed exact pixel size against every design's measured size (one finding per design). */
function judgeSize(r: QcInputRequirement, size: { width: number; height: number }, files: ContentFileFacts[], title: string): Finding[] {
  const id = `${RULE_ID}.dimensions`;
  const make = findingFor(id, CATEGORY, title);
  const expected = `${size.width} × ${size.height} px`;
  const severity: Severity = r.mandatory ? "major" : "minor";
  if (!files.length) return [notVerified(id, CATEGORY, title, severity, "No design has been uploaded to measure.", expected)];
  return files.map((file) => {
    const m = file.media;
    const where = { fileId: file.id, fileName: file.fileName };
    if (!m || m.unit !== "px" || m.width === undefined || m.height === undefined) {
      return { ...notVerified(id, CATEGORY, title, severity, "This design's size in pixels couldn't be measured — check it by eye.", expected), ...where };
    }
    const match = m.width === size.width && m.height === size.height;
    return make({
      severity,
      status: match ? "passed" : "failed",
      expected,
      detected: `${m.width} × ${m.height} px`,
      explanation: match ? "The design is the exact size the brief asks for." : `The design isn't the size the brief asks for.${r.mandatory ? " The brief marks it as mandatory." : ""}`,
      suggestedFix: `Export the design at exactly ${expected}.`,
      ...where,
    });
  });
}

/** Every finding about a requirement carries its id, so the report can show that requirement's status. */
function linked(found: Finding | Finding[], r: QcInputRequirement): Finding[] {
  return (Array.isArray(found) ? found : [found]).map((f) => (r.id ? { ...f, requirementId: r.id } : f));
}

function judge(r: QcInputRequirement, d: ContentDetections | null, files: ContentFileFacts[] = []): Finding | Finding[] {
  const label = requirementTypeLabel(r.type);
  const title = r.label ? `${label}: ${r.label}` : label;
  const id = `${RULE_ID}.${r.type}`;
  const make = findingFor(id, CATEGORY, title);
  const notes = r.notes ? ` Note from the brief: ${r.notes}` : "";
  const size = r.type === "dimensions" ? parseDimensions(r.expectedValue) : null;
  if (size) return judgeSize(r, size, files, title);
  if (r.type === "platform" || r.type === "dimensions") {
    return notApplicable(id, CATEGORY, title, "Checked by the Platform / Size check against the platform chosen for this session.");
  }
  if (!d?.texts) return notVerified(id, CATEGORY, title, severityFor(r.mandatory), NEEDS_ANALYSIS, r.expectedValue);
  const outcome = check(r, d);
  if (outcome === "unchecked") {
    return notVerified(id, CATEGORY, title, severityFor(r.mandatory, "minor"), `This kind of requirement can't be compared automatically — check it by eye.${notes}`, r.expectedValue);
  }
  const mandatoryNote = r.mandatory ? " The brief marks it as mandatory." : "";
  switch (outcome.kind) {
    case "present": {
      const capitals = r.mandatory && EXACT_WORDING.has(r.type) ? capitalizationDifference(allText(d) ?? "", r.expectedValue) : null;
      if (capitals) {
        return make({
          severity: "minor",
          status: "failed",
          expected: r.expectedValue,
          detected: capitals,
          explanation: "The wording is right, but the capitals differ from the brief.",
          suggestedFix: `Write it exactly as "${r.expectedValue}".`,
          confidence: outcome.confidence,
        });
      }
      return make({ severity: severityFor(r.mandatory), status: "passed", expected: r.expectedValue, detected: outcome.detected, explanation: "Present as the brief asks.", confidence: outcome.confidence });
    }
    case "mismatched":
      return make({
        severity: "major" as Severity,
        status: "failed",
        expected: r.expectedValue,
        detected: outcome.detected,
        explanation: outcome.why,
        suggestedFix: outcome.fix,
        confidence: outcome.confidence,
      });
    case "wrong":
      return make({
        severity: severityFor(r.mandatory, "major"),
        status: "failed",
        expected: r.expectedValue,
        detected: outcome.detected,
        explanation: `The content shows a different ${label.toLowerCase()} from the brief.${mandatoryNote}`,
        suggestedFix: `Change it to "${r.expectedValue}".`,
        confidence: outcome.confidence,
      });
    case "missing":
      if (DESCRIBED_TYPES.has(r.type) && !r.mandatory) {
        return notApplicable(id, CATEGORY, title, "The brief describes this, but doesn't require these exact words on the design, so it isn't counted.");
      }
      return make({
        severity: severityFor(r.mandatory, "minor"),
        status: "failed",
        expected: r.expectedValue,
        detected: "Not found",
        explanation: `The brief asks for this, but it isn't in the content.${mandatoryNote}`,
        suggestedFix: `Add "${r.expectedValue}".${notes}`,
      });
  }
}

const requirementsRule: Rule<QcContext> = {
  id: RULE_ID,
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["confirmed requirements (4.2)", "text read from the content (and speech, for video)"],
  defaultSeverity: "critical",
  mandatory: true,
  run(context) {
    const list = context.requirements.filter((r) => r.type !== "disclaimer");
    if (list.length === 0) return [notApplicable(RULE_ID, CATEGORY, "Brief", "No confirmed requirements to check (disclaimers are checked under Legal).")];
    return list.flatMap((r) => linked(judge(r, context.detections, context.platform?.files), r));
  },
};

/** Requirements whose words must appear on the design: a value written in them is one the brief expects. */
const WORDED_TYPES = new Set(["offer", "required_text", "headline", "cta", "disclaimer", "product_name", "service_name", "location"]);

/** Values of these kinds that appear in the content but aren't in the brief. */
const unexpectedRule: Rule<QcContext> = {
  id: "brief.unexpected",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["confirmed requirements", "text read from the content"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const text = allText(context.detections);
    if (text === null) return [notVerified(this.id, CATEGORY, "Unexpected offer details", "major", NEEDS_ANALYSIS)];
    const of = (type: string) => context.requirements.filter((r) => r.type === type).map((r) => r.expectedValue);
    // Values the brief gives inside its own wording ("20% off", "From AED 1,299", "Valid until 31 Dec") are
    // expected on the design too. Descriptive items (instructions, audience…) never make a value expected.
    const worded = context.requirements.filter((r) => WORDED_TYPES.has(r.type)).map((r) => r.expectedValue);
    // One mistake, one finding: when a requirement of this kind already reports the
    // content's values as WRONG (its finding lists every value of that kind it found),
    // those values aren't reported a second time here.
    const detections = context.detections!;
    const reportedWrong = (type: string) =>
      context.requirements.some((r) => {
        if (r.type !== type) return false;
        const outcome = check(r, detections);
        return outcome !== "unchecked" && outcome.kind === "wrong";
      });
    // Brief wording reported wrong or written differently ("20% off" shown as "25% off") names only the
    // words it found — so only the values IN those words are skipped here; any other extra value of the
    // same kind ("and 10% cashback") is still reported.
    const wordedFound = context.requirements
      .filter((r) => WORDED_TYPES.has(r.type))
      .flatMap((r) => {
        const outcome = check(r, detections);
        return outcome !== "unchecked" && (outcome.kind === "wrong" || outcome.kind === "mismatched") ? [` ${normalizeWords(outcome.detected)} `] : [];
      });
    const inWordedFound = (words: string) => wordedFound.some((w) => w.includes(` ${normalizeWords(words)} `));
    // A date in those words: read as a date ("30 dec 2026"), or — its slashes gone when the words were
    // normalised ("30 12 2026") — as the same day, month and year numbers.
    const dateInWordedFound = (mention: ReturnType<typeof findDates>[number]) =>
      wordedFound.some((w) => {
        if (findDates(w, { withoutYear: true }).some((found) => datesMatch(found, mention))) return true;
        const numbers = new Set(w.match(/\d+/g) ?? []);
        return mention.some((d) => numbers.has(String(d.day)) && numbers.has(String(d.month)) && (d.year === undefined || numbers.has(String(d.year))));
      });
    const skippedAsWorded = new Set<string>();
    const make = findingFor(this.id, CATEGORY, "Unexpected offer details");
    const findings: Finding[] = [];
    const flag = (kind: string, detected: string, briefHasKind: boolean) =>
      findings.push(
        make({
          severity: briefHasKind ? "major" : "minor",
          status: "failed",
          expected: briefHasKind ? `Only the ${kind} in the brief` : `No ${kind} (the brief doesn't give one)`,
          detected,
          explanation: briefHasKind
            ? `This ${kind} isn't the one in the brief — perhaps left over from an earlier version.`
            : `The content shows a ${kind}, but the brief doesn't mention one. Check it's meant to be there.`,
          suggestedFix: `Remove it, or confirm it with the client and add it to the requirements.`,
        })
      );

    const briefPrices = [...of("price").map(parsePrice).filter((p) => p !== null), ...worded.flatMap(findPrices)];
    // An offer's old price — introduced as one ("Was AED 1,500", "instead of …") and higher than the brief's
    // price, which is shown too — is the offer working as intended, not a stray price. Anything else is checked.
    const shownPrices = findPrices(text);
    const briefShown = shownPrices.some((p) => briefPrices.some((b) => pricesMatch(b, p) === "match"));
    const highestBrief = Math.max(...briefPrices.map((b) => b.amount));
    const asOld = new Set(oldPrices(text).map((p) => p.text));
    const isOldPrice = (p: Price) => briefShown && asOld.has(p.text) && p.amount > highestBrief;
    let oldShown = 0;
    if (!reportedWrong("price")) for (const p of shownPrices) {
      if (briefPrices.some((b) => pricesMatch(b, p) !== "mismatch")) continue;
      if (inWordedFound(p.text)) skippedAsWorded.add("price");
      else if (isOldPrice(p)) oldShown++;
      else flag("price", p.text, briefPrices.length > 0);
    }
    const briefPercentages = [...of("percentage").map(parsePercentage).filter((p) => p !== null), ...worded.flatMap(findPercentages)];
    if (!reportedWrong("percentage")) for (const p of new Set(findPercentages(text))) {
      if (briefPercentages.includes(p)) continue;
      if (inWordedFound(`${p}%`)) skippedAsWorded.add("percentage");
      else flag("percentage", `${p}%`, briefPercentages.length > 0);
    }
    const briefDates = [...of("date"), ...worded].flatMap((v) => findDates(v, { withoutYear: true }));
    if (!reportedWrong("date")) for (const mention of findDates(text)) {
      if (!briefDates.some((b) => datesMatch(b, mention))) {
        if (dateInWordedFound(mention)) {
          skippedAsWorded.add("date");
          continue;
        }
        const m = mention[0];
        flag("date", `${m.day}/${m.month}${m.year ? `/${m.year}` : ""}${mention.length > 1 ? " (or the other way round)" : ""}`, briefDates.length > 0);
      }
    }
    if (findings.length) return findings;
    // A wrong value of some kind was reported under its requirement and skipped here:
    // "nothing unexpected" would be untrue, so this check doesn't claim a pass.
    const covered = (["price", "percentage", "date"] as const).filter((kind) => reportedWrong(kind) || skippedAsWorded.has(kind));
    if (covered.length) {
      return [notApplicable(this.id, CATEGORY, "Unexpected offer details", `The ${covered.join(", ")} shown differ${covered.length === 1 ? "s" : ""} from the brief — reported under the brief's requirement above, not repeated here.`)];
    }
    return [
      make({
        severity: "major",
        status: "passed",
        detected: "None",
        explanation: oldShown
          ? "No prices, percentages or dates beyond those in the brief — apart from the offer's old price, shown as the price it replaces."
          : "No prices, percentages or dates beyond those in the brief.",
      }),
    ];
  },
};

export const BRIEF_RULES: readonly Rule<QcContext>[] = [requirementsRule, unexpectedRule];
