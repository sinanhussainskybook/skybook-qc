import { Badge } from "@/components/ui/badge";
import {
  choiceLabel,
  GOLDEN_RULE_CATEGORIES,
  type ListKind,
} from "@/lib/company/fields";
import { hexToRgb } from "@/lib/company/validation";
import type { BrandColor, BrandFont, BrandTerm, GoldenRule, ListItems } from "@/lib/company/types";

/** How one saved list item reads when it isn't being edited. */
export function ItemSummary({
  kind,
  item,
}: {
  kind: ListKind;
  item: ListItems[ListKind][number];
}) {
  switch (kind) {
    case "brand_colors":
      return <ColorSummary color={item as BrandColor} />;
    case "brand_fonts":
      return <FontSummary font={item as BrandFont} />;
    case "brand_terms":
      return <TermSummary term={item as BrandTerm} />;
    case "golden_rules":
      return <GoldenRuleSummary rule={item as GoldenRule} />;
  }
}

function Details({ parts }: { parts: (string | null)[] }) {
  const shown = parts.filter(Boolean);
  if (shown.length === 0) return null;
  return <p className="mt-0.5 text-sm text-muted-foreground">{shown.join(" · ")}</p>;
}

function ColorSummary({ color }: { color: BrandColor }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="size-10 shrink-0 rounded-lg ring-1 ring-foreground/10"
        style={{ backgroundColor: color.hex }}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="font-medium">{color.name}</p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          HEX {color.hex} · RGB {hexToRgb(color.hex)}
          {color.cmyk && ` · CMYK ${color.cmyk}`}
        </p>
        <Details parts={[color.usage]} />
      </div>
    </div>
  );
}

function FontSummary({ font }: { font: BrandFont }) {
  return (
    <div className="min-w-0">
      <p className="font-medium">{font.family}</p>
      <Details
        parts={[
          font.weights,
          font.usage && `Used for: ${font.usage}`,
          font.size_guidance && `Size: ${font.size_guidance}`,
        ]}
      />
    </div>
  );
}

function TermSummary({ term }: { term: BrandTerm }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className={
            term.kind === "approved" ? "bg-pass-soft text-pass" : "bg-fail-soft text-fail"
          }
        >
          {term.kind === "approved" ? "Approved" : "Banned"}
        </Badge>
        <p className="font-medium break-words">{term.term}</p>
      </div>
      <Details parts={[term.note]} />
    </div>
  );
}

function GoldenRuleSummary({ rule }: { rule: GoldenRule }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {rule.mandatory ? (
          <Badge className="bg-fail text-white">Mandatory</Badge>
        ) : (
          <Badge variant="outline">Not mandatory</Badge>
        )}
        <Badge variant="secondary">{choiceLabel(GOLDEN_RULE_CATEGORIES, rule.category)}</Badge>
        {!rule.active && <Badge variant="outline">Switched off</Badge>}
      </div>
      <p className="mt-2 font-medium break-words whitespace-pre-line">{rule.rule}</p>
      {rule.approved_value && (
        <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm break-words whitespace-pre-line">
          <span className="font-medium">Approved value: </span>
          {rule.approved_value}
        </p>
      )}
    </div>
  );
}
