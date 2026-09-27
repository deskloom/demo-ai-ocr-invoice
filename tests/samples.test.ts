import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateBatch } from "../src/validate.js";
import type { ExtractedDoc } from "../src/types.js";

// FIX4: サンプルと正解の整合テスト
// samples/expected/*.json を validateBatch に通した needsReview が正解JSONの needsReview と一致する
describe("サンプルと正解の整合 (FIX4)", () => {
  it("全サンプルの needsReview が正解JSONと一致する", async () => {
    const dir = path.join("samples", "expected");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThanOrEqual(12);
    const docs: ExtractedDoc[] = [];
    const expectedByFile = new Map<string, boolean>();
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), "utf-8");
      const j = JSON.parse(raw) as { file?: string; data?: ExtractedDoc["data"]; needsReview?: boolean };
      const file = j.file ?? f.replace(/\.json$/, ".pdf");
      expectedByFile.set(file, j.needsReview === true);
      docs.push({ file, data: j.data as ExtractedDoc["data"] });
    }
    docs.sort((a, b) => a.file.localeCompare(b.file));
    const checked = validateBatch(docs);
    const mismatches: string[] = [];
    for (const d of checked) {
      const expected = expectedByFile.get(d.file);
      if (expected !== d.validation.needsReview) {
        mismatches.push(
          `${d.file}: 期待=${expected ? "要確認" : "OK"} 実際=${d.validation.needsReview ? "要確認" : "OK"} (${d.validation.reasons.join(" / ")})`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
