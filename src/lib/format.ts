/**
 * Presentation only: turns already-computed values into display strings with Intl.
 * No totals or arithmetic on money here (see lib/money.ts).
 */
/** Integer amount in a currency's minor unit (sen for MYR). */
export type MinorUnits = bigint;

/** Defaults for display only; calculations never use these (see src/lib/billing.ts). */
export const DEFAULT_CURRENCY = "MYR";
export const DEFAULT_LOCALE = "en-MY";

/** Minor-unit digits for a currency, as the runtime's Intl data defines them (JPY 0, USD 2, KWD 3). */
export function getFractionDigits(currency: string, locale: string): number {
  return (
    new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** Inserts the decimal point by string manipulation, so no float division is involved. */
export function minorToDecimalString(
  minor: MinorUnits,
  fractionDigits: number,
): string {
  const negative = minor < BigInt(0);
  const digits = (negative ? -minor : minor).toString();
  let result = digits;
  if (fractionDigits > 0) {
    const padded = digits.padStart(fractionDigits + 1, "0");
    result = `${padded.slice(0, -fractionDigits)}.${padded.slice(-fractionDigits)}`;
  }
  return negative ? `-${result}` : result;
}

export type FormatMoneyOptions = {
  currency: string;
  locale?: string;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
};

export function formatMinorUnits(
  minor: MinorUnits,
  { currency, locale = DEFAULT_LOCALE, signDisplay }: FormatMoneyOptions,
): string {
  const digits = getFractionDigits(currency, locale);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay,
  });
  // Intl.NumberFormat v3 formats numeric strings as exact decimals.
  return formatter.format(minorToDecimalString(minor, digits) as `${number}`);
}

/** `isoDate` is a calendar date (YYYY-MM-DD); rendered in UTC so it never shifts a day. */
export function formatDate(isoDate: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
