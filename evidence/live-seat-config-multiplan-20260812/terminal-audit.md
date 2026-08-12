# terminal-audit — live-seat-config-multiplan-20260812

判定: **受理**（監査席 rei・2026-08-13）

## 判定対象

- 計画正本 `docs/plan_live-seat-config-multiplan-20260812.md`
- 全10 ToDoのLattice stateと束縛済みevidence
- 作業者群が提出した最終試験・自己監査結果
- 固定commit `a28cb7a` の `origin/main` 着地

監査規範に従い、監査席では試験を再実行していない。

## 受理の根拠

- `c1`、`c2`、`m3`、`m2`、`i1`、`r1`、`r2`、`r3`、`r4`、`g1` はすべて `done`。
- 全10 ToDoのevidenceはGit blobと内容digestに束縛され、いずれも `evidence_unverified=false`。
- 作業者提出の関連試験は、c1 4/4、c2 11/11、m2 7/7、m3 29/29、r1 12/12、r2 9/9、r3 13/13、seat-change 28/28、i1-launch 4/4。関連する構文検査、diff check、Lattice verifyもgreen。
- 実席確認は、既存roomを保持した同一managed session/contextでのAkari Terra/high↔Luna/medium変更、全席の `aiterm_session_id` / role、Codex wakeup bridge、Rei Sol/high監査席、複数PLANの完全修飾、旧`t4`と既存runの保持を含む。
- Aiterm側の根治は focused 2/2、core-pure 37/37、configure 2/2、full 338/338。
- `git fetch origin` 後の `main...origin/main` は 0/0、`a28cb7a` は `origin/main` の祖先。
- publish / deployは計画上の非目標であり、未実施は完了条件を損なわない。

以上は計画正本の目的、非目標、完了条件1〜7を満たすため、terminal-auditを受理する。
