# roundtable UX 終端監査

## 結論

`roundtable-ux-20260809` は受入可能。p1〜p5はすべてdoneで、各task証跡は
storeに固定されたSHA-256とblob OIDへexact一致した。live発言のflow、既存member
popover、本人要請によるeffort変更、席ごとの消費表示、発言番号表示について、
残存する再現欠陥はない。

## 独立確認

- p1 source `4f61504` はKanadeが隔離server/browserで独立監査し、historyでは流れず
  live発言だけがflowすること、重複animationがなくreduced-motion規則と一時資源の
  cleanupがあることを確認した。残存findingなし（room `[1918]`）。
- p2は既に受理済みの `refit-add-20260808/t14` を再利用し、現行HEADでserver/meta/UI、
  配信client構文、launch-seat構文を再実測した。Kanadeの独立監査もgreen（room `[1646]`）。
- p3 source `22103dc`、`3c6120e`、`1186c9d` の初回監査で、複数宛DMからeffort変更を
  認可できる欠陥が見つかった。`993630a` で親本人へのexact DMだけへ限定し、Yuzuが
  実server経由の負例・正例を再監査して受理した（room `[2000]`）。
- p4 source `cc54ece` の初回監査でfresh capability/bootstrapと1分未満表示の欠陥が
  見つかった。`4097b2f` で補正し、Kanadeが実DOM・reproを再監査して受理した
  （room `[1717]`）。
- p5 source `ac952b9` はAkariが実browserで発言番号、history/liveの重複なし、
  legacy行互換、cleanupを独立監査した。旧sourceへ当てた負側はred、現sourceはgreenで、
  残存findingなし（room `[1600]`）。

## 現HEADでの統合実測

- `node experiments/room-live-flow-repro.mjs`: green
- `node experiments/explicit-recipients-repro.mjs`: 全項目green
- `node experiments/effort-change-repro.mjs`: 10/10 green
- `node experiments/seat-usage-repro.mjs`: 9/9 green
- `node experiments/member-repost-noise-repro.mjs`: 4/4 green
- `node --check`（server / client / seat status bridge / seat usage helper）: green
- `bash -n`（change-effort / launch-seat）: green
- `git diff --check`: green
- `lattice todo verify --json`: rc 0、schema v3、snapshot fresh、12 members verified、
  result digest `84077ceb5cd43e2d2aa4102220a428e221b90412c04a5a4139b76a00777ee8cc`
- p1〜p5 evidenceのSHA-256とblob OIDは各done eventへexact一致した。
- task stateはp1〜p5すべてdone、active/readyは0、terminal-auditだけがgate_readyだった。
- focused repro後の作業treeはcleanだった。

## 判定

再現欠陥なし。`terminal-audit` をacceptする。
