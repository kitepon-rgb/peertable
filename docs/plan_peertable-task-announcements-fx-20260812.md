# Peertable 着手入口の既存卓配布修理 companion（peertable-task-announcements-fx-20260812）— 計画正本

日付: 2026-08-12

## 1. 発見した欠陥

main campaign の a2 は配布元 `skill/templates/start.sh` / `start-event.mjs` と
`skill/scripts/setup.sh` の新規卓向け生成を実装済みだが、既存の卓
`peertable-autonomy-runtime-20260811` には `.team/scripts/done.sh` しかなく、正規着手入口が欠落していた。
既存卓へ新規卓用の scaffold を無条件再実行すると、利用者資産・他工程資産の上書き境界を壊す。

## 2. 契約

Peertable が所有して同期してよい生成物は、次の2ファイルだけとする。

- `.team/scripts/start.sh`
- `.team/scripts/start-event.mjs`

入力は既存 `.team/setup-state.json` と同じ repo の配布元 template 2本。対象が欠落していれば生成し、既存内容が配布元と一致すれば no-op とする。対象外の `.team` 資産、利用者ファイル、credential、room設定、seat identity、Lattice store は読取以外の変更をしない。対象ファイルが存在するが配布元と一致しない場合は typed reject し、上書きしない。

## 3. 工程

### u1 既存卓へ着手入口を安全に配布する

入力は `.team/setup-state.json`、`skill/templates/start.sh`、`skill/templates/start-event.mjs`。正規 upgrade 入口は
`skill/scripts/upgrade-team-assets.sh` とし、管理対象2ファイルだけを allowlist で検証する。Lattice mode / standalone mode の setup-state を読み、setup-state が壊れている、対象 project が不一致、管理対象以外へ書こうとする、または既存対象が template と異なる場合は副作用前に typed reject する。

正負 fixture は、欠落2ファイルの生成・一致時no-op・既存不一致の拒否・対象外ファイルと credential の不変を確認する。適用後は同じ入口 `.team/scripts/start.sh` から a6 を claim し、successful start 後に started event が全席へ一度だけ届くことを実測する。

修理対象は generated asset の配布だけであり、`room/client.mjs`、既存 `.team/scripts/done.sh`、role本文、credential、seat-status/wakeup bridge、Lattice本体の仕様は変更しない。

## 4. 構造データ

- 入力: `.team/setup-state.json` と配布元 `skill/templates/start.sh` / `skill/templates/start-event.mjs`。
- 整理: `skill/scripts/upgrade-team-assets.sh` が setup-state と allowlist を検証し、欠落または一致済みだけを安全に扱う。
- 出力: `.team/scripts/start.sh` / `.team/scripts/start-event.mjs` と、正規入口からの started event。
- 利用先: `.team/scripts/start.sh`、`skill/templates/start-event.mjs`、diagnostics、a6の実席統合。

## 5. 完了条件

1. u1 が実装者以外の正式席による peer audit を受け、正負 fixture green 後に done である。
2. generated asset 2本だけが欠落卓へ配布され、対象外資産と不一致既存資産は変更されない。
3. `lattice todo structure input/compile` が consistent になり、structure digest と所有境界を room に記録する。
4. 適用直後、`.team/scripts/start.sh a6` の成功一回に対応する started event が全席へ一度だけ届く。
5. a6 の Wave 2 deploy と production smoke は、この修理の成立後に owner が承認した実席統合線で行う。npm publish は行わない。
