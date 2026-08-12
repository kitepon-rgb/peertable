# Lattice試験結果項目への円卓完了フロー結線（lattice-test-result-bridge-20260813）— 計画正本

日付: 2026-08-13
状態: Lattice storeへbacklog登録し、外部成果物が届くまで着手しない
外部契約ID: `lattice.todo_test_result.v1`

## 目的

既存の「作業者が自己試験・自己監査し、最終試験結果を監査担当へ渡す。監査担当は再試験せず妥当性を
判断してcloseする」流れを、LatticeのToDo正式項目`test_result`へ薄く結線する。監査DMとcommit済み
evidenceは維持し、後工程が`lattice todo show`一回で試験結果サマリーと証跡記述子を読めるようにする。

## 外部成果物前提

現行Lattice 0.58.4のcross-plan dependencyは同一project store内に限定され、別projectは
`DEPENDENCY_INVALID / dependency_project_mismatch`で拒否される。このためproject横断edgeは作らない。

先頭工程は、次の全条件が実測されるまでexternal dependencyとしてblockedにする。

- Latticeの公開releaseが契約ID`lattice.todo_test_result.v1`を宣言している。
- そのrelease versionが実行端末へglobal install済みで、`lattice --version`とruntimeが一致する。
- 一時projectの`todo show --json`で`test_result`と既存evidence descriptorを同時に取得できる。

Lattice側ToDoのdoneは進捗情報にすぎず、この利用可能条件の代わりにしない。対応versionが確定したら、
本planのnote/evidenceへexact versionを記録してからunblockする。

## 契約

- 作業者は既存どおり自己試験・自己監査を終え、最終試験内容と結果を監査担当へDMし、同内容を
  evidenceへ残す。作業者自身はcloseしない。
- 監査担当は提出内容を元PLAN・工程正本・受入条件に照らして判断し、試験を再実行しない。妥当なら
  `.team/scripts/done.sh`の正規入口から同じ最終試験サマリーをLatticeの`test_result`へ記録してcloseする。
- `done.sh`は証跡記述子を従来どおり生成・束縛し、Latticeの公開CLIだけを呼ぶ。store直書き、別台帳、
  room API変更、試験結果の自動生成・採点は行わない。
- 単独円卓モードはLatticeを使わない既存契約のまま変更しない。

## 工程

### ptr1 作業者から監査担当への最終試験結果をLatticeへ記録する

上記外部成果物前提を満たした後、member/charterの既存監査手順と`done.sh`の完了入力を最小限に結線する。
通常worktreeとpull型`--evidence-from`の両方で、監査担当が提出済み文章をそのまま`test_result`へ渡し、
evidence descriptor、done readback、監査DM、run accept/landingの既存鎖が変わらないことをfocused fixtureで
確認する。`room/`の新機能は作らない。

### ptr2 配布物へ載せ、既存卓と新規卓でconsumer smokeを行う

ptr1をpeer audit後に既定ブランチへ着地させ、package payloadとupgrade/setup経路を確認する。publishは
オーナーの明示承認後だけ行う。対応Peertable versionを導入し、新規卓と管理対象assetを更新した既存卓で、
作業者の提出、監査担当の無再試験判断、`done.sh` close、`todo show`一回の試験結果/evidence読出しを通す。

## 依存と完了条件

Peertable内は`ptr1 → ptr2`。ptr1は契約ID`lattice.todo_test_result.v1`の対応Lattice releaseがglobal導入済み
になるまでblocked。完了時はLattice version、Peertable version、監査DM、evidence descriptor、
`test_result`読返しを対応付け、二重の正本を作っていないことを確認する。
