/**
 * 架空サンプル書類の生成スクリプト。
 * 使い方: npm run make-samples
 * - samples/ に PDF/PNG/JPG を14件、samples/expected/ に正解JSONを置く。
 * - すべて架空の会社・人物・番号。実在のものは使わない。
 * - 日本語フォント: Noto Sans JP (OFL) を assets/fonts/ に取得して使う。
 *   取得できない場合は英数字(ローマ字)フォールバックで生成する。
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { createWriteStream } from "node:fs";
import { corporateCheckDigit } from "../src/validate.js";
import type { InvoiceData } from "../src/types.js";

const SAMPLES = "samples";
const EXPECTED = path.join(SAMPLES, "expected");
const FONTS = "assets/fonts";

function fakeReg(seed12: string): string {
  return `T${corporateCheckDigit(seed12)}${seed12}`;
}
function breakReg(valid: string): string {
  const brokenCheck = valid[1] === "9" ? "8" : "9";
  return `T${brokenCheck}${valid.slice(2)}`;
}

const REG_A = fakeReg("111111111111");
const REG_B = fakeReg("222222222222");
const REG_C = fakeReg("333333333333");
const REG_D = fakeReg("444444444444");
const REG_BAD = breakReg(fakeReg("555555555555"));

interface ItemSpec {
  name: string;
  qty: number;
  price: number;
  rate: number; // 0.1 | 0.08
}

function sums(items: ItemSpec[]) {
  const lines = items.map((it) => ({
    name: it.name,
    quantity: it.qty,
    unitPrice: it.price,
    amount: it.qty * it.price,
  }));
  const subtotal = lines.reduce((a, b) => a + (b.amount ?? 0), 0);
  const byRate = new Map<number, number>();
  for (const it of items) {
    byRate.set(it.rate, (byRate.get(it.rate) ?? 0) + it.qty * it.price);
  }
  const taxBreakdown = [...byRate.entries()].map(([rate, base]) => ({
    rate,
    base,
    tax: Math.floor(base * rate), // 切り捨てで統一(検証は3種の端数処理を許容)
  }));
  const taxTotal = taxBreakdown.reduce((a, b) => a + b.tax, 0);
  return { lines, subtotal, taxBreakdown, total: subtotal + taxTotal };
}

async function ensureFont(): Promise<string | null> {
  const candidates = [
    path.join(FONTS, "NotoSansJP-Regular.otf"),
    path.join(FONTS, "NotoSansJP-Regular.ttf"),
    path.join(FONTS, "IPAexGothic.ttf"),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch { /* next */ }
  }
  // ダウンロードを試す (Noto Sans JP / OFL)
  await mkdir(FONTS, { recursive: true });
  const urls = [
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf",
  ];
  for (const url of urls) {
    try {
      console.log(`フォントを取得します: ${url}`);
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100_000) continue; // 明らかに壊れている
      const dest = path.join(FONTS, "NotoSansJP-Regular.otf");
      await writeFile(dest, buf);
      console.log(`フォント保存: ${dest}`);
      return dest;
    } catch (e) {
      console.log(`フォント取得失敗: ${String(e)}`);
    }
  }
  console.log("日本語フォントが無いためローマ字フォールバックで生成します");
  return null;
}

function drawPdf(
  outPath: string,
  opts: {
    title: string;
    issuer: string;
    reg: string | null;
    issueDate: string;
    dueDate: string | null;
    docNo: string;
    items: { name: string; quantity: number; unitPrice: number; amount: number }[];
    subtotal: number | null;
    taxBreakdown: { rate: number; base: number; tax: number }[];
    total: number | null;
    note?: string;
  },
  fontPath: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = createWriteStream(outPath);
    doc.pipe(stream);
    if (fontPath) {
      try {
        doc.registerFont("jp", fontPath);
        doc.font("jp");
      } catch {
        doc.font("Helvetica");
      }
    } else {
      doc.font("Helvetica");
    }
    const yen = (n: number | null) =>
      n === null ? "-" : `${n.toLocaleString("ja-JP")} 円`;
    doc.fontSize(20).text(opts.title, { align: "center" });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`発行元: ${opts.issuer || "(記載なし)"}`);
    doc.text(`登録番号: ${opts.reg ?? "(なし)"}`);
    doc.text(`発行日: ${opts.issueDate}`);
    doc.text(`支払期限: ${opts.dueDate ?? "-"}`);
    doc.text(`書類番号: ${opts.docNo}`);
    doc.moveDown();
    doc.text("【品目】");
    for (const li of opts.items) {
      doc.text(
        `・${li.name}  数量${li.quantity} × 単価${li.unitPrice.toLocaleString("ja-JP")} = ${li.amount.toLocaleString("ja-JP")}円`,
      );
    }
    if (opts.items.length === 0) doc.text("(品目の記載なし・合計のみ)");
    doc.moveDown();
    doc.text(`小計: ${yen(opts.subtotal)}`);
    for (const t of opts.taxBreakdown) {
      doc.text(
        `消費税 ${Math.round(t.rate * 100)}%: 対象額 ${t.base.toLocaleString("ja-JP")}円 / 税額 ${t.tax.toLocaleString("ja-JP")}円`,
      );
    }
    doc.fontSize(14).text(`合計: ${yen(opts.total)}`);
    if (opts.note) {
      doc.moveDown();
      doc.fontSize(10).text(opts.note);
    }
    doc.moveDown();
    doc.fontSize(9).text("※ 本書類はデモ用の架空サンプルです。実在の企業・人物とは関係ありません。");
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

