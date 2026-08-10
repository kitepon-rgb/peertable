# terminal-audit — roundtable-ux2-20260810

判定: **受理**（親 bell・2026-08-10）

## 受理の根拠

**受理の根拠は、所見が room に出ていることである**（決定60）。親はコードを読んでいない。

| task | 実装 | 独立監査（実装者以外） | 所見 |
|---|---|---|---|
| t1 room/server.mjs | tsumugi | kotone（room [14]） | finding無し |
| t2 skill/scripts | kotone | tsumugi（room [11]） | finding無し |
| t3 room/client.mjs | tsumugi | kotone（room [17]） | finding無し |
| t4 手順書・計画書の同期 | tsumugi | kotone（room [26]） | finding無し |

各監査は diff を実読したうえで、監査者自身の手元で独立に再実測している（t1: 自前サーバー起動で
`event: member` の発火境界／t2: 再現ハーネス7/7と既存9/9の退行なし・不正 effort の着席前拒否／
t3: `event:` 行の綴りが t1 実装と一致することを grep 実測／t4: citation の file:line 全件突合）。

## 親が実測した最終確認

campaign の目的は「参加者一覧で『席にいるけど動いていない』と『席にいて仕事をしている』を
見分けられること」であり、**コードが在ることでは閉じない**。親が公開面まで通して実測した。

**ローカル（最新コード・使い捨て room）でのDOM実測**:

```
member イベントの選択的送出
  status_at だけ更新       → イベント出ない
  pane_token_hint だけ更新 → イベント出ない
  status を busy→idle      → イベント1件
  ＝3回POSTして member_event_count は 1（設計どおり閲覧欄だけで発火）

参加者一覧
  chip "is-busy"    dot "st busy"     状態 作業中   claude / sonnet / medium
  chip "is-blocked" dot "st blocked"  状態 承認待ち  claude / sonnet / low

発言の逐次出現（computed style）
  animationName: block-in / duration 0.32s / fill-mode both
  ブロック遅延 0ms → 90ms → 180ms → 270ms → 360ms（P・P・UL・PRE・P）
```

**本番（peertable.kitepon.dev・image `20260810-c80f333`）**:

```
公開面のコード  st.blocked / seat-blocked / block-in / member listener / 承認待ち  すべて在
会話ログ        43件保持（image 入替で消えていない）
summary 口      生存（先行 campaign の成果を壊していない）
SSE 心拍        event: ping 受信
参加者一覧      tsumugi is-idle「状態 待機」/ kotone is-idle「状態 待機」/ bell 点なし
```

**bell に点が出ないのは正しい。** 親は tmux 席を持たないので観測対象外であり、`dead`（席が落ちた）
ではない。f1 がこの区別を入れた。

## 測定器を先に疑った記録

親の実測中に tsumugi の状態が一度 `unknown` へ落ち、欠陥かと疑った。原因は**親が使った
`date -u +%3N` が BSD date で効かず**、`2026-08-10T13:53:47.3NZ` という壊れた `status_at` を
送っていたことだった。UI は不正な時刻を正しく `unknown`（報告途絶）へ落としており、**製品は正しく、
測定器が壊れていた**。同じ POST で `.000Z` を送った kotone は `blocked` を正しく表示していた。

## 申し送り（修正を求めない）

- **本 campaign の受入条件の外で欠陥を1件発見し、follow-on `roundtable-ux2-fx-20260810`（task f1）
  として分離した。** `seat-status-bridge.mjs` が tmux へ `-S <socket>` を渡さず、生きている席を
  全て `dead` と送っていた欠陥である。t1〜t4 のどの受入条件にも入っていなかったので、席が
  スコープを守ったのは正しい。f1 は完了・受理済み。
- **Lattice CLI の並行 start 欠陥**: t4 で同一 task の `lattice todo start` が2席で二重成立した
  （journal に sequence 6 と 7 の両方）。卓が room claim の先着3秒差を機械の事実として採用し、
  内容の混在のみで解消（消失なし）。**peertable 側の欠陥ではない**ので本 campaign では直さない。
  記録先はこの節と room [25]。
- **p4（コストの金額換算）は据え置き。** トークン概算（`pane_token_hint`）は出ているが、金額換算は
  今回の対象外である。実装しなかったものとして明記する。
