import { describe, it, expect } from "vitest";
import { normalizeData } from "../src/gemini.js";

// normalizeData のテスト
describe("normalizeData", () => {
  it("全角数字・カンマ付き金額を数値化する", () => {
    const d = normalizeData({
      docType: "invoice",
      issuer: "架空テスト",
      registrationNumber: "T7000012050002",
      issueDate: "2026-09-01",
      dueDate: null,
      documentNumber: "INV-1",
      lineItems: [
        { name: "品A", quantity: "２", unitPrice: "１，０００", amount: "2,000円" },
      ],
      subtotal: "２，０００",
      taxBreakdown: [{ rate: 0.1, base: "2,000", tax: "２００" }],
      total: "￥2,200",
      currency: "JPY",
    });
    expect(d.lineItems[0].quantity).toBe(2);
    expect(d.lineItems[0].unitPrice).toBe(1000);
    expect(d.lineItems[0].amount).toBe(2000);
    expect(d.subtotal).toBe(2000);
    expect(d.taxBreakdown[0]).toEqual({ rate: 0.1, base: 2000, tax: 200 });
    expect(d.total).toBe(2200);
  });

  it("「なし」「記載なし」「-」「—」は null になる", () => {
    const d = normalizeData({
      docType: "invoice",
      issuer: "記載なし",
      registrationNumber: "なし",
      issueDate: "2026-09-01",
      dueDate: "-",
      documentNumber: "—",
      lineItems: [],
      subtotal: null,
      taxBreakdown: [],
      total: 100,
      currency: "JPY",
    });
    expect(d.issuer).toBeNull();
    expect(d.registrationNumber).toBeNull();
    expect(d.dueDate).toBeNull();
    expect(d.documentNumber).toBeNull();
  });

  it("余計なキーは無視し、欠落キーは既定値になる", () => {
    const d = normalizeData({
      docType: "receipt",
      issuer: "デモ商店",
      extraKey: "無視される",
      nested: { a: 1 },
      // issueDate/dueDate/documentNumber/subtotal/total を欠落させる
      lineItems: [{ name: "品", quantity: 1, unitPrice: 100, amount: 100, extra: 9 }],
      taxBreakdown: [],
    } as unknown as Record<string, unknown>);
    expect((d as unknown as Record<string, unknown>).extraKey).toBeUndefined();
    expect(d.issueDate).toBeNull();
    expect(d.dueDate).toBeNull();
    expect(d.documentNumber).toBeNull();
    expect(d.subtotal).toBeNull();
    expect(d.total).toBeNull();
    expect(d.currency).toBe("JPY");
    expect(d.lineItems[0]).toEqual({ name: "品", quantity: 1, unitPrice: 100, amount: 100 });
  });
});

describe("normalizeData: taxIncluded", () => {
  it("booleanはそのまま、それ以外(欠落・文字列)はnullにする", () => {
    expect(normalizeData({ taxIncluded: true }).taxIncluded).toBe(true);
    expect(normalizeData({ taxIncluded: false }).taxIncluded).toBe(false);
    expect(normalizeData({}).taxIncluded).toBeNull();
    expect(normalizeData({ taxIncluded: "税込" }).taxIncluded).toBeNull();
  });
});
