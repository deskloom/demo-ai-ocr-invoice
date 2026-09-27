import { GoogleGenAI } from "@google/genai";
import type { InvoiceData } from "./types.js";

/**
 * Gemini 呼び出しはこのモジュールに閉じ込める。
 * テストでは Extractor インターフェースに差し替え(依存性注入)する。
 */

export interface Extractor {
  extract(
    buffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<InvoiceData>;
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
}

/** 出力JSONスキーマ (responseJsonSchema 用, JSON Schema サブセット) */
export const INVOICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    docType: {
      type: "string",
      enum: ["invoice", "receipt", "other"],
      description: "invoice=請求書, receipt=領収書, other=その他",
    },
    issuer: { type: ["string", "null"], description: "発行元の会社名。書類に記載が無い場合は null(「なし」「記載なし」等の文字を入れない)" },
    registrationNumber: {
      type: ["string", "null"],
      description: "適格請求書発行事業者の登録番号(T+13桁)。無ければnull(「なし」等の文字を入れない)",
    },
    issueDate: {
      type: ["string", "null"],
      description: "発行日 YYYY-MM-DD。読み取れなければnull(「なし」等の文字を入れない)",
    },
    dueDate: {
      type: ["string", "null"],
      description: "支払期限 YYYY-MM-DD。請求書のみ。無ければnull(「なし」等の文字を入れない)",
    },
    documentNumber: {
      type: ["string", "null"],
      description: "書類番号。記載が無ければnull(「なし」「記載なし」等の文字を入れない)",
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          amount: { type: ["number", "null"] },
        },
        required: ["name", "quantity", "unitPrice", "amount"],
      },
    },
    subtotal: { type: ["number", "null"] },
    taxBreakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rate: { type: "number", description: "税率(0.1 または 0.08)" },
          base: { type: "number", description: "対象額(税抜)" },
          tax: { type: "number", description: "税額" },
        },
        required: ["rate", "base", "tax"],
      },
    },
    total: { type: ["number", "null"] },
    currency: { type: "string", description: "既定 JPY" },
  },
  required: [
    "docType",
    "issuer",
    "registrationNumber",
    "issueDate",
    "dueDate",
    "documentNumber",
    "lineItems",
    "subtotal",
    "taxBreakdown",
    "total",
    "currency",
  ],
} as const;

const PROMPT = [
  "この書類(請求書または領収書)の画像/PDFを読み取り、指定のJSONスキーマで出力してください。",
  "ルール:",
  "- 金額は数値(カンマなし、円単位の整数)。読み取れない項目は null。",
  "- 書類に記載が無い項目は null。「なし」「記載なし」「-」「—」等の文字を値に入れない。",
  "- docType は invoice / receipt / other のいずれか。",
  "- issueDate/dueDate は YYYY-MM-DD。判読できなければ null。",
  "- registrationNumber は T+13桁の形式のときのみ文字列。無ければ null。",
  "- lineItems が無い書類(合計のみの領収書等)は空配列。",
  "- taxBreakdown が無い場合は空配列。税率は 0.1 / 0.08 の数値。",
  "- currency は既定 JPY。",
  "- 計算や検証は不要。書面に書かれた値をそのまま写すこと。",
].join("\n");

/** 「記載なし」を表す文字は null に変換する */
const NULL_WORDS = new Set([
  "なし",
  "無し",
  "記載なし",
  "記載無し",
  "(なし)",
  "(無し)",
  "（なし）",
  "（記載なし）",
  "(記載なし)",
  "-",
  "‐",
  "‑",
  "‒",
  "–",
  "—",
  "―",
]);

function isNullWord(s: string): boolean {
  const t = s.trim();
  if (t === "") return true;
  if (NULL_WORDS.has(t)) return true;
  // 全角ダッシュ・長音の単独文字も空扱いしない(値の破壊を避けるため上記集合のみ)
  return false;
}

function zenkakuToHankaku(s: string): string {
  return s.replace(/[０-９，．－（）]/g, (ch) => {
    const map: Record<string, string> = {
      "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
      "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
      "，": ",", "．": ".", "－": "-", "（": "(", "）": ")",
    };
    return map[ch] ?? ch;
  });
}

