import { cn } from "@/lib/utils";
import { formatMinorUnits, type FormatMoneyOptions } from "@/lib/format";

type MoneyDisplayProps = Omit<FormatMoneyOptions, "currency"> & {
  /** Pre-computed amount in minor units (bigint, or integer string when it crosses JSON). */
  amount: bigint | string | null | undefined;
  /** Required: there is no default currency in the design system. */
  currency: string;
  className?: string;
};

function toMinorUnits(amount: MoneyDisplayProps["amount"]): bigint | null {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "string" && /^-?\d+$/.test(amount)) return BigInt(amount);
  return null;
}

export function MoneyDisplay({
  amount,
  currency,
  locale,
  signDisplay,
  className,
}: MoneyDisplayProps) {
  const minor = toMinorUnits(amount);
  const classes = cn("font-medium whitespace-nowrap tabular-nums", className);

  if (minor === null) {
    return (
      <span className={classes}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not available</span>
      </span>
    );
  }

  return <span className={classes}>{formatMinorUnits(minor, { currency, locale, signDisplay })}</span>;
}
