import type { CheckedDoc, ExtractedDoc, InvoiceData } from "./types.js";

/**
 * 機械チェック (AIに任せないルールベース検証)。
 * チェック1〜8に対応し、1つでも引っかかれば needsReview=true。
 */

export const REASONS = {
  LINE_MATH: "line-math: 品目の数量×単価と金額が不一致",
  SUBTOTAL: "subtotal: 品目金額の合計と小計が不一致",
  TAX: "tax: 税率ごとの税額が対象額×税率(税込表示なら対象額×率/(1+率))の端数処理(切捨/四捨五入/切上)のいずれとも不一致",
  TOTAL: "total: 小計+税額合計と合計が不一致(税込表示なら小計と合計が不一致)",
  REG_FORMAT: "registrationNumber: 登録番号の形式(T+13桁)を満たさない",
  REG_CHECK: "registrationNumber: 登録番号のチェックデジットが不正",
  DATE_INVALID: "date: 日付が実在しない/形式(YYYY-MM-DD)が不正",
  DATE_ORDER: "date: 支払期限が発行日より前",
  MISSING: "missing: 必須項目(発行元・発行日・合計)が欠落",
  DUPLICATE: "duplicate: 同一書類の二重登録の疑い(発行元+書類番号+合計が一致)",
} as const;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** YYYY-MM-DD の実在日付か */
export function isValidDateString(s: string | null | undefined): boolean {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * 法人番号(13桁)の検査用数字を計算する。
 * 国税庁の方式: 下12桁を右から 1,2,1,2... で加重合計し、
 * 合計を9で割った余り(0〜8)を9から引く。結果は常に1〜9になる(0にも10にもならない)。
 * @param base12 登録番号(Tを除く13桁)のうち先頭1桁(検査用数字)を除いた下12桁
 */
export function corporateCheckDigit(base12: string): string {
  if (!/^\d{12}$/.test(base12)) throw new Error("base12 must be 12 digits");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(base12[11 - i]); // 右端から
    const w = i % 2 === 0 ? 1 : 2;
    sum += d * w;
  }
  // 余りは0〜8なので結果は1〜9(10や0にはならない)
  return String(9 - (sum % 9));
}

/** T+13桁の形式か */
export function isRegistrationFormat(s: string | null | undefined): boolean {
  return typeof s === "string" && /^T\d{13}$/.test(s);
}

/** 形式+チェックデジットまで正しいか */
export function isValidRegistrationNumber(
  s: string | null | undefined,
): boolean {
  if (!isRegistrationFormat(s)) return false;
  const digits = (s as string).slice(1); // 13桁
  const check = digits[0];
  const base12 = digits.slice(1);
  // 法人番号は先頭が0不可ではないが、T+13桁の1桁目は検査用数字(0〜9)なら何でもよい
  try {
    return corporateCheckDigit(base12) === check;
  } catch {
    return false;
  }
}

/** 架空の登録番号を生成する(チェックデジットが合うもの) */
export function makeFakeRegistrationNumber(random12?: string): string {
  let base12 = random12;
  if (!base12) {
    base12 = "";
    for (let i = 0; i < 12; i++) base12 += String(Math.floor(Math.random() * 10));
    // 法人番号として不自然な先頭0オンパレードを避ける程度
    if (/^0{6}/.test(base12)) base12 = "123456" + base12.slice(6);
  }
  if (!/^\d{12}$/.test(base12)) throw new Error("base12 must be 12 digits");
  return `T${corporateCheckDigit(base12)}${base12}`;
}

/** わざとチェックデジットを壊した登録番号を作る */
export function breakRegistrationNumber(valid: string): string {
  if (!isRegistrationFormat(valid)) throw new Error("valid T+13digits required");
  const brokenCheck = valid[1] === "9" ? "8" : "9";
  return `T${brokenCheck}${valid.slice(2)}`;
}

function checkLineMath(data: InvoiceData): string[] {
  const out: string[] = [];
  for (const [i, li] of data.lineItems.entries()) {
    if (isFiniteNum(li.quantity) && isFiniteNum(li.unitPrice) && isFiniteNum(li.amount)) {
      // 数量は小数(例: 1.5時間)があり得るので誤差許容はしない。小数対応で丸め比較。
      const expected = Math.round(li.quantity * li.unitPrice);
      // 整数金額前提。小数数量の場合は100倍精度で比較
      const expectedPrecise = li.quantity * li.unitPrice;
      if (Math.abs(expectedPrecise - li.amount) > 0.005 && expected !== li.amount) {
        out.push(`${REASONS.LINE_MATH} (行${i + 1}: ${li.name})`);
      }
    }
  }
  return out;
}

function checkSubtotal(data: InvoiceData): string[] {
  if (!isFiniteNum(data.subtotal)) return [];
  // 品目なし(領収書の合計のみ等)の場合はスキップ
  const amounts = data.lineItems.map((li) => li.amount).filter(isFiniteNum);
  if (amounts.length === 0) return [];
  // 金額nullの行がある場合は「欠落」側の問題なので合計チェックはスキップしないが、
  // null行があると合計が合わなくなるため、null行がある場合はチェック対象外にする
  if (amounts.length !== data.lineItems.length) return [];
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum !== data.subtotal) return [`${REASONS.SUBTOTAL} (品目合計=${sum} ≠ 小計=${data.subtotal})`];
  return [];
}

