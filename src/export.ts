import ExcelJS from "exceljs";
import type { CheckedDoc } from "./types.js";
import { SUMMARY_COLUMNS } from "./types.js";

function escCsv(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function summaryRows(docs: CheckedDoc[]): Record<string, unknown>[] {
  return docs.map((d) => ({
    file: d.file,
    docType: d.data.docType,
    issuer: d.data.issuer ?? "",
    registrationNumber: d.data.registrationNumber ?? "",
    issueDate: d.data.issueDate ?? "",
    dueDate: d.data.dueDate ?? "",
    documentNumber: d.data.documentNumber ?? "",
    lineCount: d.data.lineItems.length,
    subtotal: d.data.subtotal ?? "",
    taxTotal: d.taxTotal,
    total: d.data.total ?? "",
    currency: d.data.currency,
    needsReview: d.validation.needsReview ? "要確認" : "OK",
    reasons: d.validation.reasons.join(" / "),
  }));
}

export function toCsv(docs: CheckedDoc[]): string {
  const rows = summaryRows(docs);
  // Excelで文字化けしないようBOM付き
  const header = [...SUMMARY_COLUMNS].join(",");
  const lines = rows.map((r) =>
    [...SUMMARY_COLUMNS].map((c) => escCsv(r[c])).join(","),
  );
  return `﻿${header}\n${lines.join("\n")}\n`;
}

export async function toExcelBuffer(docs: CheckedDoc[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "demo-ai-ocr-invoice";
  const ws = wb.addWorksheet("一覧");
  ws.columns = [...SUMMARY_COLUMNS].map((c) => ({ header: c, key: c, width: 18 }));
  for (const r of summaryRows(docs)) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  // 要確認の行を薄赤に
  ws.eachRow((row, n) => {
    if (n === 1) return;
    if (row.getCell("needsReview").value === "要確認") {
      row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFD9D9" },
      };
    }
  });

  const detail = wb.addWorksheet("明細");
  detail.columns = [
    { header: "file", key: "file", width: 22 },
    { header: "name", key: "name", width: 30 },
    { header: "quantity", key: "quantity", width: 12 },
    { header: "unitPrice", key: "unitPrice", width: 12 },
    { header: "amount", key: "amount", width: 12 },
  ];
  detail.getRow(1).font = { bold: true };
  for (const d of docs) {
    for (const li of d.data.lineItems) {
      detail.addRow({
        file: d.file,
        name: li.name,
        quantity: li.quantity ?? "",
        unitPrice: li.unitPrice ?? "",
        amount: li.amount ?? "",
      });
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
