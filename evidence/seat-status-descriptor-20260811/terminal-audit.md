# terminal-audit（seat-status-descriptor-20260811）— 親裁定 2026-08-11

t1〜t4 の完了報告を鵜呑みにせず、親が全差分を読んで受入 A〜G を実測してから閉じる。

## 判定

**accept。** ただし t3 と t4 は一度 reject し、t3 は親が引き取って仕上げた。

| task | 担当 | 判定 |
|---|---|---|
| t1 socket 解決・観測記述子 | sakuya | accept（初回で仕様どおり） |
| t2 bridge・client の記述子化 | chinatsu | accept |
| t3 ensure-bridge・setup | himari → 親 | 一度 reject → 再修正 → **親が引き取って完了** |
| t4 launcher・wakeup・teardown | sakuya | 一度 reject → 再修正で accept |

## 受入の結果（証跡 evidence/seat-status-descriptor-fx-20260811/f2.md）

- **C = 31分59秒 / 240 tick**、呼び出し元シェル終了後も `status_at` が更新され続けた
- A-1（実 launch-seat）A-2（素 pane の client 自己申告）B D E F 通過
- G = 15 green / 7 red。**red 7本は着手前 5871e5b でも赤い**ことを worktree で確認＝本 campaign の範囲外

## 受入で見つけて直した欠陥（席の完了報告後）

1. `ensure-bridge.sh` が record を JSON として破壊（`"\\n"` がリテラル化）。`--stop` も再起動も不能になる
2. 死んだ常駐の stale `ready_at` で偽の起動成功。**この supervisor が塞ぐはずの穴そのもの**
3. tmux セッションへ env を渡しておらず、`PEERTABLE_TMUX_SOCKET` の手渡しが消えていた

また席が提出した `experiments/bridge-supervisor-repro.sh` は `ensure-bridge.sh` を一度も呼んでいなかった。
実物を呼ぶ5件へ書き直し、**1 と 2 はその書き直しで発見した**。

## 残した穴

`docs/plan.md` §未着手へ7件を記録済み。特に **room 不達で bridge が「黙って無になる」**は
オーナーが「検出したら粘る」を裁定済みだが、検出機能自体が本 campaign の範囲外だったため未消化。
