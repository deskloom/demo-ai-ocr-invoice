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
  /** 対象額(税抜) */
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
