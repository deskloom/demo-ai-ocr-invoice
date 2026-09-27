# 評価結果

- 日時: 2026-09-27T00:04:00.861Z
- モデル: gemini-3.5-flash-lite
- 完了: 14/14回
- 各書類を1回ずつ読み取り
- 金額（数量・単価・金額・小計・税額・合計）は完全一致で比較
- lineItems は件数と各行の品目名・数量・単価・金額の完全一致、taxBreakdown は税率別の対象額と税額の完全一致で比較

## 項目別正答率
| 項目 | 正答率 | 正解数/試行数 |
|---|---|---|
| docType | 100.0% | 14/14 |
| issuer | 100.0% | 14/14 |
| registrationNumber | 100.0% | 14/14 |
| issueDate | 100.0% | 14/14 |
| dueDate | 100.0% | 14/14 |
| documentNumber | 100.0% | 14/14 |
| lineItems | 100.0% | 14/14 |
| subtotal | 100.0% | 14/14 |
| taxBreakdown | 100.0% | 14/14 |
| total | 100.0% | 14/14 |
| currency | 100.0% | 14/14 |

## 書類別
| ファイル | 期待:要確認 | 実際:要確認(いずれか) | 回ごとの正解項目数 | ぶれ(回で変わった項目) |
|---|---|---|---|---|
| inv-01-clean-10pct.pdf | OK | OK | 11/11 | - |
| inv-02-mixed-8-10.pdf | OK | OK | 11/11 | - |
| inv-03-many-lines.pdf | OK | OK | 11/11 | - |
| inv-04-image.png | OK | OK | 11/11 | - |
| inv-05-scan-tilt.jpg | OK | OK | 11/11 | - |
| inv-06-bad-math.pdf | 要確認 | 要確認 | 11/11 | - |
| inv-07-bad-reg.pdf | 要確認 | 要確認 | 11/11 | - |
| inv-08-bad-date.pdf | 要確認 | 要確認 | 11/11 | - |
| inv-09-dup-a.pdf | OK | OK | 11/11 | - |
| inv-10-dup-b.pdf | 要確認 | 要確認 | 11/11 | - |
| inv-11-bad-tax.pdf | 要確認 | 要確認 | 11/11 | - |
| inv-12-bad-date2.pdf | 要確認 | 要確認 | 11/11 | - |
| rcp-01-simple.pdf | OK | OK | 11/11 | - |
| rcp-02-missing.pdf | 要確認 | 要確認 | 11/11 | - |

要確認の振り分け一致: 14/14

