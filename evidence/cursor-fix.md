# 0.2.1 — 受信カーソルの取りこぼし修正

担当: tsumugi（`room/client.mjs` の修正・再現ハーネス）／ akari（release 経路・実機確認・正典反映）
2026-08-08

## この作業単位の記録の形（Lattice plan の外である）

円卓改良 campaign（plan `roundtable-improvement`）は t1〜t5 が全て done で、phase `p1` は **`accepted`**
（review → accept 済み・決定証跡 `evidence/p1-audit.md`）。**閉じた受入単位へ後から task を足さない**という
判断で、0.2.1 は plan の外の作業単位として扱い、`lattice todo` を一切叩いていない。

正本要件（憲章1「拘束力を持つのは工程正本への記録と room での決定」）は **room の決定＋repo の証跡**で満たす。
room の決定は [51]（発見）[52]（独立照合）[53]（オーナー裁定: 直して 0.2.1 を publish）[54][55][56]（担当・
修正の形・記録の形の合意）。`.team/` は teardown で消えるため、事実は本証跡と決定52 が repo 側に持つ。

## 欠陥

`room/client.mjs` の `post` ハンドラが成功時に `cursor = Math.max(cursor, msg.seq)` を実行しており、
**自分の post より前に届いた未読が、読まれないまま既読になっていた**。`read_unread` 側のカーソル更新は正しい。

channel の起床通知は飛ぶのに `read_unread` が「未読なし」を返すため、受け手は通知をノイズと解釈する。
**沈黙の失敗**であり、0.2.0 の diagnostics（5 check green）も setup smoke も緑のまま通過した。

**取りこぼすのは受信者ではなく発言した本人**——卓で最もよく喋る人＝調整の中心にいる人から順に情報を落とす。

## 実運用での実測（この campaign 中に4件。全て akari の席で発生）

| # | 時刻 | 状況 | 失われたもの |
|---|------|------|---|
| 1 | 10:13 | [6]（t1 の claim）を post した直後の `read_unread` が「未読なし」 | tsumugi の **[5]＝t1 の先行 claim**。`read_log` で拾って claim 衝突に気づいた |
| 2 | 10:14 | [10] を post した直後 | tsumugi の [9]（譲り合いデッドロックの解消） |
| 3 | 10:41 | [43] を post した直後 | tsumugi の [42]（join の宣言と設計判断） |
| 4 | 10:55 | [55]（**この欠陥の修正方針を議論する発言**）を post した直後 | tsumugi の [54]（修正の形の宣言） |

1件目は claim 衝突の発見を遅らせている。room [37] で「機械の事実で解いた」と書いた局面は、
**実際には取りこぼしを `read_log` で手作業で埋めて解いていた**。

## 修正（tsumugi・commit `ef43be5`）

- `post` ハンドラの `cursor = Math.max(cursor, msg.seq)` を削除（理由をコメントで残した）
- `MCP_VERSION` を 0.2.1 へ
- `experiments/cursor-repro.mjs` を追加（実プロセスを JSON-RPC で駆動し「他人の発言 → 自分の post →
  read_unread」の順序を再現する）。テスト framework は入れない（決定36）
- `room/server.mjs` は無変更（欠陥は client 側のカーソル管理だけ）

## akari による独立検証（実装者の報告を鵜呑みにしない）

同一のローカル room サーバー（`PEERTABLE_PORT=18901`）に対し、**修正前と修正後の両方を自分で踏んだ**:

- **修正前**（`git show ef43be5^:room/client.mjs` ＝ publish 済み 0.2.0 の実物）:
  `post → sent [6]` の直後の `read_unread` が **「未読なし」**／harness の判定 **「取りこぼした（欠陥あり）」**
- **修正後**（作業ツリー）: `read_unread → [2] bob → all …: 取りこぼされてはいけない発言`／
  判定 **「取りこぼさなかった（修正済み）」**

## release と実機確認（akari）

| # | 作業 | 結果 |
|---|------|------|
| 1 | bump | `npm version 0.2.1 --no-git-tag-version`（package.json ＋ lock）— commit `b5387b9` |
| 2 | push | `3c4373b..ef43be5` |
| 3 | 祖先確認 | `git merge-base --is-ancestor ef43be5 origin/main` → OK |
| 4 | publish | `+ peertable@0.2.1` |
| 5 | global install | 下記の npm キャッシュの罠を踏んだ |
| 6 | 実機確認 | `peertable-client diagnostics --json`（global 0.2.1 の実体）→ 5 check `pass`・overall `ready`・**exit 0** |
| 7 | 配布物の非再現 | **`experiments/cursor-repro.mjs` を `/opt/homebrew/lib/node_modules/peertable/room/client.mjs` に対して実行** → 「取りこぼさなかった（修正済み）」。修正が配布物そのものに入っていることを直接確認 |
| 8 | 実体の確認 | installed 実体の `MCP_VERSION = '0.2.1'`／`grep "cursor = Math.max"` が**無出力** |

**踏んだ罠（release 手順として記録する）**: publish 直後の `npm install -g peertable` は
**npm のメタデータキャッシュにより 0.2.0 を入れた**。`npm view peertable version` も 0.2.0 を返した。
一方 `npm view peertable versions --json` は `["0.1.0","0.2.0","0.2.1"]`、`dist-tags.latest` は `0.2.1` で、
**レジストリ側には確実に入っていた**。`npm install -g peertable@0.2.1` と版を明示して解決。
publish 直後の実機確認では、版を明示するか `versions` / `dist-tags` で確認しないと**古い版を新版だと誤認する**。

## 正典反映（akari・本 commit）

- `docs/plan.md` の状態行を 0.2.1 へ
- **決定52「受信カーソルは読んだ時だけ進む」**を追加。次に client を触る人が同じ最適化（自分の発言は既読で
  いいはず）を思いつく確率が高いので、不変条件として条文化した
