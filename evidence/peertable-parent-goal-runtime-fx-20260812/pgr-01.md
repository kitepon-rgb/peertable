# pgr-01 完了証跡 — 親Goal案を単純な番犬へ縮小

## 結論

durable Goal、watch generation、heartbeat、typed runtime receipt、親liveness再定義は実装しなかった。
親DMの受信に必要なのは、roomを一秒周期で監視し、DMを検知した時だけ現在のCodex / Claude親へ
返す継続watcherであり、既存実装で成立した。

## 採用した成果

- `71b9056` — Codex / Claude共通の `parent-watch.mjs` とfocused harness
- `665457c` — watcherを一回応答で終了しない一世代の継続監視へ修正
- `1ad6cc8` — Codex親をbackground pollから現在のtaskへ戻す経路へ修正
- poll間隔は一秒。空のpoll結果では親ターンを起こさず、DM到着時だけ返す。

## 非採用

- durable Goal identityと専用runtime receipt
- generation / heartbeatによる新しいliveness契約
- 親をworker capacityへ混ぜる変更
- turn-completedを独自イベントとして扱う追加機構

これらは今回のDM配送に不要で、運用と実装を重くするため採用しない。

## 実測

- Peertable DM `#736`〜`#740` がbackground watcherから現在のCodex taskへ到達した。
- 同一DMの二経路配送を観測し、後続修正で現在taskへの配送経路へ絞った。
- 現行 `parent-watch` は本セッションでも継続稼働し、room seq `1040`、`1041` を受信した。

## 完了判断

本工程は当初設計を実装した成功ではなく、必要な機能を既存の単純な番犬へ縮小して成立させた記録として
完了する。a6の前提として必要なのは「親へDMが届くこと」だけであり、上記で満たす。
