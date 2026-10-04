import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runEval } from "../src/eval.js";
import type { InvoiceData } from "../src/types.js";
import type { Extractor } from "../src/gemini.js";

function data(): InvoiceData {
  return {
    docType: "invoice",
    issuer: "架空テスト",
    registrationNumber: null,
    issueDate: "2026-09-01",
    dueDate: null,
    documentNumber: "D1",
    lineItems: [{ name: "品", quantity: 1, unitPrice: 100, amount: 100 }],
    subtotal: 100,
    taxBreakdown: [{ rate: 0.1, base: 100, tax: 10 }],
    total: 110,
    currency: "JPY",
  };
}

function dailyErr(): Error {
  return new Error(
    '429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier quotaValue: 20 RetryInfo retryDelay: 1s',
  );
}

async function setupDir(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-test-"));
  const samples = path.join(dir, "samples");
  const expected = path.join(samples, "expected");
  await mkdir(expected, { recursive: true });
  for (const f of files) {
    await writeFile(path.join(samples, f), "dummy");
    await writeFile(
      path.join(expected, f.replace(/\.[^.]+$/, ".json")),
      JSON.stringify({ file: f, data: data(), needsReview: false }),
    );
  }
  return dir;
}

describe("eval", () => {
  it("1日上限の429 → 途中結果を保存して正常終了する", async () => {
    const dir = await setupDir(["a.pdf", "b.pdf"]);
    let calls = 0;
    const extractor: Extractor = {
      async extract() {
        calls++;
        if (calls === 2) throw dailyErr();
        return structuredClone(data());
      },
    };
    const res = await runEval({
      model: "test-model",
      repeats: 2,
      samplesDir: path.join(dir, "samples"),
      expectedDir: path.join(dir, "samples", "expected"),
      outMd: path.join(dir, "eval", "results.md"),
      runsDir: path.join(dir, "eval", "runs"),
      extractor,
      minIntervalMs: 0,
      sleepFn: async () => {},
    });
    expect(res.dailyQuotaHit).toBe(true);
    expect(res.completed).toBeLessThan(res.total);
    // JSONLに途中結果が残る
    const runs = await readFile(path.join(dir, "eval", "runs", "test-model.jsonl"), "utf-8");
    expect(runs.trim().split("\n").length).toBeGreaterThanOrEqual(1);
    // results.mdにモデル名と完了数/予定数が書かれる
    const md = await readFile(path.join(dir, "eval", "results.md"), "utf-8");
    expect(md).toContain("test-model");
    expect(md).toContain(`${res.completed}/${res.total}`);
  });

  it("再実行で続きから再開する（保存済みは呼ばない）", async () => {
    const dir = await setupDir(["a.pdf"]);
    const okExtractor: Extractor = { async extract() { return structuredClone(data()); } };
    const first = await runEval({
      model: "m",
      repeats: 2,
      samplesDir: path.join(dir, "samples"),
      expectedDir: path.join(dir, "samples", "expected"),
      outMd: path.join(dir, "eval", "results.md"),
      runsDir: path.join(dir, "eval", "runs"),
      extractor: okExtractor,
      minIntervalMs: 0,
      sleepFn: async () => {},
    });
    expect(first.completed).toBe(first.total);
    let calls = 0;
    const counting: Extractor = {
      async extract() { calls++; return structuredClone(data()); },
    };
    const second = await runEval({
      model: "m",
      repeats: 2,
      samplesDir: path.join(dir, "samples"),
      expectedDir: path.join(dir, "samples", "expected"),
      outMd: path.join(dir, "eval", "results.md"),
      runsDir: path.join(dir, "eval", "runs"),
      extractor: counting,
      minIntervalMs: 0,
      sleepFn: async () => {},
    });
    expect(calls).toBe(0);
    expect(second.completed).toBe(second.total);
  });

  it("分あたり上限の429はretryDelay待って再試行する（最大3回）", async () => {
    const dir = await setupDir(["a.pdf"]);
    let calls = 0;
    const waits: number[] = [];
    const extractor: Extractor = {
      async extract() {
        calls++;
        if (calls <= 2) {
          throw new Error("429 RESOURCE_EXHAUSTED per-model per-minute quota RetryInfo retryDelay: 2s");
        }
        return structuredClone(data());
      },
    };
    const res = await runEval({
      model: "m3",
      repeats: 1,
      samplesDir: path.join(dir, "samples"),
      expectedDir: path.join(dir, "samples", "expected"),
      outMd: path.join(dir, "eval", "results.md"),
      runsDir: path.join(dir, "eval", "runs"),
      extractor,
      minIntervalMs: 0,
      sleepFn: async (ms) => { waits.push(ms); },
    });
    expect(res.dailyQuotaHit).toBe(false);
    expect(res.completed).toBe(res.total);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it("400は記録して続行する", async () => {
    const dir = await setupDir(["a.pdf", "b.pdf"]);
    const extractor: Extractor = {
      async extract(_b, _m, filename) {
        if (filename === "a.pdf") {
          const e = new Error("400 INVALID_ARGUMENT bad request") as Error;
          throw e;
        }
        return structuredClone(data());
      },
    };
    const res = await runEval({
      model: "m2",
      repeats: 1,
      samplesDir: path.join(dir, "samples"),
      expectedDir: path.join(dir, "samples", "expected"),
      outMd: path.join(dir, "eval", "results.md"),
      runsDir: path.join(dir, "eval", "runs"),
      extractor,
      minIntervalMs: 0,
      sleepFn: async () => {},
    });
    // 最後まで走り切る（2件中1件成功＋1件エラー記録で完了扱い）
    expect(res.completed).toBe(res.total);
    expect(res.dailyQuotaHit).toBe(false);
    const md = await readFile(path.join(dir, "eval", "results.md"), "utf-8");
    expect(md).toContain("m2");
  });
});