function svgInvoice(opts: {
  title: string;
  issuer: string;
  reg: string;
  issueDate: string;
  docNo: string;
  total: number;
}): Buffer {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
<rect width="1200" height="800" fill="white"/>
<text x="600" y="90" font-size="52" text-anchor="middle" font-family="sans-serif">${esc(opts.title)}</text>
<text x="80" y="200" font-size="34" font-family="sans-serif">発行元: ${esc(opts.issuer)}</text>
<text x="80" y="260" font-size="34" font-family="sans-serif">登録番号: ${esc(opts.reg)}</text>
<text x="80" y="320" font-size="34" font-family="sans-serif">発行日: ${esc(opts.issueDate)}</text>
<text x="80" y="380" font-size="34" font-family="sans-serif">書類番号: ${esc(opts.docNo)}</text>
<text x="80" y="480" font-size="44" font-family="sans-serif">合計: ${opts.total.toLocaleString("ja-JP")} 円</text>
<text x="80" y="560" font-size="26" fill="#555" font-family="sans-serif">※デモ用架空サンプル</text>
</svg>`;
  return Buffer.from(svg, "utf-8");
}

async function main(): Promise<void> {
  await mkdir(SAMPLES, { recursive: true });
  await mkdir(EXPECTED, { recursive: true });
  const fontPath = await ensureFont();
  const useJa = fontPath !== null;
  // フォントが無い場合のローマ字表記
  const T = (ja: string, roma: string) => (useJa ? ja : roma);

  interface Plan {
    file: string;
    kind: "pdf" | "png" | "jpg";
    title: string;
    issuer: string;
    reg: string | null;
    issueDate: string;
    dueDate: string | null;
    docNo: string;
    docType: InvoiceData["docType"];
    items: ItemSpec[];
    corrupt?: "math" | "tax" | "none";
    note?: string;
    needsReview: boolean;
    tiltScan?: boolean;
  }

  const manyItems: ItemSpec[] = Array.from({ length: 16 }, (_, i) => ({
    name: T(`デモ文具セット${String(i + 1).padStart(2, "0")}`, `Demo item ${i + 1}`),
    qty: (i % 4) + 1,
    price: 500 + i * 100,
    rate: 0.1,
  }));

  const plans: Plan[] = [
    {
      file: "inv-01-clean-10pct.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("架空サンプル商事株式会社", "Kaku Sample Shouji K.K."),
      reg: REG_A, issueDate: "2026-09-01", dueDate: "2026-09-30", docNo: "INV-2026-0001",
      docType: "invoice",
      items: [
        { name: T("デモ用ノートA4", "Demo notebook A4"), qty: 10, price: 220, rate: 0.1 },
        { name: T("デモ用ペン黒12本入", "Demo pen black 12pcs"), qty: 3, price: 880, rate: 0.1 },
        { name: T("コピー用紙500枚", "Copy paper 500sheets"), qty: 5, price: 550, rate: 0.1 },
      ],
      needsReview: false,
    },
    {
      file: "inv-02-mixed-8-10.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("見本フーズ株式会社", "Mihon Foods K.K."),
      reg: REG_B, issueDate: "2026-09-05", dueDate: "2026-10-05", docNo: "INV-2026-0002",
      docType: "invoice",
      items: [
        { name: T("デモ弁当(軽減8%)", "Demo bento 8pct"), qty: 20, price: 600, rate: 0.08 },
        { name: T("デモ茶ペットボトル(軽減8%)", "Demo tea PET 8pct"), qty: 30, price: 150, rate: 0.08 },
        { name: T("配達料", "Delivery fee"), qty: 1, price: 2000, rate: 0.1 },
      ],
      needsReview: false,
    },
    {
      file: "inv-03-many-lines.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("テスト文具卸株式会社", "Test Bungoroshi K.K."),
      reg: REG_C, issueDate: "2026-09-10", dueDate: "2026-10-10", docNo: "INV-2026-0003",
      docType: "invoice", items: manyItems, needsReview: false,
    },
    {
      file: "rcp-01-simple.pdf", kind: "pdf",
      title: T("領 収 書", "RECEIPT"), issuer: T("デモ商店", "Demo Shoten"),
      reg: null, issueDate: "2026-09-12", dueDate: null, docNo: "RCP-2026-0001",
      docType: "receipt", items: [], needsReview: false,
    },
    {
      file: "inv-04-image.png", kind: "png",
      title: T("請求書", "INVOICE"), issuer: T("架空サンプル商事株式会社", "Kaku Sample Shouji K.K."),
      reg: REG_A, issueDate: "2026-09-01", dueDate: "2026-09-30", docNo: "INV-2026-0004",
      docType: "invoice",
      items: [{ name: T("デモ用ノートA4", "Demo notebook A4"), qty: 5, price: 220, rate: 0.1 }],
      needsReview: false,
    },
    {
      file: "inv-05-scan-tilt.jpg", kind: "jpg",
      title: T("請求書", "INVOICE"), issuer: T("見本フーズ株式会社", "Mihon Foods K.K."),
      reg: REG_B, issueDate: "2026-09-05", dueDate: "2026-10-05", docNo: "INV-2026-0005",
      docType: "invoice",
      items: [{ name: T("デモ弁当(軽減8%)", "Demo bento 8pct"), qty: 10, price: 600, rate: 0.08 }],
      needsReview: false, tiltScan: true,
    },
    {
      file: "inv-06-bad-math.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("架空サンプル商事株式会社", "Kaku Sample Shouji K.K."),
      reg: REG_A, issueDate: "2026-09-15", dueDate: "2026-10-15", docNo: "INV-2026-0006",
      docType: "invoice",
      items: [
        { name: T("デモ用ノートA4", "Demo notebook A4"), qty: 10, price: 220, rate: 0.1 },
        { name: T("デモ用ペン黒12本入", "Demo pen black 12pcs"), qty: 3, price: 880, rate: 0.1 },
      ],
      corrupt: "math", needsReview: true,
      note: "※この書類はわざと金額を間違えてある(デモ用)。",
    },
    {
      file: "inv-07-bad-reg.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("見本物流株式会社", "Mihon Butsuryu K.K."),
      reg: REG_BAD, issueDate: "2026-09-16", dueDate: "2026-10-16", docNo: "INV-2026-0007",
      docType: "invoice",
      items: [{ name: T("配送費", "Delivery"), qty: 2, price: 5000, rate: 0.1 }],
      needsReview: true, note: "※登録番号のチェックデジットがわざと間違えてある(デモ用)。",
    },
    {
      file: "inv-08-bad-date.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("テスト文具卸株式会社", "Test Bungoroshi K.K."),
      reg: REG_C, issueDate: "2026-09-20", dueDate: "2026-09-01", docNo: "INV-2026-0008",
      docType: "invoice",
      items: [{ name: T("デモ用ノートA4", "Demo notebook A4"), qty: 2, price: 220, rate: 0.1 }],
      needsReview: true, note: "※支払期限が発行日より前のわざと誤った書類(デモ用)。",
    },
    {
      file: "inv-09-dup-a.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("架空サンプル商事株式会社", "Kaku Sample Shouji K.K."),
      reg: REG_A, issueDate: "2026-09-21", dueDate: "2026-10-21", docNo: "INV-2026-0009",
      docType: "invoice",
      items: [{ name: T("コピー用紙500枚", "Copy paper"), qty: 4, price: 550, rate: 0.1 }],
      needsReview: false,
    },
    {
      file: "inv-10-dup-b.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("架空サンプル商事株式会社", "Kaku Sample Shouji K.K."),
      reg: REG_A, issueDate: "2026-09-21", dueDate: "2026-10-21", docNo: "INV-2026-0009",
      docType: "invoice",
      items: [{ name: T("コピー用紙500枚", "Copy paper"), qty: 4, price: 550, rate: 0.1 }],
      needsReview: true, note: "※inv-09-dup-a.pdf と同じ書類の重複(デモ用)。単体では正しいが一覧では要確認。",
    },
    {
      file: "inv-11-bad-tax.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("見本フーズ株式会社", "Mihon Foods K.K."),
      reg: REG_B, issueDate: "2026-09-22", dueDate: "2026-10-22", docNo: "INV-2026-0011",
      docType: "invoice",
      items: [{ name: T("配達料", "Delivery fee"), qty: 1, price: 10000, rate: 0.1 }],
      corrupt: "tax", needsReview: true, note: "※税額がわざと間違えてある(デモ用)。",
    },
    {
      file: "rcp-02-missing.pdf", kind: "pdf",
      title: T("領 収 書", "RECEIPT"), issuer: "",
      reg: null, issueDate: "2026-09-25", dueDate: null, docNo: "RCP-2026-0002",
      docType: "receipt", items: [], needsReview: true,
      note: "※発行元が記載漏れのわざと不備のある領収書(デモ用)。",
    },
    {
      file: "inv-12-bad-date2.pdf", kind: "pdf",
      title: T("請 求 書", "INVOICE"), issuer: T("デモ食品株式会社", "Demo Foods K.K."),
      reg: REG_D, issueDate: "2026-02-30", dueDate: "2026-03-31", docNo: "INV-2026-0012",
      docType: "invoice",
      items: [{ name: T("デモ弁当", "Demo bento"), qty: 5, price: 600, rate: 0.08 }],
      needsReview: true, note: "※実在しない日付(2月30日)のわざと誤った書類(デモ用)。",
    },
  ];

  for (const p of plans) {
    const s = sums(p.items);
    let lines = s.lines;
    let taxBreakdown = s.taxBreakdown;
    let subtotal: number | null = s.subtotal;
    let total: number | null = s.total;
    // 領収書(品目なし)は合計のみ
    if (p.docType === "receipt" && p.items.length === 0) {
      subtotal = null;
      taxBreakdown = [];
      total = p.file === "rcp-02-missing.pdf" ? 3300 : 5500;
    }
    if (p.corrupt === "math") {
      // 1行目の金額を+100ずらす(小計・税・合計は正しい小計から作るので全体が不一致になる)
      lines = lines.map((l, i) => (i === 0 ? { ...l, amount: (l.amount ?? 0) + 100 } : l));
    }
    if (p.corrupt === "tax") {
      taxBreakdown = taxBreakdown.map((t) => ({ ...t, tax: t.tax + 500 }));
      total = (subtotal ?? 0) + taxBreakdown.reduce((a, b) => a + b.tax, 0);
    }
    const data: InvoiceData = {
      docType: p.docType,
      issuer: p.issuer === "" ? null : p.issuer,
      registrationNumber: p.reg,
      issueDate: p.issueDate,
      dueDate: p.dueDate,
      documentNumber: p.docNo,
      lineItems: lines,
      subtotal,
      taxBreakdown,
      total,
      currency: "JPY",
    };
    const outPath = path.join(SAMPLES, p.file);
    if (p.kind === "pdf") {
      await drawPdf(
        outPath,
        {
          title: p.title, issuer: p.issuer, reg: p.reg, issueDate: p.issueDate,
          dueDate: p.dueDate, docNo: p.docNo, items: lines, subtotal,
          taxBreakdown, total, note: p.note,
        },
        fontPath,
      );
    } else {
      const svg = svgInvoice({
        title: p.title, issuer: p.issuer || "(記載なし)", reg: p.reg ?? "(なし)",
        issueDate: p.issueDate, docNo: p.docNo, total: total ?? 0,
      });
      let img = sharp(svg).flatten({ background: "#ffffff" });
      if (p.tiltScan) {
        img = sharp(
          await sharp(svg).flatten({ background: "#ffffff" }).png().toBuffer(),
        )
          .rotate(1.8, { background: "#ffffff" })
          .modulate({ brightness: 1.15, saturation: 0.4 })
          .blur(0.6);
      }
      if (p.kind === "png") await img.png().toFile(outPath);
      else await img.jpeg({ quality: 72 }).toFile(outPath);
    }
    await writeFile(
      path.join(EXPECTED, p.file.replace(/\.[^.]+$/, ".json")),
      JSON.stringify({ file: p.file, data, needsReview: p.needsReview }, null, 2),
      "utf-8",
    );
    console.log(`生成: ${p.file} (要確認=${p.needsReview ? "yes" : "no"})`);
  }
  // フォントのライセンス文
  await writeFile(
    path.join(FONTS, "FONT-LICENSE-NOTE.txt"),
    [
      "日本語フォントについて",
      "",
      "サンプル生成では Noto Sans JP (SIL Open Font License 1.1) を使用します。",
      "取得元: https://github.com/notofonts/noto-cjk (Sans/SubsetOTF/JP/NotoSansJP-Regular.otf)",
      "ライセンス: https://scripts.sil.org/OFL",
      "",
      "フォントのバイナリはリポジトリに含めず、生成時に自動取得します。",
      "PDFにはフォントがサブセット埋め込みされるため、閲覧に追加フォントは不要です。",
      "フォントを取得できない環境では英数字(ローマ字)で生成されます。",
      "",
    ].join("\n"),
    "utf-8",
  );
  console.log(`完了: ${plans.length}件`);
}

await main();
