# refit-live-20260808 terminal-audit（親bell・2026-08-09）

対象: t15「参加者一覧の稼働状態表示」（全1 task・done済み）

## 受理の根拠
- 実装: kotoha（bridge f3ee8a1・UI層は88d28a6へ同乗を工程noteで帰属記録）。busy/idle/dead/unknownの4状態・90秒減衰・members起点・変化時＋心拍POST・ADR 0157作法
- 監査: haruka [350]（members起点の妥当性・ハーネス3経路修正確認）＋ichika [351]（減衰境界の計算検証）＋ichika [369]（light実測: unknownの中空の輪が形で区別・requested/actual照合・指摘ゼロ）
- 偶然の実測: bridge停止＋90秒超で4席全部がunknownへ減衰（仕込みなしで受入本体が成立）
- 受入後の拡張提案（心拍10秒化）は分離し§11へ独立提案として記録（16ecc79・裁定 [358][365]）

## 判定
受入3点（状態切替実測・bridge停止で不明へ・CPU 0.0%/58MB）成立。受理。
