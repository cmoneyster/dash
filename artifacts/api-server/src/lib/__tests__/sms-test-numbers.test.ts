import { afterEach, describe, expect, it } from "vitest";
import { getSmsTestNumbers, isAllowedBySmsTestNumbers } from "../sms-test-numbers";

const ORIGINAL = process.env.SMS_TEST_NUMBERS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SMS_TEST_NUMBERS;
  else process.env.SMS_TEST_NUMBERS = ORIGINAL;
});

describe("SMS_TEST_NUMBERS allowlist", () => {
  it("allows every number when unset (production)", () => {
    delete process.env.SMS_TEST_NUMBERS;
    expect(getSmsTestNumbers()).toBeNull();
    expect(isAllowedBySmsTestNumbers("+1 (202) 555-0100")).toBe(true);
  });

  it("treats a blank value as unset", () => {
    process.env.SMS_TEST_NUMBERS = "   ";
    expect(getSmsTestNumbers()).toBeNull();
  });

  it("allows only listed numbers, matching any formatting", () => {
    process.env.SMS_TEST_NUMBERS = "(202) 555-0100, +1 301-555-0101";
    expect(isAllowedBySmsTestNumbers("2025550100")).toBe(true);
    expect(isAllowedBySmsTestNumbers("+12025550100")).toBe(true);
    expect(isAllowedBySmsTestNumbers("301.555.0101")).toBe(true);
    expect(isAllowedBySmsTestNumbers("2025550199")).toBe(false);
  });
});
