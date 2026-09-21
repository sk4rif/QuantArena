import { describe, expect, it } from "vitest";
import { formatMoney } from "./protocol";

describe("formatMoney", () => {
  it("shows ball denominations without floating-point artifacts", () => {
    expect(formatMoney(5_000_000)).toBe("$0.005");
    expect(formatMoney(10_000_000)).toBe("$0.010");
    expect(formatMoney(100_000_000)).toBe("$0.100");
    expect(formatMoney(5_000_000_000)).toBe("$5.00");
  });
});