/**
 * 税額の候補(切捨・四捨五入・切上)。
 * 税込表示(taxIncluded=true)では対象額が税込なので、税額 = 対象額×率/(1+率)。
 * 税抜表示では 税額 = 対象額×率。
 */
function taxCandidates(base: number, rate: number, taxIncluded = false): number[] {
  const exact = taxIncluded ? (base * rate) / (1 + rate) : base * rate;
  // 浮動小数誤差対策: 小数第2位で丸める前の候補を3種作る
  const c = new Set([
    Math.floor(exact + 1e-9),
    Math.round(exact),
    Math.ceil(exact - 1e-9),
  ]);
  return [...c];
}

function checkTax(data: InvoiceData): string[] {
  const out: string[] = [];
  for (const t of data.taxBreakdown) {
    if (!isFiniteNum(t.base) || !isFiniteNum(t.tax) || typeof t.rate !== "number") continue;
    const cands = taxCandidates(t.base, t.rate, data.taxIncluded === true);
    if (!cands.includes(t.tax)) {
      out.push(
        `${REASONS.TAX} (税率${Math.round(t.rate * 100)}%: 対象額=${t.base} 税額=${t.tax} 期待値候補=${cands.join("/")})`,
      );
    }
  }
  return out;
}

function checkTotal(data: InvoiceData): string[] {
  if (!isFiniteNum(data.subtotal) || !isFiniteNum(data.total)) return [];
  const taxTotal = data.taxBreakdown
    .map((t) => t.tax)
    .filter(isFiniteNum)
    .reduce((a, b) => a + b, 0);
  if (data.taxIncluded === true) {
    // 税込表示: 小計・合計とも税込金額なので税を足さない(税は内数)。
    if (data.subtotal !== data.total) {
      return [`${REASONS.TOTAL} (税込表示: 小計=${data.subtotal} ≠ 合計=${data.total})`];
    }
    return [];
  }
  if (data.subtotal + taxTotal !== data.total) {
    return [`${REASONS.TOTAL} (小計=${data.subtotal}+税=${taxTotal} ≠ 合計=${data.total})`];
  }
  return [];
}

function checkRegistration(data: InvoiceData): string[] {
  const r = data.registrationNumber;
  if (r === null || r === undefined || r === "") return []; // 無ければnull扱い=OK
  if (!isRegistrationFormat(r)) return [REASONS.REG_FORMAT];
  if (!isValidRegistrationNumber(r)) return [REASONS.REG_CHECK];
  return [];
}

function checkDates(data: InvoiceData): string[] {
  const out: string[] = [];
  if (data.issueDate !== null && data.issueDate !== undefined && data.issueDate !== "") {
    if (!isValidDateString(data.issueDate)) out.push(`${REASONS.DATE_INVALID} (発行日=${data.issueDate})`);
  }
  if (data.dueDate !== null && data.dueDate !== undefined && data.dueDate !== "") {
    if (!isValidDateString(data.dueDate)) {
      out.push(`${REASONS.DATE_INVALID} (支払期限=${data.dueDate})`);
    } else if (
      isValidDateString(data.issueDate) &&
      data.dueDate < (data.issueDate as string)
    ) {
      out.push(`${REASONS.DATE_ORDER} (発行日=${data.issueDate} > 支払期限=${data.dueDate})`);
    }
  }
  return out;
}

function checkMissing(data: InvoiceData): string[] {
  const missing: string[] = [];
  if (!data.issuer || data.issuer.trim() === "") missing.push("発行元");
  if (!data.issueDate || data.issueDate.trim() === "") missing.push("発行日");
  if (!isFiniteNum(data.total)) missing.push("合計");
  if (missing.length > 0) return [`${REASONS.MISSING} (${missing.join("・")}が欠落)`];
  return [];
}

/** 単体書類のチェック(重複除く1〜7)。重複は validateBatch で付与。 */
export function validateOne(data: InvoiceData): string[] {
  return [
    ...checkLineMath(data),
    ...checkSubtotal(data),
    ...checkTax(data),
    ...checkTotal(data),
    ...checkRegistration(data),
    ...checkDates(data),
    ...checkMissing(data),
  ];
}

function dupKey(d: InvoiceData): string | null {
  if (!d.issuer || !d.documentNumber || !isFiniteNum(d.total)) return null;
  return `${d.issuer.trim()}|${d.documentNumber.trim()}|${d.total}`;
}

/** バッチ全体の検証(1〜8)。重複は2件目以降に理由を付与する。 */
export function validateBatch(docs: ExtractedDoc[]): CheckedDoc[] {
  const seen = new Map<string, number>();
  return docs.map((doc) => {
    const reasons = validateOne(doc.data);
    const key = dupKey(doc.data);
    if (key !== null) {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      if (n >= 1) reasons.push(REASONS.DUPLICATE);
    }
    const taxTotal = doc.data.taxBreakdown
      .map((t) => t.tax)
      .filter(isFiniteNum)
      .reduce((a, b) => a + b, 0);
    return { ...doc, taxTotal, validation: { needsReview: reasons.length > 0, reasons } };
  });
}
