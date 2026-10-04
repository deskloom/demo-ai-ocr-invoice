import express from "express";
import multer from "multer";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { GeminiExtractor } from "./gemini.js";
import { validateBatch } from "./validate.js";
import { toCsv, toExcelBuffer } from "./export.js";
import type { CheckedDoc, ExtractedDoc } from "./types.js";

function mimeOf(filename: string, mimetype: string): string {
  if (mimetype && mimetype !== "application/octet-stream") return mimetype;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function isAllowedFile(filename: string, mimetype: string): boolean {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (!ALLOWED_EXTS.has(ext)) return false;
  const effective = mimeOf(filename, mimetype);
  return ALLOWED_MIMES.has(effective);
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  });
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });

  // 複数ファイルの読み取り
  app.post("/api/extract", upload.array("files", 10), async (req, res) => {
    try {
      const files = (req.files ?? []) as Express.Multer.File[];
      if (files.length === 0) {
        res.status(400).json({ error: "ファイルがありません" });
        return;
      }
      for (const f of files) {
        if (!isAllowedFile(f.originalname, f.mimetype)) {
          res.status(400).json({
            error: "対応していないファイル形式です（PDF/PNG/JPG/WEBPのみ）",
          });
          return;
        }
      }
      if (!process.env.GEMINI_API_KEY) {
        res.status(500).json({
          error:
            "GEMINI_API_KEY が未設定です(.envに設定してください)。APIキーなしで試す場合は画面の「サンプルデータで試す」を使ってください。",
        });
        return;
      }
      const extractor = new GeminiExtractor();
      const extracted: ExtractedDoc[] = [];
      for (const f of files) {
        const data = await extractor.extract(
          f.buffer,
          mimeOf(f.originalname, f.mimetype),
          f.originalname,
        );
        extracted.push({ file: f.originalname, data });
      }
      const checked: CheckedDoc[] = validateBatch(extracted);
      res.json({ docs: checked });
    } catch (err) {
      console.error("extract error:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "AIの呼び出しに失敗しました（回数制限の可能性）" });
    }
  });

  // 値の修正後に要確認を再判定する
  app.post("/api/validate", async (req, res) => {
    try {
      const docs = (req.body?.docs ?? []) as ExtractedDoc[];
      const extracted: ExtractedDoc[] = docs.map((d) => ({
        file: String((d as { file?: unknown })?.file ?? "unknown"),
        data: (d as { data?: ExtractedDoc["data"] })?.data as ExtractedDoc["data"],
      }));
      const checked = validateBatch(extracted);
      res.json({ docs: checked });
    } catch (err) {
      console.error("validate error:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "サーバーでエラーが発生しました" });
    }
  });

  // 画面上で修正した値を受け取り、CSV/Excelで返す（サーバ側で再検証して上書き）
  app.post("/api/export", async (req, res) => {
    try {
      const incoming = (req.body?.docs ?? []) as CheckedDoc[];
      const extracted: ExtractedDoc[] = incoming.map((d) => ({
        file: String((d as { file?: unknown })?.file ?? "unknown"),
        data: (d as { data?: ExtractedDoc["data"] })?.data as ExtractedDoc["data"],
      }));
      const docs = validateBatch(extracted);
      const format = String(req.query.format ?? "xlsx");
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=result.csv");
        res.send(toCsv(docs));
        return;
      }
      const buf = await toExcelBuffer(docs);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", "attachment; filename=result.xlsx");
      res.send(buf);
    } catch (err) {
      console.error("export error:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "サーバーでエラーが発生しました" });
    }
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // エラーハンドラ（MulterErrorはJSON日本語のみ、その他は固定メッセージ）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { code?: string; message?: string };
    if (e && typeof e.code === "string" && e.code.startsWith("LIMIT_")) {
      if (e.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "ファイルサイズが大きすぎます（1件20MBまで）" });
        return;
      }
      res.status(400).json({ error: "ファイルは最大10件までです" });
      return;
    }
    if ((err as { name?: string })?.name === "MulterError") {
      console.error("multer error:", e?.code ?? e?.message ?? err);
      res.status(400).json({ error: "ファイルの受け付けに失敗しました" });
      return;
    }
    console.error("server error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "サーバーでエラーが発生しました" });
  });
  return app;
}

