import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseIsoDate, toIsoDate } from "../src/lib/date";
import { formatDate } from "../src/lib/format";

describe("parseIsoDate / toIsoDate", () => {
  it("round-trips a calendar date", () => {
    const date = parseIsoDate("2026-09-05");
    assert.ok(date);
    assert.equal(toIsoDate(date), "2026-09-05");
    assert.equal(date.getDate(), 5);
  });

  it("never shifts the calendar day across timezones (UTC-11 to UTC+14)", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["Pacific/Pago_Pago", "America/Los_Angeles", "UTC", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        for (const iso of ["2026-01-01", "2026-03-08", "2026-11-01", "2026-12-31", "2028-02-29"]) {
          const date = parseIsoDate(iso);
          assert.ok(date, `${iso} in ${tz}`);
          assert.equal(toIsoDate(date), iso, `${iso} in ${tz}`);
        }
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("displays the same calendar day it was given", () => {
    assert.equal(formatDate("2026-12-31", "en-US"), "Dec 31, 2026");
    assert.equal(formatDate("2028-02-29", "en-US"), "Feb 29, 2028");
  });

  it("rejects malformed or non-existent dates", () => {
    for (const input of ["", "2026-2-3", "2026/02/03", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2027-02-29", "abcd-ef-gh", " 2026-01-01"]) {
      assert.equal(parseIsoDate(input), undefined, JSON.stringify(input));
    }
    assert.equal(parseIsoDate(undefined), undefined);
    assert.equal(parseIsoDate(null), undefined);
  });

  it("accepts a leap day only in leap years", () => {
    assert.ok(parseIsoDate("2028-02-29"));
    assert.equal(parseIsoDate("2026-02-29"), undefined);
  });
});
