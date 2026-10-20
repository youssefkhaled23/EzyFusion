/**
 * Date-only helpers. The value at every form boundary is a calendar date string, YYYY-MM-DD.
 * A Date is built from local year/month/day (never from a UTC timestamp) and read back with the
 * local getters, so the selected calendar day cannot shift with the viewer's timezone.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns a local-midnight Date, or undefined for malformed or non-existent dates (e.g. 2026-02-30). */
export function parseIsoDate(value: string | null | undefined): Date | undefined {
  const match = value ? ISO_DATE.exec(value) : null;
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  // setFullYear avoids the 0-99 => 1900s mapping of the Date constructor.
  date.setFullYear(year);
  const valid =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return valid ? date : undefined;
}

export function toIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
