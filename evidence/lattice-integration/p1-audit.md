# phase p1「円卓×工程表統合」終端監査ダイジェスト（bell・2026-08-08）

計画正本: docs/plan_2026-08-08_lattice-integration.md（オーナー承認済み）。工程正本: Lattice plan `lattice-integration` v1（t1〜t7）。

## 受理記録（各done時の実物照合）

| task | 担当 | 受理 | 照合した実物 |
|---|---|---|---|
| t1 外部ペイン機構 | ichika | [32] | Lattice eeae898（静的部品・自己完結テスト不変）＋追補 f9896eb（gantt serve配線・[33]の停止指摘起点） |
| t2 note遺物削除 | mio | [26] | Lattice 5ccc4f7（git grepで根絶・ADR 0153注記・9ファイル） |
| t3 チャットUI+CORS | kotoha | [98] | 5de6f61（CORS読み取り系限定・入力欄ゼロ）＋bellの実起動目視 |
| t4 コネクタ+高速化 | haruka | [39] | e78f029（script4本・done.sh証跡パス修正・external-pane退避復元） |
| t5 Codex席+bridge | haruka | [57] | fa522b5（Codex実席の発言・busy中steering実測）＋追補 f9048ab/387bce0/2cc86c0 |
| t6 Lattice 0.50.0 | mio | [51] | 37022c4・npm 0.50.0・公開面にnote実掲載・daemon入替 |
| t7 release/deploy/正典 | mio | 本監査 | MS-A2 deploy（CORS前後比較）・npm 0.3.0→0.3.1・prepublishOnly gate 1fd54ee・決定55〜58・e2e本番実測 |

## 出荷物（bellの独立照合込み）

- @quolu/lattice **0.50.0**（外部ペイン汎用機構・note全面掲載）— lattice.kitepon.dev 実機確認
- peertable **0.3.1**（新チャットUI・CORS・SSE心拍/watchdog/since回収・Codex席・bridge・立卓script群・機械gate）
  — install実物で diagnostics ready。**0.3.0 は version_consistency fail の欠陥版**（正典に「使わない」明記）
- 本番e2e: 円卓タブの既定切替（viewState=external）・CSP最小開放・撤去で痕跡ゼロ・SSE復帰75秒/2件回収/重複ゼロ

## 途中の裁定・是正（監査側の誤りも含む）

- [58] bellの規律事実認定（t5宣言なし）は**誤り**→[65]で撤回（宣言は[37]末尾に実在。原因は監視の切り詰めと見出し走査）。
  再発防止は決定57（規律の判定はroomの本文を引き直す）へ。
- t5受理文[107]が実装の一歩先を記述→kotohaが859bc21で実装に揃えた。
- オーナー発見の欠陥2件（公開UIのSSE沈黙[92]・0.3.0版数drift[148]）はいずれも即日修正・本番/実物で検証済み。
- t7 done時に未push3本→[167]の所見で是正後に受理。

## 判定

全taskは受理済み・証跡束縛済み・公開面（npm 2 release・MS-A2 deploy・lattice.kitepon.dev）まで実機確認済み。accept。
