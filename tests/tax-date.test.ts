import { describe, it, expect } from "vitest";
import { validateOne, isValidDateString, makeFakeRegistrationNumber } from "../src/validate.js";
import type { InvoiceData } from "../src/types.js";

function base(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    docType: "invoice",
    issuer: "架空テスト商事",
    registrationNumber: makeFakeRegistrationNumber("120345678901"),
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    documentNumber: "INV-TAX-1",
    lineItems: [{ name: "品A", quantity: 1, unitPrice: 1000, amount: 1000 }],
    subtotal: 1000,
    taxBreakdown: [{ rate: 0.1, base: 1000, tax: 100 }],
    total: 1100,
    currency: "JPY",
    ...over,
  };
}

// FIX14: 税・日付の境界テスト
describe("税の境界 (FIX14)", () => {
  it("8%のみがOKになる", () => {
    const d = base({
      lineItems: [{ name: "弁当", quantity: 5, unitPrice: 600, amount: 3000 }],
      subtotal: 3000,
      taxBreakdown: [{ rate: 0.08, base: 3000, tax: 240 }],
      total: 3240,
    });
    expect(validateOne(d)).toEqual([]);
  });

  it("8%/10%混在がOKになる", () => {
    const d = base({
      lineItems: [
        { name: "弁当8%", quantity: 1, unitPrice: 1000, amount: 1000 },
        { name: "文具10%", quantity: 1, unitPrice: 2000, amount: 2000 },
      ],
      subtotal: 3000,
      taxBreakdown: [
        { rate: 0.08, base: 1000, tax: 80 },
        { rate: 0.1, base: 2000, tax: 200 },
      ],
      total: 3280,
    });
    expect(validateOne(d)).toEqual([]);
  });

  it("端数境界: 対象額1234×8%=98.72 → 98/99どちらも許容、97は要確認", () => {
    // 1234*0.08 = 98.72。切捨98・四捨五入99・切上99 のいずれかと一致すればOK
    for (const tax of [98, 99]) {
      const d = base({
        lineItems: [{ name: "端数", quantity: 1, unitPrice: 1234, amount: 1234 }],
        subtotal: 1234,
        taxBreakdown: [{ rate: 0.08, base: 1234, tax }],
        total: 1234 + tax,
      });
      expect(validateOne(d)).toEqual([]);
    }
    const bad = base({
      lineItems: [{ name: "端数", quantity: 1, unitPrice: 1234, amount: 1234 }],
      subtotal: 1234,
      taxBreakdown: [{ rate: 0.08, base: 1234, tax: 97 }],
      total: 1234 + 97,
    });
    expect(bad && validateOne(bad).some((r) => r.startsWith("tax"))).toBe(true);
  });
});

describe("日付の境界 (FIX14)", () => {
  it("4/31・13月は実在しない", () => {
    expect(isValidDateString("2026-04-31")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(validateOne(base({ issueDate: "2026-04-31" })).some((r) => r.includes("date"))).toBe(true);
  });

  it("うるう年2/29は有効、平年2/29は無効", () => {
    expect(isValidDateString("2024-02-29")).toBe(true); // うるう年
    expect(isValidDateString("2025-02-29")).toBe(false); // 平年
    expect(validateOne(base({ issueDate: "2024-02-29", dueDate: "2024-03-31" }))).toEqual([]);
    expect(
      validateOne(base({ issueDate: "2025-02-29" })).some((r) => r.includes("date")),
    ).toBe(true);
  });
});
