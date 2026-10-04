import { describe, it, expect } from "vitest";
import { corporateCheckDigit, isValidRegistrationNumber } from "../src/validate.js";

// チェックデジットの重み順を固定する正解値テスト
// 国税庁方式: 下12桁を右から 1,2,1,2... で加重合計し、合計を9で割った余り(0〜8)を9から引く(結果は1〜9)。
describe("チェックデジット正解値", () => {
  it('公表例: 法人番号7000012050002 → base12 "000012050002" の検査数字は "7"', () => {
    // 右から: 2x1+0x2+0x1+0x2+5x1+0x2+2x1+1x2+0x1+0x2+0x1+0x2 = 2+0+0+0+5+0+2+2+0+0+0+0 = 11
    // 11 % 9 = 2 → 9-2 = 7
    expect(corporateCheckDigit("000012050002")).toBe("7");
    expect(isValidRegistrationNumber("T7000012050002")).toBe(true);
  });

  it('非対称例1: base12 "120345678901" → "7"', () => {
    // 右から: 1x1+0x2+9x1+8x2+7x1+6x2+5x1+4x2+3x1+0x2+2x1+1x2
    // = 1+0+9+16+7+12+5+8+3+0+2+2 = 65 → 65%9=2 → 9-2=7
    // 左右非対称(逆順 "109876543021" とは結果が異なる)なので重み順の取り違えを検出できる
    expect(corporateCheckDigit("120345678901")).toBe("7");
    expect(corporateCheckDigit("109876543021")).not.toBe("7");
  });

  it('非対称例2: base12 "234567890123" → "9"', () => {
    // 右から: 3x1+2x2+1x1+0x2+9x1+8x2+7x1+6x2+5x1+4x2+3x1+2x2
    // = 3+4+1+0+9+16+7+12+5+8+3+4 = 72 → 72%9=0 → 9-0=9
    expect(corporateCheckDigit("234567890123")).toBe("9");
  });

  it('非対称例3: base12 "100000000001" → "6"', () => {
    // 右から: 1x1+0x2+0x1+0x2+0x1+0x2+0x1+0x2+0x1+0x2+0x1+1x2 = 1+0+...+2 = 3
    // 3%9=3 → 9-3=6。先頭と末尾だけが1の非対称配置で重み(右端=1, 左端=2)を検証できる
    expect(corporateCheckDigit("100000000001")).toBe("6");
  });
});