/** 金額系の値を数値に寄せる(全角数字・カンマ付き・「なし」対応) */
function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = zenkakuToHankaku(v.trim());
  if (isNullWord(s)) return null;
  // 「1,234円」「￥1,234」「1234 円」などを数値化
  s = s.replace(/[,\s、，]/g, "").replace(/[円￥¥]/g, "");
  if (s === "") return null;
  if (isNullWord(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 生JSONを InvoiceData に正規化する */
export function normalizeData(raw: unknown): InvoiceData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pickNum = (v: unknown): number | null => parseAmount(v);
  const pickStr = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t === "" || isNullWord(t)) return null;
    return t;
  };
  const pickName = (v: unknown): string => {
    if (typeof v !== "string") return "";
    const t = v.trim();
    if (t === "" || isNullWord(t)) return "";
    return t;
  };
  const docType =
    r.docType === "invoice" || r.docType === "receipt" || r.docType === "other"
      ? r.docType
      : "other";
  const lineItems = Array.isArray(r.lineItems)
    ? r.lineItems.map((li) => {
        const o = (li ?? {}) as Record<string, unknown>;
        return {
          name: pickName(o.name),
          quantity: pickNum(o.quantity),
          unitPrice: pickNum(o.unitPrice),
          amount: pickNum(o.amount),
        };
      })
    : [];
  const taxBreakdown = Array.isArray(r.taxBreakdown)
    ? r.taxBreakdown
        .map((t) => {
          const o = (t ?? {}) as Record<string, unknown>;
          return {
            rate: parseAmount(o.rate) ?? NaN,
            base: parseAmount(o.base) ?? NaN,
            tax: parseAmount(o.tax) ?? NaN,
          };
        })
        .filter(
          (t) =>
            Number.isFinite(t.rate) && Number.isFinite(t.base) && Number.isFinite(t.tax),
        )
    : [];
  return {
    docType,
    issuer: pickStr(r.issuer),
    registrationNumber: pickStr(r.registrationNumber),
    issueDate: pickStr(r.issueDate),
    dueDate: pickStr(r.dueDate),
    documentNumber: pickStr(r.documentNumber),
    lineItems,
    subtotal: pickNum(r.subtotal),
    taxBreakdown,
    total: pickNum(r.total),
    currency:
      typeof r.currency === "string" && r.currency.trim() !== ""
        ? r.currency.trim()
        : "JPY",
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err ?? "");
}

/** 429系かどうか */
export function isQuotaRateError(err: unknown): boolean {
  const msg = errText(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("503") ||
    msg.includes("overloaded")
  );
}

/** 1日あたりの上限かどうか（quotaId に PerDay を含む場合） */
export function isDailyQuotaError(err: unknown): boolean {
  const msg = errText(err);
  if (!isQuotaRateError(err)) return false;
  return /PerDay/.test(msg);
}

/** エラー文から quotaValue（1日上限回数）を抜く。無ければ null */
export function parseQuotaValue(err: unknown): number | null {
  const msg = errText(err);
  const m = msg.match(/quotaValue["'\s:=\]]*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** エラー文の RetryInfo retryDelay（例 "30s"）をmsで抜く。無ければ null */
export function parseRetryDelayMs(err: unknown): number | null {
  const msg = errText(err);
  const m = msg.match(/retryDelay["'\s:=\]]*(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const ms = Number(m[1]) * 1000;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, 120_000);
}

function isRetryable(err: unknown): boolean {
  const msg = String(
    (err as { message?: unknown })?.message ?? err ?? "",
  ).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("503") ||
    msg.includes("overloaded")
  );
}

export class GeminiExtractor implements Extractor {
  private ai: GoogleGenAI;
  private model: string;
  private minIntervalMs: number;
  private lastCall = 0;

  constructor(opts?: { apiKey?: string; model?: string; minIntervalMs?: string | number }) {
    const apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new Error("GEMINI_API_KEY が未設定です");
    this.ai = new GoogleGenAI({ apiKey });
    this.model = opts?.model ?? geminiModel();
    const fromEnv = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4000);
    this.minIntervalMs =
      Number(opts?.minIntervalMs ?? (Number.isFinite(fromEnv) ? fromEnv : 4000));
  }

  async extract(
    buffer: Buffer,
    mimeType: string,
    _filename: string,
  ): Promise<InvoiceData> {
    // 無料枠対策: 呼び出し間隔を空ける
    const wait = this.minIntervalMs - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        this.lastCall = Date.now();
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents: [
            {
              inlineData: { mimeType, data: buffer.toString("base64") },
            },
            { text: PROMPT },
          ],
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: INVOICE_JSON_SCHEMA,
          },
        });
        const text = response.text?.trim() ?? "";
        if (!text) throw new Error("空の応答が返りました");
        return normalizeData(JSON.parse(text));
      } catch (err) {
        lastErr = err;
        if (attempt < 3 && isRetryable(err)) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** テスト用の偽抽出器。ファイル名→応答の対応表で差し替え可能。 */
export class StubExtractor implements Extractor {
  constructor(private table: Record<string, InvoiceData>) {}
  async extract(
    _buffer: Buffer,
    _mimeType: string,
    filename: string,
  ): Promise<InvoiceData> {
    const hit = this.table[filename] ?? this.table["*"];
    if (!hit) throw new Error(`stub response missing for ${filename}`);
    return structuredClone(hit);
  }
}