const PORT = Number(process.env.PORT ?? 3000);
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
if (process.env.VITEST !== "true" && isMainModule()) {
  // 既定は手元からのみ接続可(127.0.0.1)。LAN等に公開する場合は HOST=0.0.0.0 を指定する
  const HOST = process.env.HOST || "127.0.0.1";
  createApp().listen(PORT, HOST, () => {
    console.log(`open http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log(`GEMINI_MODEL=${process.env.GEMINI_MODEL ?? "gemini-3.8-flash"}(default)`);
    console.log(`APIキー設定: ${process.env.GEMINI_API_KEY ? "あり" : "なし"}`);
  });
}

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>請求書AI読み取りデモ</title>
<style>
body{font-family:sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#222}
#drop{border:2px dashed #888;border-radius:12px;padding:32px;text-align:center;background:#fafafa}
#drop.over{background:#eef}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #ccc;padding:4px 6px}
tr.review{background:#ffd9d9}
td input{width:110px}
.reason{color:#a00;font-size:12px}
button{margin:4px}
.muted{color:#666;font-size:13px}
</style></head><body>
<h1>請求書・領収書のAI読み取りデモ(架空書類のみ)</h1>
<p class="muted">PDF/画像をドラッグ＆ドロップ→読み取り→要確認の行は赤色+理由表示→画面で修正→CSV/Excelでダウンロード。実在の書類は入れないでください。</p>
<div id="drop">ここに PDF / PNG / JPG をドロップ (最大10件)<br><input type="file" id="picker" multiple accept=".pdf,.png,.jpg,.jpeg,.webp"></div>
<p><button id="go">読み取る</button> <button id="demo">サンプルデータで試す(APIキー不要)</button>
<button id="dlCsv">CSVで保存</button> <button id="dlXlsx">Excelで保存</button>
<span id="msg" class="muted"></span></p>
<table id="tbl"><thead><tr>
<th>ファイル</th><th>種別</th><th>発行元</th><th>登録番号</th><th>発行日</th><th>期限</th>
<th>書類番号</th><th>小計</th><th>税合計</th><th>合計</th><th>判定</th><th>理由</th>
</tr></thead><tbody></tbody></table>
<script>
let docs=[];
const drop=document.getElementById('drop'),picker=document.getElementById('picker'),msg=document.getElementById('msg');
let files=[];
picker.onchange=()=>{files=[...picker.files];msg.textContent=files.length+'件選択';};
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');files=[...e.dataTransfer.files];msg.textContent=files.length+'件選択';};
document.getElementById('go').onclick=async()=>{
 if(!files.length){msg.textContent='ファイルを選んでください';return;}
 msg.textContent='読み取り中...';
 try{
  const fd=new FormData();files.forEach(f=>fd.append('files',f,f.name));
  const r=await fetch('/api/extract',{method:'POST',body:fd});
  const text=await r.text();
  let j;try{j=JSON.parse(text);}catch{msg.textContent='エラー: サーバー応答を解析できませんでした';return;}
  if(!r.ok){msg.textContent='エラー: '+(j.error||('HTTP '+r.status));return;}
  docs=j.docs;render();msg.textContent=docs.length+'件読み取り完了';
 }catch(e){msg.textContent='エラー: '+(e&&e.message?e.message:e);}
};
document.getElementById('demo').onclick=async()=>{
 // APIキーなしでも触れるよう、ダミーの1件を表示する。判定は表示前に /api/validate を通した結果を使う
 docs=[{file:'demo-01.pdf',taxTotal:0,data:{docType:'invoice',issuer:'架空サンプル商事',registrationNumber:'T9234567890123',issueDate:'2026-09-01',dueDate:'2026-09-30',documentNumber:'INV-0001',lineItems:[],subtotal:10000,taxBreakdown:[{rate:0.1,base:10000,tax:1000}],total:11000,currency:'JPY'},validation:{needsReview:false,reasons:[]}}];
 if(await revalidate()){msg.textContent='ダミー表示です。各セルを編集してCSV/Excel保存を試せます';}
};
function render(){
 const tb=document.querySelector('#tbl tbody');tb.innerHTML='';
 docs.forEach((d,i)=>{
  const tr=document.createElement('tr');if(d.validation.needsReview)tr.className='review';
  const cell=(v,path)=>{const td=document.createElement('td');const inp=document.createElement('input');inp.value=v??'';inp.onchange=()=>setPath(d,path,inp.value);td.appendChild(inp);return td;};
  const t=(s)=>{const td=document.createElement('td');td.textContent=s;return td;};
  tr.append(t(d.file),t(d.data.docType),cell(d.data.issuer,'data.issuer'),cell(d.data.registrationNumber,'data.registrationNumber'),cell(d.data.issueDate,'data.issueDate'),cell(d.data.dueDate,'data.dueDate'),cell(d.data.documentNumber,'data.documentNumber'),cell(d.data.subtotal,'data.subtotal'),t(d.taxTotal),cell(d.data.total,'data.total'),t(d.validation.needsReview?'要確認':'OK'),(()=>{const td=document.createElement('td');td.className='reason';td.textContent=d.validation.reasons.join(' / ');return td;})());
  tb.append(tr);
 });
}
function setPath(d,path,val){
 const numFields=new Set(['data.subtotal','data.total']);
 const [a,b]=path.split('.');d[a][b]=numFields.has(path)?(val==='' ?null:Number(val)):val;
 // サーバ側でvalidateBatchをやり直して要確認と理由を更新する
 revalidate();
}
// 全件をまとめて送る(二重登録の判定は全件が必要なため)。成功したら true
async function revalidate(){
 try{
  const r=await fetch('/api/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs:docs.map(d=>({file:d.file,data:d.data}))})});
  const text=await r.text();
  let j;try{j=JSON.parse(text);}catch{msg.textContent='エラー: 検証応答を解析できませんでした';return false;}
  if(!r.ok){msg.textContent='エラー: '+(j.error||('HTTP '+r.status));return false;}
  if(!Array.isArray(j.docs)||j.docs.length!==docs.length){msg.textContent='エラー: 検証応答の件数が一致しません';return false;}
  j.docs.forEach((u,i)=>{docs[i].validation=u.validation;docs[i].taxTotal=u.taxTotal;});
  render();return true;
 }catch(e){msg.textContent='エラー: '+(e&&e.message?e.message:e);return false;}
}
async function dl(fmt){
 try{
  const r=await fetch('/api/export?format='+fmt,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs})});
  if(!r.ok){const t=await r.text();let j;try{j=JSON.parse(t);}catch{j=null;}msg.textContent='エラー: '+(j&&j.error?j.error:('HTTP '+r.status));return;}
  const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fmt==='csv'?'result.csv':'result.xlsx';a.click();
 }catch(e){msg.textContent='エラー: '+(e&&e.message?e.message:e);}
}
document.getElementById('dlCsv').onclick=()=>dl('csv');
document.getElementById('dlXlsx').onclick=()=>dl('xlsx');
</script></body></html>`;
