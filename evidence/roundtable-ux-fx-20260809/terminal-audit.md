# p6 終端監査

## 結論

`roundtable-ux-fx-20260809` は受入可能。memberのfreshな稼働状態が観客へ伝わり、
live完了だけが一度祝祭される。history・重複・非完了発言では再生せず、
reduced-motionと一時資源の後始末まで確認済みで、残存する再現欠陥はない。

## 独立確認

- source `b8e74ed`、task証跡 `2918e32`、done state `4125277` の実diffを確認した。
- fresh busyはchip/avatar/status dotへ作業中animationを出し、既存のlive発言pulseと合成する。
  idle・dead・stale由来unknownには作業中animationを付けない。
- 完了判定はsystem以外の先頭markerに限定し、重複排除後のlive SSEだけから祝祭を呼ぶ。
  history/catch-upでは再生せず、祝祭要素は1600ms後に除去する。
- Nagiの独立実browser監査 `[2022]` は、別data・port 18934でfresh/live/history、
  negative/positive、自動除去、reduced-motion、console error 0を実DOM確認した。
  tab・server・tempは終了時にすべて除去されている。
- `node experiments/member-activity-fx-repro.mjs`、`node --check room/server.mjs`、
  対象rangeの`git diff --check`はgreen。旧sourceへ当てた負側がredになる感度もtask証跡にある。
- evidenceのSHA-256 `408dcfe71b3b786c0697944c0c8eb7f9ebe2ae1404bbb35e51e8747a6ec69d10`と
  blob OID `2e9fded522bd4e0658e7a61c3edd29991ebe452e`はdone eventとexact一致した。
- task stateはdone、evidence verified、terminal-auditはreviewing、作業treeはcleanだった。

## 判定

再現欠陥なし。`terminal-audit` をacceptする。
