import { formatCents } from "@/lib/money";

interface MoneyProps {
  cents: number;
  className?: string;
  struck?: boolean;
  // Figures default to the mono face so columns line up; "inherit" keeps the parent face (big totals).
  face?: "mono" | "inherit";
}

const MONO = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" } as const;

export default function Money({ cents, className, struck, face = "mono" }: MoneyProps) {
  const text = formatCents(cents);
  const style = face === "mono" ? MONO : undefined;
  return struck ? (
    <s className={className} style={style}>
      {text}
    </s>
  ) : (
    <span className={className} style={style}>
      {text}
    </span>
  );
}
