import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { validateBatch } from "../src/validate.js";
import { toCsv, toExcelBuffer, summaryRows } from "../src/export.js";
import { SUMMARY_COLUMNS } from "../src/types.js";
import { makeFakeRegistrationNumber } from "../src/validate.js";
import type { CheckedDoc, ExtractedDoc } from "../src/types.js";

function docs(): CheckedDoc[] {
  const reg = makeFakeRegistrationNumber("111111111111");
  const extracted: ExtractedDoc[] = [
    {
      file: "ok.pdf",
      data: {
        docType: "invoice",
        issuer: "架空サンプル商事株式会社",
        registrationNumber: reg,
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
        documentNumber: "INV-1",
        lineItems: [{ name: "品A", quantity: 2, unitPrice: 1000, amount: 2000 }],
        subtotal: 2000,
        taxBreakdown: [{ rate: 0.1, base: 2000, tax: 200 }],
        total: 2200,
        currency: "JPY",
      },
    },
    {
      file: "bad.pdf",
      data: {
        docType: "invoice",
        issuer: "架空サンプル商事株式会社",
        registrationNumber: reg,
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
        documentNumber: "INV-2",
        lineItems: [{ name: "品A", quantity: 2, unitPrice: 1000, amount: 2001 }],
        subtotal: 2000,
        taxBreakdown: [{ rate: 0.1, base: 2000, tax: 200 }],
        total: 2200,
        currency: "JPY",
      },
    },
  ];
  return validateBatch(extracted);
}

describe("CSV出力", () => {
  it("ヘッダ列がSUMMARY_COLUMNSと一致し、値を読み戻せる", () => {
    const csv = toCsv(docs());
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
    expect(lines[0].split(",")).toEqual([...SUMMARY_COLUMNS]);
    expect(lines).toHaveLength(3); // ヘッダ+2行
    // 要確認フラグは列単位で比較する
    const header = lines[0].split(",");
    const flagIdx = header.indexOf("needsReview");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(lines[1].split(",")[flagIdx]).toBe("OK");
    expect(lines[2].split(",")[flagIdx]).toBe("要確認");
    // 理由列にline-mathが含まれる
    const reasonIdx = header.indexOf("reasons");
    expect(lines[2].split(",")[reasonIdx]).toContain("line-math");
  });

  it("カンマ・ダブルクォートを含む値はエスケープされる", () => {
    const d = docs();
    d[0].data.issuer = '架空,サンプル"商事"株式会社';
    const csv = toCsv(d);
    expect(csv).toContain('"架空,サンプル""商事""株式会社"');
  });
});

describe("Excel出力", () => {
  it("一覧シートの列・値・要確認フラグを読み戻せる", async () => {
    const checked = docs();
    const buf = await toExcelBuffer(checked);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const ws = wb.getWorksheet("一覧");
    expect(ws).toBeDefined();
    const header = ws!.getRow(1).values as unknown[];
    // ExcelJSのvaluesは1始まり(0番目は空)なのでslice(1)
    expect((header as unknown[]).slice(1)).toEqual([...SUMMARY_COLUMNS]);
    expect(ws!.rowCount).toBe(3); // ヘッダ+2行
    const row2 = ws!.getRow(2);
    // 読戻後は列キー("file"等)が残らないため列番号で参照
    // SUMMARY_COLUMNS順: file=1, ..., needsReview=13, reasons=14
    expect(row2.getCell(1).value).toBe("ok.pdf");
    expect(row2.getCell(13).value).toBe("OK");
    const row3 = ws!.getRow(3);
    expect(row3.getCell(1).value).toBe("bad.pdf");
    expect(row3.getCell(13).value).toBe("要確認");
    expect(String(row3.getCell(14).value)).toContain("line-math");
    // 明細シートに品目行がある
    const detail = wb.getWorksheet("明細");
    expect(detail).toBeDefined();
    expect(detail!.rowCount).toBe(3); // ヘッダ+品目2行
  });
});

describe("summaryRows", () => {
  it("taxTotalは税額合計になる", () => {
    const rows = summaryRows(docs());
    expect(rows[0].taxTotal).toBe(200);
    expect(rows[0].total).toBe(2200);
  });
});
