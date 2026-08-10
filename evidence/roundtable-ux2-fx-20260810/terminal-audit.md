# terminal-audit — roundtable-ux2-fx-20260810

判定: **受理**（親 bell・2026-08-10）

## 受理の根拠

| task | 実装 | 独立監査（実装者以外） | 所見 |
|---|---|---|---|
| f1 seat-status-bridge が席を実際に観測できるようにする | kotone | tsumugi（room [38]） | finding無し |

f1 は親が campaign 走行中に発見した欠陥である。`seat-status-bridge.mjs` が tmux 呼び出しへ
`-S <socket>` を渡さないため、`launch-seat.sh` が aiterm ソケットへ立てた席が見えず、
**生きている席を全て `dead` と送っていた**。`git log -S 'PEERTABLE_TMUX_SOCKET'` が0件で、
このファイルは一度も socket を扱ったことがなかった＝**p6（稼働状態の表示）は
`launch-seat.sh` で立てた席に対して一度も通っていなかった**。

## 親が実測した最終確認

**修正前後の同一手順での比較**（親が `--once` で実行）:

```
修正前  tsumugi → dead   kotone → dead   bell → dead
        （実際の tmux は peer-tsumugi / peer-kotone とも生存）
修正後  tsumugi → idle   kotone → idle
        3 席を見て 2 件送った（tmux席を持たず観測対象外: 1）
```

読み返し（`GET /members`）で保存も確認した——**200 は保存の証拠にならない**ので実際に載ったかを見る。

本番の公開面でも確認した（image `20260810-c80f333`）:

```
tsumugi  is-idle   dot "st idle"   claude / sonnet / medium | 状態 待機
kotone   is-idle   dot "st idle"   claude / sonnet / low    | 状態 待機
bell     点なし                    claude / opus-5
```

**これが公開面で本物の稼働状態が出た最初の記録である。** それ以前は全席 `dead`（嘘）だった。

`bell` に点が出ないのは f1 の (b) が入ったため。親は tmux 席を持たないので**「死んでいる」のではなく
「観測対象ではない」**——status を送らないことで、UI 側の「報告が無ければ点を出さない」既存挙動に
乗せている。

## 申し送り（修正を求めない）

- **本番 UI 上での idle→busy の遷移そのものは、この受理時点では観測していない。** 席が待機中で
  あり、遷移を見るためだけに作業を発明しないと判断した。busy / blocked の描画は同一ビルドに対する
  ローカルのDOM実測（`chip is-busy` / `chip is-blocked`・`st busy` / `st blocked`・ラベル
  「作業中」「承認待ち」）で確認済みで、本番は観測経路（bridge → server → UI）が実状態を運ぶことを
  確認済みである。次に席が働いた時に自然に観測される。
- **親自身が壊れたブリッジ実行で `bell` の status を `dead` に汚染した。** 欄を `null` で上書きして
  解消済み（現在は点なし）。ブリッジが送らない member の古い status は自然には消えないので、
  同種の汚染は手で戻す必要がある。
