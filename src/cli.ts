#!/usr/bin/env node
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { GeminiExtractor, type Extractor } from "./gemini.js";
import { validateBatch } from "./validate.js";
import { toCsv, toExcelBuffer } from "./export.js";
import type { ExtractedDoc } from "./types.js";

/**
 * CLI: npm run extract -- samples/*.pdf --out out/result.xlsx
 * --out の拡張子で形式を判定 (.xlsx / .csv / .json)。
 */

function mimeOf(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/**
 * 入力パスの * と ? を展開する(Windows の cmd/PowerShell はシェルが展開しないため)。
 * 対応はファイル名部分のみ(例: samples/*.pdf)。ディレクトリ部分のワイルドカードや ** は非対応。
 * Node 22 の fs.promises.glob は実験的機能で警告が出るため使わず、自前の簡易展開にしている。
 * 一致が無ければ元の文字列を返す(後続の読み込みで日本語ではなく通常のエラーになる)。
 */
export async function expandInputs(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    const base = path.basename(input);
    if (!/[*?]/.test(base)) {
      out.push(input);
      continue;
    }
    const dir = path.dirname(input);
    // * → 任意の文字列、? → 任意の1文字、それ以外は文字どおり(正規表現の特殊文字はエスケープ)
    const pattern = [...base]
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")))
      .join("");
    const re = new RegExp(`^${pattern}$`, "i");
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => re.test(n)).sort();
    } catch {
      /* ディレクトリが無い等は一致なし扱い */
    }
    if (names.length === 0) out.push(input);
    else out.push(...names.map((n) => path.join(dir, n)));
  }
  return out;
}

export async function runCli(
  argv: string[],
  extractorFactory?: () => Extractor,
): Promise<void> {
  const args = argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const rawInputs = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out" && !a.startsWith("--"));
  const inputs = await expandInputs(rawInputs);
  if (inputs.length === 0 || !out) {
    console.log("使い方: npm run extract -- <入力PDF/画像...> --out out/result.xlsx");
    console.log("例: npm run extract -- samples/inv-01.pdf samples/rcp-01.pdf --out out/result.xlsx");
    process.exitCode = 2;
    return;
  }
  if (!extractorFactory && !process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY が未設定です(.envに設定してください)");
    process.exitCode = 1;
    return;
  }
  const extractor = extractorFactory ? extractorFactory() : new GeminiExtractor();
  const extracted: ExtractedDoc[] = [];
  for (const file of inputs) {
    const buf = await readFile(file);
    const data = await extractor.extract(buf, mimeOf(file), path.basename(file));
    extracted.push({ file: path.basename(file), data });
  }
  const checked = validateBatch(extracted);
  const needs = checked.filter((d) => d.validation.needsReview).length;
  console.log(`${checked.length}件読み取り: OK=${checked.length - needs} 要確認=${needs}`);
  for (const d of checked) {
    if (d.validation.needsReview) console.log(`- [要確認] ${d.file}: ${d.validation.reasons.join(" / ")}`);
  }
  await mkdir(path.dirname(out), { recursive: true });
  const lower = out.toLowerCase();
  if (lower.endsWith(".csv")) {
    await writeFile(out, toCsv(checked), "utf-8");
  } else if (lower.endsWith(".json")) {
    await writeFile(out, JSON.stringify(checked, null, 2), "utf-8");
  } else {
    const buf = await toExcelBuffer(checked);
    await writeFile(out, buf);
  }
  console.log(`保存: ${out}`);
}

export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await runCli(process.argv);
}
