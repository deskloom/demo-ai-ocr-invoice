import express from "express";
import multer from "multer";
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

export function createApp(): express.Express {
  const app = express();
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
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  // 画面上で修正した値を受け取り、CSV/Excelで返す
  app.post("/api/export", async (req, res) => {
    try {
      const docs = (req.body?.docs ?? []) as CheckedDoc[];
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
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  return app;
}

const PORT = Number(process.env.PORT ?? 3000);
if (process.env.VITEST !== "true" && import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  createApp().listen(PORT, () => {
    console.log(`open http://localhost:${PORT}`);
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
 const fd=new FormData();files.forEach(f=>fd.append('files',f,f.name));
 const r=await fetch('/api/extract',{method:'POST',body:fd});
 const j=await r.json();
 if(!r.ok){msg.textContent='エラー: '+j.error;return;}
 docs=j.docs;render();msg.textContent=docs.length+'件読み取り完了';
};
document.getElementById('demo').onclick=async()=>{
 // APIキーなしでも触れるよう、ダミーの1件を表示
 docs=[{file:'demo-01.pdf',taxTotal:1000,data:{docType:'invoice',issuer:'架空サンプル商事',registrationNumber:'T1234567890123',issueDate:'2026-09-01',dueDate:'2026-09-30',documentNumber:'INV-0001',lineItems:[],subtotal:10000,taxBreakdown:[{rate:0.1,base:10000,tax:1000}],total:11000,currency:'JPY'},validation:{needsReview:false,reasons:[]}}];
 render();msg.textContent='ダミー表示です。各セルを編集してCSV/Excel保存を試せます';
};
function render(){
 const tb=document.querySelector('#tbl tbody');tb.innerHTML='';
 docs.forEach((d,i)=>{
  const tr=document.createElement('tr');if(d.validation.needsReview)tr.className='review';
  const cell=(v,path)=>{const td=document.createElement('td');const inp=document.createElement('input');inp.value=v??'';inp.onchange=()=>setPath(d,path,inp.value);td.appendChild(inp);return td;};
  tr.append(document.createTextNode(''),...[]);
  const t=(s)=>{const td=document.createElement('td');td.textContent=s;return td;};
  tr.append(t(d.file),t(d.data.docType),cell(d.data.issuer,'data.issuer'),cell(d.data.registrationNumber,'data.registrationNumber'),cell(d.data.issueDate,'data.issueDate'),cell(d.data.dueDate,'data.dueDate'),cell(d.data.documentNumber,'data.documentNumber'),cell(d.data.subtotal,'data.subtotal'),t(d.taxTotal),cell(d.data.total,'data.total'),t(d.validation.needsReview?'要確認':'OK'),(()=>{const td=document.createElement('td');td.className='reason';td.textContent=d.validation.reasons.join(' / ');return td;})());
  tb.append(tr);
 });
}
function setPath(d,path,val){
 const numFields=new Set(['data.subtotal','data.total']);
 const [a,b]=path.split('.');d[a][b]=numFields.has(path)?(val==='' ?null:Number(val)):val;
 // 再計算はサーバ側のvalidate相当を簡易に: 合計チェックのみ更新
}
async function dl(fmt){
 const r=await fetch('/api/export?format='+fmt,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({docs})});
 const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fmt==='csv'?'result.csv':'result.xlsx';a.click();
}
document.getElementById('dlCsv').onclick=()=>dl('csv');
document.getElementById('dlXlsx').onclick=()=>dl('xlsx');
</script></body></html>`;
