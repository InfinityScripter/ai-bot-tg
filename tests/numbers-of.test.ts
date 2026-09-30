import { it, expect, describe } from "vitest";

import { numbersOf } from "../src/llm/numbersOf.js";

describe("numbersOf", () => {
  it("reads a decimal comma and a decimal point as the same number", () => {
    expect(numbersOf("0,24 и 0.24")).toEqual(["0.24", "0.24"]);
  });

  it("drops trailing zeros of a fraction", () => {
    expect(numbersOf("$0.50 и $0.5 и 2.0")).toEqual(["0.5", "0.5", "2"]);
  });

  it("reads comma and space thousands separators as one number", () => {
    expect(numbersOf("1,000 запросов, 2 500 токенов, 1,250,000 строк")).toEqual([
      "1000",
      "2500",
      "1250000",
    ]);
  });

  it("does not glue a year to the next number", () => {
    expect(numbersOf("Итоги 2024 500 компаний")).toEqual(["2024", "500"]);
  });

  it("does not glue numbers from neighbouring lines", () => {
    expect(numbersOf("x5\n200$")).toEqual(["5", "200"]);
  });
});
