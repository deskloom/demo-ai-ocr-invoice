import { describe, it, expect } from "vitest";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { runCli } from "../src/cli.js";
import { StubExtractor } from "../src/gemini.js";
import type { InvoiceData } from "../src/types.js";

function data(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    docType: "invoice",
    issuer: "架空サンプル商事株式会社",
    registrationNumber: null,
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    documentNumber: "DOC-A",
    lineItems: [{ name: "品A", quantity: 1, unitPrice: 1000, amount: 1000 }],
    subtotal: 1000,
    taxBreakdown: [{ rate: 0.1, base: 1000, tax: 100 }],
    total: 1100,
    currency: "JPY",
    ...over,
  };
}

describe("CLI(偽AI応答・Geminiを呼ばない)", () => {
  it("--out の拡張子で xlsx/csv を保存できる", async () => {
    const stub = new StubExtractor({ "*": data() });
    await mkdir("out", { recursive: true });
    await writeFile("out/_t-a.pdf", "%PDF-1.4 dummy");
    await runCli(["node", "cli", "out/_t-a.pdf", "--out", "out/_t-result.xlsx"], () => stub);
    const xlsx = await readFile("out/_t-result.xlsx");
    expect(xlsx.length).toBeGreaterThan(1000);
    await runCli(["node", "cli", "out/_t-a.pdf", "--out", "out/_t-result.csv"], () => stub);
    const csv = await readFile("out/_t-result.csv", "utf-8");
    // 列単位で比較する（FIX15）
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
    const header = lines[0].split(",");
    const flagIdx = header.indexOf("needsReview");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(header).toContain("needsReview");
    expect(lines[1].split(",")[flagIdx]).toBe("OK");
    await rm("out/_t-a.pdf");
    await rm("out/_t-result.xlsx");
    await rm("out/_t-result.csv");
  });

  it("要確認の書類は要確認と出力される", async () => {
    const stub = new StubExtractor({ "*": data({ total: 9999 }) });
    await mkdir("out", { recursive: true });
    await writeFile("out/_t-b.pdf", "%PDF-1.4 dummy");
    await runCli(["node", "cli", "out/_t-b.pdf", "--out", "out/_t-b.csv"], () => stub);
    const csv = await readFile("out/_t-b.csv", "utf-8");
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
    const flagIdx = lines[0].split(",").indexOf("needsReview");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(lines[1].split(",")[flagIdx]).toBe("要確認");
    await rm("out/_t-b.pdf");
    await rm("out/_t-b.csv");
  });
});
