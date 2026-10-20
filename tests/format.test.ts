import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { formatDate, formatMinorUnits, getFractionDigits, minorToDecimalString } from "../src/lib/format";

// Intl uses non-breaking spaces between some symbols and digits; normalise for stable assertions.
const plain = (value: string) => value.replace(/[  ]/g, " ");

describe("getFractionDigits", () => {
  it("is currency-aware: USD 2, JPY 0, KWD 3", () => {
    assert.equal(getFractionDigits("USD", "en-US"), 2);
    assert.equal(getFractionDigits("JPY", "en-US"), 0);
    assert.equal(getFractionDigits("KWD", "en-US"), 3);
  });
});

describe("minorToDecimalString", () => {
  it("inserts the decimal point by string manipulation", () => {
    assert.equal(minorToDecimalString(BigInt(12345), 2), "123.45");
    assert.equal(minorToDecimalString(BigInt(12345), 0), "12345");
    assert.equal(minorToDecimalString(BigInt(12345), 3), "12.345");
  });

  it("pads small values", () => {
    assert.equal(minorToDecimalString(BigInt(5), 2), "0.05");
    assert.equal(minorToDecimalString(BigInt(1), 3), "0.001");
  });

  it("handles zero and negatives", () => {
    assert.equal(minorToDecimalString(BigInt(0), 2), "0.00");
    assert.equal(minorToDecimalString(BigInt(0), 0), "0");
    assert.equal(minorToDecimalString(BigInt(-5), 2), "-0.05");
    assert.equal(minorToDecimalString(BigInt(-123456), 2), "-1234.56");
  });
});

describe("formatMinorUnits", () => {
  it("formats USD with 2 decimal places", () => {
    assert.equal(formatMinorUnits(BigInt(125000), { locale: "en-US", currency: "USD" }), "$1,250.00");
    assert.equal(formatMinorUnits(BigInt(5), { locale: "en-US", currency: "USD" }), "$0.05");
  });

  it("formats JPY with 0 decimal places (minor unit equals major unit)", () => {
    assert.equal(plain(formatMinorUnits(BigInt(1250), { locale: "en-US", currency: "JPY" })), "¥1,250");
  });

  it("formats KWD with 3 decimal places", () => {
    assert.equal(plain(formatMinorUnits(BigInt(1250500), { locale: "en-US", currency: "KWD" })), "KWD 1,250.500");
    assert.equal(plain(formatMinorUnits(BigInt(1), { locale: "en-US", currency: "KWD" })), "KWD 0.001");
  });

  it("formats zero", () => {
    assert.equal(formatMinorUnits(BigInt(0), { locale: "en-US", currency: "USD" }), "$0.00");
    assert.equal(plain(formatMinorUnits(BigInt(0), { locale: "en-US", currency: "JPY" })), "¥0");
  });

  it("formats negative amounts with a sign", () => {
    assert.equal(formatMinorUnits(BigInt(-4500), { locale: "en-US", currency: "USD" }), "-$45.00");
    assert.equal(
      formatMinorUnits(BigInt(-4500), { locale: "en-US", currency: "USD", signDisplay: "never" }),
      "$45.00",
    );
  });

  it("formats large integers exactly, beyond Number.MAX_SAFE_INTEGER", () => {
    assert.equal(
      formatMinorUnits(BigInt("9007199254740993"), { locale: "en-US", currency: "USD" }),
      "$90,071,992,547,409.93",
    );
    assert.equal(
      formatMinorUnits(BigInt("123456789012345678901234567890"), { locale: "en-US", currency: "USD" }),
      "$1,234,567,890,123,456,789,012,345,678.90",
    );
  });

  it("rejects an invalid currency code", () => {
    assert.throws(() => formatMinorUnits(BigInt(1), { locale: "en-US", currency: "XXXX" }), RangeError);
    assert.throws(() => formatMinorUnits(BigInt(1), { locale: "en-US", currency: "" }), RangeError);
  });
});

describe("formatDate", () => {
  it("renders a calendar date without shifting the day", () => {
    assert.equal(formatDate("2026-09-05", "en-US"), "Sep 5, 2026");
  });

  it("throws on a malformed date", () => {
    assert.throws(() => formatDate("not-a-date"), RangeError);
  });
});
