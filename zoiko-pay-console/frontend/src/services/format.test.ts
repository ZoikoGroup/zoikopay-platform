import { describe, expect, it } from "vitest";
import { formatMoney, minorToDecimalString, percentChangeMinor } from "./format";

describe("money formatting (no floating point)", () => {
  it("converts minor units to exact decimal strings", () => {
    expect(minorToDecimalString("123456", "GBP")).toBe("1234.56");
    expect(minorToDecimalString("5", "EUR")).toBe("0.05");
    expect(minorToDecimalString("0", "USD")).toBe("0.00");
    expect(minorToDecimalString("-1999", "GBP")).toBe("-19.99");
    expect(minorToDecimalString("1500", "JPY")).toBe("1500"); // zero-decimal currency
    expect(minorToDecimalString("1234", "BHD")).toBe("1.234"); // three-decimal currency
  });

  it("keeps precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(minorToDecimalString("900719925474099301", "GBP")).toBe("9007199254740993.01");
    expect(formatMoney("900719925474099301", "GBP")).toBe("£9,007,199,254,740,993.01");
  });

  it("rejects non-integer minor amounts", () => {
    expect(() => minorToDecimalString("12.5", "GBP")).toThrow();
    expect(() => minorToDecimalString("1e3", "GBP")).toThrow();
  });

  it("formats with the currency", () => {
    expect(formatMoney("1999", "GBP")).toBe("£19.99");
    expect(formatMoney("1999", "EUR", { withCode: true })).toMatch(/EUR\s?19\.99/);
  });

  it("computes money percentage change with integers", () => {
    expect(percentChangeMinor("1100", "1000")).toBe("+10.0%");
    expect(percentChangeMinor("900", "1000")).toBe("−10.0%");
    expect(percentChangeMinor("100", "0")).toBeNull();
  });
});
