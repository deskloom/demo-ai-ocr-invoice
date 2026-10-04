export type DocType = "invoice" | "receipt" | "other";

export interface LineItem {
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface TaxEntry {
  /** 税率 (例: 0.1, 0.08) */
  rate: number;
  /** 対象額(税抜表示の書類は税抜額、税込表示の書類は税込額) */
  base: number;
  /** 税額 */
  tax: number;
}

export interface InvoiceData {
  docType: DocType;
  issuer: string | null;
  registrationNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  documentNumber: string | null;
  lineItems: LineItem[];
  subtotal: number | null;
  taxBreakdown: TaxEntry[];
  total: number | null;
  currency: string;
  /**
   * 書類の金額が税込表示か。true=税込(小計・合計・対象額が税込。税額は内数)、
   * false=税抜、null/未指定=不明(税抜として検証する)。
   */
  taxIncluded?: boolean | null;
}

export interface ExtractedDoc {
  file: string;
  data: InvoiceData;
}

export interface ValidationResult {
  needsReview: boolean;
  reasons: string[];
}

export interface CheckedDoc extends ExtractedDoc {
  validation: ValidationResult;
  taxTotal: number;
}

export const SUMMARY_COLUMNS = [
  "file",
  "docType",
  "issuer",
  "registrationNumber",
  "issueDate",
  "dueDate",
  "documentNumber",
  "lineCount",
  "subtotal",
  "taxTotal",
  "total",
  "currency",
  "needsReview",
  "reasons",
] as const;
