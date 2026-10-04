import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { makeFakeRegistrationNumber } from "../src/validate.js";
import type { CheckedDoc } from "../src/types.js";

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    const withAll = s as Server & { closeAllConnections?: () => void };
    try { withAll.closeAllConnections?.(); } catch { /* ignore */ }
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
});

async function listen(): Promise<string> {
  const app = createApp();
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(srv);
  const { port } = srv.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function goodDoc(file = "ok.pdf"): CheckedDoc {
  const reg = makeFakeRegistrationNumber("121212121212");
  return {
    file,
    data: {
      docType: "invoice",
      issuer: "架空テスト商事",
      registrationNumber: reg,
      issueDate: "2026-09-01",
      dueDate: "2026-09-30",
      documentNumber: "INV-T-1",
      lineItems: [{ name: "品A", quantity: 1, unitPrice: 1000, amount: 1000 }],
      subtotal: 1000,
      taxBreakdown: [{ rate: 0.1, base: 1000, tax: 100 }],
      total: 1100,
      currency: "JPY",
    },
    taxTotal: 100,
    validation: { needsReview: false, reasons: [] },
  };
}

describe("サーバ堅牢化", () => {
  it("x-powered-by を返さない", async () => {
    const base = await listen();
    const r = await fetch(`${base}/`);
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("11ファイルはJSONで400/413を返し、内部パスを含まない", async () => {
    const base = await listen();
    const fd = new FormData();
    for (let i = 0; i < 11; i++) {
      fd.append("files", new Blob(["dummy"], { type: "application/pdf" }), `a${i}.pdf`);
    }
    const r = await fetch(`${base}/api/extract`, { method: "POST", body: fd });
    expect(r.ok).toBe(false);
    const text = await r.text();
    let j: unknown = null;
    expect(() => { j = JSON.parse(text); }).not.toThrow();
    const body = JSON.stringify(j);
    expect(body).not.toContain("node_modules");
    expect(body).not.toContain("C:\\");
    expect(body).not.toContain("/Users/");
  });

  it("上限超サイズはJSONエラーを返し、内部パスを含まない", async () => {
    const base = await listen();
    const big = new Uint8Array(21 * 1024 * 1024);
    const fd = new FormData();
    fd.append("files", new Blob([big], { type: "application/pdf" }), "big.pdf");
    const r = await fetch(`${base}/api/extract`, { method: "POST", body: fd });
    expect(r.ok).toBe(false);
    const text = await r.text();
    let j: unknown = null;
    expect(() => { j = JSON.parse(text); }).not.toThrow();
    const body = JSON.stringify(j);
    expect(body).not.toContain("node_modules");
    expect(body).not.toContain("C:\\");
    expect(body).not.toContain("/Users/");
  });

  it("許可外の拡張子・mimetypeは400で拒否する", async () => {
    const base = await listen();
    for (const name of ["evil.txt", "evil.exe"]) {
      const fd = new FormData();
      fd.append("files", new Blob(["x"], { type: "text/plain" }), name);
      const r = await fetch(`${base}/api/extract`, { method: "POST", body: fd });
      expect(r.status).toBe(400);
      const j = (await r.text()).toLowerCase();
      expect(j).toContain("pdf");
    }
  });

  it("/api/export はサーバ側で再検証し、誤ったneedsReviewを上書きする", async () => {
    const base = await listen();
    const d = goodDoc();
    // 壊れた合計なのにクライアントが OK と偽る
    d.data.total = 9999;
    d.validation = { needsReview: false, reasons: [] };
    const r = await fetch(`${base}/api/export?format=csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: [d] }),
    });
    expect(r.ok).toBe(true);
    const csv = await r.text();
    // 列単位で確認
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
    const header = lines[0].split(",");
    const idx = header.indexOf("needsReview");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines[1].split(",")[idx]).toBe("要確認");
  });

  it("/api/validate は値を直すと要確認を再判定する", async () => {
    const base = await listen();
    const d = goodDoc();
    d.data.total = 9999;
    const r = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: [{ file: d.file, data: d.data }] }),
    });
    expect(r.ok).toBe(true);
    const j = JSON.parse(await r.text()) as { docs: CheckedDoc[] };
    expect(j.docs[0].validation.needsReview).toBe(true);
    expect(j.docs[0].validation.reasons.join(" ")).toContain("total");
  });
});

describe("画面の再検証と既定ホスト", () => {
  const post = (base: string, docs: unknown[]) =>
    fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs }),
    }).then((r) => r.json() as Promise<{ docs: CheckedDoc[] }>);

  it("デモ用ダミー登録番号 T9234567890123 は検査数字が正しく、要確認にならない", async () => {
    const base = await listen();
    const d = goodDoc("demo-01.pdf");
    d.data.registrationNumber = "T9234567890123";
    d.data.lineItems = [];
    d.data.subtotal = 10000;
    d.data.taxBreakdown = [{ rate: 0.1, base: 10000, tax: 1000 }];
    d.data.total = 11000;
    const j = await post(base, [{ file: d.file, data: d.data }]);
    expect(j.docs[0].validation).toEqual({ needsReview: false, reasons: [] });
  });

  it("全件を送ると、1件を編集しても二重登録の要確認が残る", async () => {
    const base = await listen();
    const a = goodDoc("a.pdf");
    const b = goodDoc("b.pdf"); // a と同じ発行元・書類番号・合計
    const first = await post(base, [a, b].map((d) => ({ file: d.file, data: d.data })));
    expect(first.docs[0].validation.needsReview).toBe(false);
    expect(first.docs[1].validation.reasons.join(" ")).toContain("duplicate");
    // 1件目の無関係な項目(発行元は変えない)を編集して全件を再送
    a.data.dueDate = "2026-10-15";
    const again = await post(base, [a, b].map((d) => ({ file: d.file, data: d.data })));
    expect(again.docs.length).toBe(2);
    expect(again.docs[1].validation.reasons.join(" ")).toContain("duplicate");
    // 編集した1件だけ送ると重複は消える(画面が全件送る理由)
    const only = await post(base, [{ file: b.file, data: b.data }]);
    expect(only.docs[0].validation.needsReview).toBe(false);
  });
});
