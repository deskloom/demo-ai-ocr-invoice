import { describe, it, expect } from "vitest";
import {
  validateBatch,
  validateOne,
  isValidDateString,
  isValidRegistrationNumber,
  makeFakeRegistrationNumber,
  breakRegistrationNumber,
} from "../src/validate.js";
import type { ExtractedDoc, InvoiceData } from "../src/types.js";

function base(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    docType: "invoice",
    issuer: "架空サンプル商事株式会社",
    registrationNumber: makeFakeRegistrationNumber("111111111111"),
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    documentNumber: "INV-TEST-001",
    lineItems: [
      { name: "品A", quantity: 2, unitPrice: 1000, amount: 2000 },
      { name: "品B", quantity: 3, unitPrice: 500, amount: 1500 },
    ],
    subtotal: 3500,
    taxBreakdown: [{ rate: 0.1, base: 3500, tax: 350 }],
    total: 3850,
    currency: "JPY",
    ...over,
  };
}

// 1. 正常系: きれいな書類は要確認にならない
describe("正常系", () => {
  it("正しい請求書はOK", () => {
    expect(validateOne(base())).toEqual([]);
  });
  it("領収書(品目なし・合計のみ)はOK", () => {
    const d = base({
      docType: "receipt",
      lineItems: [],
      subtotal: null,
      taxBreakdown: [],
      total: 5500,
      dueDate: null,
      registrationNumber: null,
    });
    expect(validateOne(d)).toEqual([]);
  });
  it("端数処理3種(切捨/四捨五入/切上)のいずれもOK", () => {
    // base=111, 10% -> 11.1: 切捨11, 四捨五入11, 切上12
    for (const tax of [11, 12]) {
      const d = base({
        lineItems: [{ name: "端数", quantity: 1, unitPrice: 111, amount: 111 }],
        subtotal: 111,
        taxBreakdown: [{ rate: 0.1, base: 111, tax }],
        total: 111 + tax,
      });
      expect(validateOne(d)).toEqual([]);
    }
  });
});

// 2. チェック1: 数量×単価=金額
describe("チェック1 品目計算", () => {
  it("異常: 金額が違う行があると要確認", () => {
    const reasons = validateOne(
      base({ lineItems: [{ name: "品A", quantity: 2, unitPrice: 1000, amount: 2001 }] }),
    );
    expect(reasons.some((r) => r.startsWith("line-math"))).toBe(true);
  });
});

// 3. チェック2: 品目合計=小計
describe("チェック2 小計", () => {
  it("異常: 小計が合わないと要確認", () => {
    const reasons = validateOne(base({ subtotal: 3501 }));
    expect(reasons.some((r) => r.startsWith("subtotal"))).toBe(true);
  });
});

// 4. チェック3: 税額=対象額×税率(端数処理のいずれか)
describe("チェック3 税額", () => {
  it("異常: 税額が候補のいずれとも違うと要確認", () => {
    const d = base({
      lineItems: [{ name: "品", quantity: 1, unitPrice: 10000, amount: 10000 }],
      subtotal: 10000,
      taxBreakdown: [{ rate: 0.1, base: 10000, tax: 1001 }], // 正しくは1000
      total: 11001,
    });
    expect(validateOne(d).some((r) => r.startsWith("tax"))).toBe(true);
  });
});

// 5. チェック4: 小計+税=合計
describe("チェック4 合計", () => {
  it("異常: 合計が合わないと要確認", () => {
    expect(
      validateOne(base({ total: 3851 })).some((r) => r.startsWith("total")),
    ).toBe(true);
  });
});

// 6. チェック5: 登録番号
describe("チェック5 登録番号", () => {
  it("形式不正(Tなし/桁不足)は要確認", () => {
    expect(
      validateOne(base({ registrationNumber: "123" })).some((r) =>
        r.includes("registrationNumber"),
      ),
    ).toBe(true);
  });
  it("チェックデジット不正は要確認", () => {
    const valid = makeFakeRegistrationNumber("222222222222");
    expect(isValidRegistrationNumber(valid)).toBe(true);
    const broken = breakRegistrationNumber(valid);
    expect(isValidRegistrationNumber(broken)).toBe(false);
    expect(
      validateOne(base({ registrationNumber: broken })).some((r) =>
        r.includes("チェックデジット"),
      ),
    ).toBe(true);
  });
  it("nullはOK(記載なし扱い)", () => {
    expect(validateOne(base({ registrationNumber: null }))).toEqual([]);
  });
});

// 7. チェック6: 日付
describe("チェック6 日付", () => {
  it("実在しない日付は要確認", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-09-01")).toBe(true);
    expect(
      validateOne(base({ issueDate: "2026-02-30" })).some((r) =>
        r.includes("date"),
      ),
    ).toBe(true);
  });
  it("支払期限<発行日は要確認", () => {
    expect(
      validateOne(base({ issueDate: "2026-09-20", dueDate: "2026-09-01" })).some(
        (r) => r.includes("支払期限が発行日より前"),
      ),
    ).toBe(true);
  });
});

// 8. チェック7: 必須項目
describe("チェック7 必須項目", () => {
  it("発行元・日付・合計の欠落は要確認", () => {
    expect(
      validateOne(base({ issuer: null })).some((r) => r.startsWith("missing")),
    ).toBe(true);
    expect(
      validateOne(base({ issueDate: null })).some((r) => r.startsWith("missing")),
    ).toBe(true);
    expect(
      validateOne(base({ total: null })).some((r) => r.startsWith("missing")),
    ).toBe(true);
  });
});

// 9. チェック8: 二重登録
describe("チェック8 二重登録", () => {
  it("同一(発行元+番号+合計)は2件目が要確認、1件目はOK", () => {
    const docs: ExtractedDoc[] = [
      { file: "a.pdf", data: base() },
      { file: "b.pdf", data: base() },
    ];
    const out = validateBatch(docs);
    expect(out[0].validation.needsReview).toBe(false);
    expect(out[1].validation.needsReview).toBe(true);
    expect(out[1].validation.reasons.some((r) => r.startsWith("duplicate"))).toBe(true);
  });
  it("番号が違えば重複にならない", () => {
    const docs: ExtractedDoc[] = [
      { file: "a.pdf", data: base({ documentNumber: "INV-1" }) },
      { file: "b.pdf", data: base({ documentNumber: "INV-2" }) },
    ];
    expect(validateBatch(docs).every((d) => !d.validation.needsReview)).toBe(true);
  });
});
