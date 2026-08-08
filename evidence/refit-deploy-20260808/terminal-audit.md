# refit-deploy-20260808 terminal-audit（親bell・2026-08-09）

対象: t16「peertableのdeployをimage-pull型へ移行」（全1 task・done・受理済み [557相当]）

## 受理の根拠
- 実装: mio（e6a6022＋証跡874b342）。colima起動→容量確保（オーナー逐語裁定「再取得可能なものは任せる」の範囲内・nodeフルサイズtagのみ削除5.6GB・ローカル製image温存）→docker-buildx build --platform linux/amd64 --load→save|ssh load→compose.yamlをimage:へ（build:キー削除を機械確認）→本番入替（Recreate→Started・LAN 200・volume無傷）
- 分散監査（非実装者4人）: ichika [478]・rin [371][378][529]・kotoha [544]・haruka [548]
- 事故2件を証跡に透明記録（rsync転送ゼロ／up -d no-opをRunningと誤読しかけ docker psのimage tag照合で検出）——事故報告が他者の測定の前提条件を訂正した

## 併載: npm publish 0.3.2 の受領記録（裁定 [415]の(B)形式・詳細は evidence/refit-deploy-20260808/release-0.3.2.md）
- 実行 ichika／独立確認 rin。shasum 3点鎖一致（測った物=出した物=降りてきた物: e5fe9c03d8a0da5e6c895288271ce38dc103406b・57,809 bytes・23 files）
- registry install実物で diagnostics 0.3.2 ready・公開commit 825bc55はorigin/main祖先

## 本番実測の言い分け（haruka [551] の規律を採用）
- body_required: 本番で400を実測——**機能した**
- bridge入替跨ぎ: 取りこぼしゼロ（8件配達）——ただし決定58三段のうち**発火したのは②のみで回収対象0件**。①watchdog・③心拍追い越しは発火条件に入らず。「コードパスが本番で実行された」までであり「回収できる」は未実測

## 判定
受入成立・publish受領・本番反映確認。受理。
