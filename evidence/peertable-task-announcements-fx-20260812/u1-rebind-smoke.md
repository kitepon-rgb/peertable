# u1 cross-plan rebind → a6 started 連続smoke（未実施草案）

## 固定した事実

- 2026-08-12 に `lattice status --json`（CLI `0.58.4`）を読取実測した。`state` は `invalid`、
  `next_action.reason` は `STORE_INCONSISTENT:binding_stale`、`result_digest` は
  `751b5f9e1fe34aaaa8b7fcdcb9e67f6f76eae2da2d0138c25ce4098b14cce3cd` だった。
- cross-plan edge は producer
  `peertable-task-announcements-fx-20260812/u1` から consumer
  `peertable-task-announcements-20260811/a6`。producer expected topology は
  `fb65fc35c79687a76bbf9edfd659f41155ee616999189dfed46dbe9641acef51`、current source topology は
  `16cd9906a4c6a588df1b358cc0a62cec17cc3fb986e307aad0151d91019f4654` で不一致。
- 根拠: `docs/plan.md` §2.5/§12、`docs/plan_peertable-task-announcements-fx-20260812.md` §2/§5、
  room #956/#957（edgeの実測値は room #961）。入力の機械可読な固定値は
  [u1-rebind-input.json](u1-rebind-input.json)、再現fixtureは
  [u1-binding-stale-rebind-repro.mjs](../../experiments/u1-binding-stale-rebind-repro.mjs)、実行可能な
  手順は [u1-rebind-continuous-smoke.sh](../../experiments/u1-rebind-continuous-smoke.sh) に置く。

## deploy後に確定する rebind receipt

新CLIは未到着のため、rebind は**未実施**。CLI名・引数・receipt schemaを推測して実行してはならない。

| 項目 | 値 |
|---|---|
| exact rebind command | `PENDING: deploy済みCLIの --help / --schema --json 実測後に逐語記録し、そのexact commandだけを包む実行可能fileを U1_REBIND_COMMAND に渡す` |
| 実行結果 | `UNVERIFIED: 新CLI未deploy` |
| 期待receipt schema | `PENDING: schema実測後に固定` |
| 必須receipt事実 | producer `...fx-20260812/u1`、consumer `...20260811/a6`、旧/新 topology digest、actor、時刻、成功状態 |
| 不許可 | `.lattice` 直編集、旧edgeの手編集、binding_stale中の structure compile/start を成功扱いすること |

## 連続smoke手順（すべて未実施）

1. `node experiments/u1-binding-stale-rebind-repro.mjs` を実行し、`binding_stale` と上記edgeを再確認する。
2. akari の新CLI deploy後、CLIの `--help` と `--schema --json` を読取り、**その実出力から確定した exact rebind command を一回だけ**実行する。stdout/stderr/exit code とreceipt全体を本書へ追記する。
3. `lattice status --json` が `state: "ready"` を返すことを実測する。`invalid`、`binding_stale`、または別の `next_action.reason` は失敗として止める。
4. 既存の `evidence/peertable-task-announcements-fx-20260812/u1-structure-input.json` を変更せず、まず `lattice todo structure input --plan peertable-task-announcements-fx-20260812 --input evidence/peertable-task-announcements-fx-20260812/u1-structure-input.json` を実行する。次に**公式writerが保存した** `.lattice/todo/structure/peertable-task-announcements-fx-20260812.json` を `lattice todo structure compile --plan peertable-task-announcements-fx-20260812 --input .lattice/todo/structure/peertable-task-announcements-fx-20260812.json` へ渡す。saved source を手編集せず、structure digest とconsistency receiptを記録する。
5. compile後にのみ rei へ u1 の限定再監査を依頼し、PASS/DEFECT と対象commitを記録する。PASS前にcurrent卓へ適用しない。
6. PASS後、`skill/scripts/upgrade-team-assets.sh /Users/kite/Developer/peertable` を実行する。allowlist内の同期結果、対象外資産・credential・room設定・seat identity・Lattice storeが不変であることを記録する。
7. `lattice todo status --json` で a6 が ready であることを確認してから、現卓の `.team/scripts/start.sh a6` を一回だけ実行する。started event が全席へ一度だけ届くことをroom receiptで数える。

## 実測記録（未検証）

| gate | 結果 | receipt / 根拠 |
|---|---|---|
| rebind CLI deploy | 未検証 | 新CLI未到着 |
| exact rebind command | 未検証 | placeholderのみ |
| `lattice status --json` ready | 未検証 | rebind未実施 |
| u1 structure input/compile | 未検証 | binding_stale中のため未実行 |
| rei限定再監査 | 未検証 | compile成功後が依頼条件 |
| current卓 upgrade | 未検証 | audit PASS後が実行条件 |
| a6 ready | 未検証 | rebind/compile/audit/upgrade未完了 |
| a6 started 一回・全席配達 | 未検証 | a6 start未実行 |

## script の起動契約（未実施）

`experiments/u1-rebind-continuous-smoke.sh` は、新CLIの仕様を推測しない。`U1_REBIND_COMMAND` には
deploy後に実測した**exact rebind commandだけを実行する executable wrapper の絶対path**を渡す。
`U1_REBIND_RECEIPT_FILE` には同wrapperが作る、非空のreceipt fileを渡す。scriptはreceipt内容・credential・
環境変数を出力しない。

```sh
U1_REBIND_COMMAND=/absolute/path/to/exact-rebind-wrapper \
U1_REBIND_RECEIPT_FILE=/absolute/path/to/rebind-receipt.json \
bash experiments/u1-rebind-continuous-smoke.sh
```

- `U1_REBIND_COMMAND` が未設定なら、scriptは `U1_REBIND_COMMAND_UNSET` を出して終了コード `64` で停止する。
  この経路は no-op であり、Lattice command・current卓upgrade・a6 start・credential読取を行わない。
- rebind wrapper、Lattice writer、current卓upgrade、a6 start の標準出力・標準エラーはscriptから再出力しない。
  secretをargv・環境変数・terminal transcriptへ載せない。receiptの確認はpathの存在・非空だけで、内容は明示的な
  evidence記録工程で扱う。
- compile後は `U1_REI_AUDIT_RECEIPT`（PASS後の非空regular file）の明示なしに停止する。これにより未監査の
  current卓upgrade/a6 startを実行しない。
