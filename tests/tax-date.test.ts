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

// 税・日付の境界テスト
describe("税の境界", () => {
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

describe("日付の境界", () => {
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

// 税込表示の書類: 対象額・小計・合計が税込で、税額は内数(税額 = 対象額×率/(1+率))
describe("税込表示 (taxIncluded)", () => {
  const incl = (over: Partial<InvoiceData> = {}) =>
    base({
      lineItems: [{ name: "品A", quantity: 1, unitPrice: 1100, amount: 1100 }],
      subtotal: 1100,
      taxBreakdown: [{ rate: 0.1, base: 1100, tax: 100 }],
      total: 1100,
      taxIncluded: true,
      ...over,
    });

  it("税込1100円・内税100円・合計1100円はOK(税を足さない)", () => {
    expect(validateOne(incl())).toEqual([]);
  });

  it("同じ数値でも税込と分からなければ(null)従来どおり要確認になる", () => {
    const r = validateOne(incl({ taxIncluded: null }));
    // 税抜として検証されるので、税額(内税100≠1100×10%)と合計(1100+100≠1100)の両方が要確認になる
    expect(r.some((x) => x.startsWith("tax"))).toBe(true);
    expect(r.some((x) => x.startsWith("total"))).toBe(true);
  });

  it("端数: 税込1234円×8% → 1234×0.08/1.08=91.41 → 91(切捨・四捨五入)と92(切上)は許容、90は要確認", () => {
    for (const tax of [91, 92]) {
      const d = incl({
        lineItems: [{ name: "端数", quantity: 1, unitPrice: 1234, amount: 1234 }],
        subtotal: 1234,
        taxBreakdown: [{ rate: 0.08, base: 1234, tax }],
        total: 1234,
      });
      expect(validateOne(d)).toEqual([]);
    }
    const bad = incl({
      lineItems: [{ name: "端数", quantity: 1, unitPrice: 1234, amount: 1234 }],
      subtotal: 1234,
      taxBreakdown: [{ rate: 0.08, base: 1234, tax: 90 }],
      total: 1234,
    });
    expect(validateOne(bad).some((r) => r.startsWith("tax"))).toBe(true);
  });

  it("税込表示で合計が小計と違えば要確認(税を足した値でもOKにならない)", () => {
    const r = validateOne(incl({ total: 1200 }));
    expect(r.some((x) => x.startsWith("total"))).toBe(true);
  });

  it("税抜表示(false)の判定は従来どおり: 小計+税=合計", () => {
    const d = base({ taxIncluded: false });
    expect(validateOne(d)).toEqual([]);
    expect(validateOne(base({ taxIncluded: false, total: 1000 })).some((r) => r.startsWith("total"))).toBe(true);
  });
});
