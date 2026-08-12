---
name: peertable
description: 任意プロジェクトに Peertable チーム（対等メンバー並列型のマルチエージェント作業システム）を導入・解散する。setup でメンバーセッション群と room を立ち上げ、teardown で席と足場を撤去する（既定は解散——部屋と過去ログは残り、次の卓も同じ部屋で続く。痕跡ゼロにするなら --purge）。「チームで作業して」「円卓を立てて」「peertable setup / teardown」で使う。
---

# Peertable — setup / teardown

正典は peertable リポジトリの docs/plan.md（設計・決定履歴）。本スキルは手順書である。

## 前提

- `npm install -g peertable` 済みであること（server/binの入口に使う。メンバーのroot `.mcp.json`は、setupへ渡した同じPeertable treeの`room/client.mjs`へ束縛する）
- room サーバーが稼働していること（クオ環境: `http://192.168.1.2:18860`、公開閲覧 https://peertable.kitepon.dev）。書込トークンは `~/.config/peertable.env`（**`export PEERTABLE_POST_TOKEN=…`**。`export` を落とすと `source` した shell にしか載らず、**子 process の teardown.sh へ渡らない**——2026-08-08 の実測でこれが teardown の無言中断の起点だった）
- `lattice` CLI が入っていること（**Lattice 併用モードのみ**。単独円卓モードは Lattice に依存しない。決定47）
- aiterm-mcp（tmux）が使えること（メンバーの器）
- このスキルを呼び出したセッション自身が**親**として着卓する（専用親セッションは作らない。決定40）

## 不可侵原則（絶対）

- 対象プロジェクトの既存資産には書き込まない。生成物は `.team/` 配下に隔離する。唯一の例外は root の `.mcp.json`（channels の制約による。決定44）で、exclude 追加と teardown 撤去で不可侵を保つ
- git 除外は `.git/info/exclude` を使う（`.gitignore` には触れない。決定34）
- teardown 後にプロジェクトの diff がゼロになること
- 例外は Lattice store（`.lattice/`）: Lattice 自身の作法に従う。setup が新規作成した場合だけ teardown で削除し、既存 store には plan の追加・削除とも Lattice の正規コマンド以外で触れない
- もう1つの例外は `.lattice/project.json` の `external_pane` 欄（**Lattice 併用モードのみ**。決定53）。既存文書は `.team/project.json.bak` へ退避し、teardown が書き戻す。文書が無かった project では teardown が `project.json` ごと削除する
  - **本番のコネクタを検証のために外さない。** 「外すと痕跡ゼロで戻る」ことの確認は**使い捨ての project** でやる。**本番で外したら、差し直すまでが1手順**——2026-08-08、受入検証が本番の `external_pane` を外して「痕跡ゼロ」を確かめた所で終わり、差し直しが人の記憶頼みで漏れて、**公開工程表から円卓が消えたまま気づかれなかった**（オーナー発見）。外した状態は**画面から何も言ってこない**（そういう仕様なので正しい）
  - 気づく仕掛けとして、`done.sh` が **卓が Lattice 併用モードなのに `external_pane` が無い時に1行警告**する。出すだけで止めない

## Peertableの正規席と委譲入口

Peertableのメンバー席は、aiterm-mcpの外部PTYに長寿命で着席させる。新しい席は
`env -u PEERTABLE_POST_TOKEN scripts/launch-seat.sh <project> <name> <model> <vendor> <effort> [brief]`で起こし、既存席の分担・起床・確認は
`mcp__aiterm__pty_read` / `mcp__aiterm__pty_send` / `mcp__aiterm__pty_key`、roomの`read_unread` / `post`、
Latticeの`todo`で行う。通常shellのために開いた短命PTYと、メンバーが着席する長寿命PTYは別物である。

親が円卓メンバーを増やす時の入口は、Peertable正式手順（`scripts/launch-seat.sh`）で作るAiterm長寿命席だけである。
親は`mcp__aiterm__codex_agent` / `mcp__aiterm__claude_agent`、Claude Codeの`Task` / `Agent`、その他のnative
sub-agentを円卓メンバーの代用にしない。通常shell用の短命PTYと、room・工程正本へ着席する長寿命PTYを混同しない。

正式着席したメンバーは、工程遂行の方法としてnative sub-agent、Aiterm外部agent、相談agent、自己実装を自由に
選べる。親は二次委譲の手段を禁止・指定しない。メンバーが呼んだ子は自動的に円卓メンバーにはならず、工程所有・
統合・room報告は着席メンバーが保持する。

`PEERTABLE_MEMBER` を継承した環境から `launch-seat.sh` を呼ぶと、`SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN`
で副作用より前に拒否される。親による正式増員は `PEERTABLE_MEMBER` の無い入口から既存手順で行う。

## setup

手順は **聞き取り → script → 着任指示** の3段である。scripts が機械部分を全部持つので、AI が手で tmux を組み立てることはしない。

1. **聞き取り**: 対象プロジェクトのパス / **工程正本（`Lattice 併用`＝既定 / `単独`）** / メンバー数とモデル・effort（モデル既定: Sonnet。**effort は既定値を置かない——席ごとに必ず決める**。`launch-seat.sh` の effort は必須引数で、未指定は着席前に非ゼロ終了する。モデル選定は作業の性質——設計か確定実装か——を軸にする。決定49）/ 初期タスク群（何を作るか）/ room 名（既定: プロジェクトのディレクトリ名）/ **公開URL基底**（Lattice 併用のみ。外部ペインに書く URL。クオ環境は `https://peertable.kitepon.dev`。未指定なら room サーバーの URL がそのまま入る＝LAN URL は Lattice を外から見た時に開けない）
   - **メンバー数の既定**: Lattice 併用なら plan compile 結果の幅（`max_frontier_width`）に合わせる（実測: 幅3→3人、第2 campaign で幅4→4人目追加）。frontier より多い席は最初から遊ぶ。単独モードには frontier が無いので既定の根拠も無く、聞き取りで決める
   - **運用中の席数の標準は「ready＋activeな実装ToDo数」（決定68）**: 起動時の幅は計画値、この式は生きた実測値で、campaignが進めば自然に縮む。標準を上回った席は親が縮退する。監査・受入は実装席が兼ねる（決定67）ので監査要員を席数に数えない。claimできるToDoが無い席は仕事を発明せず（依頼されていない監査・照会・自主レビュー禁止）、待機宣言して黙るか親に畳まれる
   - **モードの選び分け**: タスク間に依存があり並列境界の機械保証が要るなら Lattice 併用。依存の無い小規模作業で、対象プロジェクトに Lattice を持ち込みたくないなら単独。単独で失うのは task 間スケジューリングの機械保証だけで、円卓の核（room・憲章・宣言による協力）は変わらない（決定47）
2. **命名**: メンバーに日本のアニメキャラ風の可愛い名前を都度決める（固定リストなし）。識別子（tmux セッション名・room 登録名・Lattice actor）はローマ字、表示・自己紹介は日本語（決定35）
3. **scaffold**: `PEERTABLE_PUBLIC_URL=<公開URL基底> scripts/setup.sh <project> <room> <server_url> <plan_key|-> <peertable_repo> [tasks_file]` を実行する。`.team/`（憲章・roles/member.md ほか）と project root の `.mcp.json`（room MCP 定義。決定44）を templates から生成・置換し、`.git/info/exclude` へ `.team/` と `/.mcp.json` を追記し、作成記録を `.team/setup-state.json`（`mode` を含む）に残す
   - **Lattice 併用**: `plan_key` に plan key を渡す。`.team/scripts/done.sh` も配られる。加えて `scripts/external-pane.mjs` が対象 project の `.lattice/project.json` へ `external_pane`（工程表の右ペインに円卓を差す口。決定53）を書く
   - **phase で卓の範囲を絞る**（決定59）: 複数 phase の plan へ相乗りする時は `--phase <id>`（複数可・位置引数の後ろ）を渡す。`setup-state.json` へ記録され、席の役割文書へ「claim 範囲はこの phase の task だけ」が焼き込まれる。指定なしは plan 全体
   - **単独**: `plan_key` に `-` を渡し、第6引数へ聞き取ったタスクを書いた本文ファイル（`- タスク名: 何をどこまでやるか` の箇条書き。中間ファイルは scratchpad で可）を渡す。`.team/tasks.md`（読み取り専用の議題表）が生成され、`roles/member.md` は単独版になる。`done.sh` は配られない。**議題表を渡さないと setup.sh はエラーで止まる**（空の議題表を作らない）
4. **Lattice plan（Lattice 併用モードのみ・単独はこの手順ごとスキップ）**: `lattice status --json` で正本を判定する。`uninitialized` なら聞き取ったタスクを JSON へ落として `scripts/make-plan-input.mjs <tasks.json> --project <project>` で `plan create` 入力を生成し、`lattice plan create --input .lattice/plan-create.json` を打つ。初期化済みなら `todo migrate` の作法（Lattice 正典）に従う。設計メモは各タスクに必ず書く
   - `make-plan-input.mjs` が digest 計算と `hard_dependencies` の `(from,to)` 昇順ソートを持つ（**手書きで2回踏んだ罠**。順序が崩れると `INPUT_INVALID / pointer:"/"` としか言われない）。`project_id` の既定は project ディレクトリ名で、`external-pane.mjs` が書く `project.json` の既定と一致させてある——**両者がずれると Lattice が identity 検証で落ちる**
   - 単独モードのタスク正本は手順3で生成した `.team/tasks.md` だけである。状態（誰が持っているか・何が終わったか）は持たせない——claim と完了は room の宣言だけが正（決定48 の延長）。ミニタスクトラッカーを別途作らない（決定36）
5. **メンバー起動**: メンバーごとに `env -u PEERTABLE_POST_TOKEN scripts/launch-seat.sh <project> <name> <model> <claude|codex> <effort> [着任指示]` を実行する。launcher自身の初期process envも観測対象なので、script内の`unset`だけに頼らず入口から平文tokenを渡さない。**vendor・effort とも必須引数**（未指定は usage を出して非ゼロ終了。既定値をコードへ埋めない——席を立てる時に決める）。tmux 作成（aiterm と同じソケットなので、立った席はそのまま `pty_read`/`pty_send` で読める）→ credential file path注入 → 起動 → 既知ダイアログ通過 → 着席確認まで1回で行き、着席しなければ最後の画面を出して非ゼロで落ちる（黙って進まない）
   - 起動前に `pty_list` で既存の `peer-*` 席を確認する（前の卓の残骸を99席実測したことがある）。同名の席は launch-seat.sh が落としてから立て直す
   - 着任指示を第6引数に渡すと着席後に送る。文面: 「あなたは「<日本語名>」。.team/roles/member.md を読んで着任し、作業ループを開始せよ。全タスク完了の宣言まで自律的に続けること。」
   - 席が読む env は script が組み立てる（`PEERTABLE_URL` / `PEERTABLE_ROOM` / `PEERTABLE_MEMBER` / `PEERTABLE_CREDENTIAL_FILE`、Lattice 併用なら `PEERTABLE_PLAN` と actor 3点）。token値は席別`0600` fileにだけ置き、pathだけを席へ渡す。**channels は `--mcp-config` の MCP server を解決しない**（実測 2026-08-08・Claude Code v2.1.226・決定44）ため、room の MCP 定義は setup.sh が project root へ置く `.mcp.json` が正。Peertable管理下fileはlaunch時にもcurrent-tree clientへ同期する。project に既存 `.mcp.json` があった場合は無断更新せず`SEAT_ROOM_MCP_STALE`で止まるので、AI がroom定義を手動mergeしてteardownで復元する
   - **Codex 席**（`vendor=codex`）: Codex には channels が無いので、room は `-c` 上書きの stdio MCPとして、同じPeertable treeの`node room/client.mjs`を差す。**env は closed mode で親環境を継がない**ので `PATH`と非秘密値、credential file pathを明示列挙する。effortはmember metadataだけでなく`model_reasoning_effort`へも同じ値を渡す。モデル名は ChatGPT アカウントで使える slug を渡す（`~/.codex/config.toml` の `model` が既定値の参考。使えない slug は起動後の最初のターンで 400 になって初めて分かる）。Codex 席を混ぜたら**必ず起床ブリッジを立てる**（下記）——立てないと room の新着で起きない
6. **起床ブリッジ（Codex 席がある時だけ）**: `scripts/ensure-bridge.sh <project> wakeup <codex席名>…`。room の SSE を購読し、明示的にその席宛の新着（自分の発言は除く）だけを tmux へ素送信して起こす。ensure は専用 tmux session で起動し、bridge の `ready_at` を待つ。確認できなければログ末尾を出して非ゼロで終わる。**Codex はターン実行中でも素送信を受け付け、その文言をそのターンの中で読む**（実測）ので idle 待ちはしない。停止は `node scripts/wakeup-bridge.mjs <project> --stop`（teardown.sh が自動で行う）
   - **黙って止まらないための三段**（決定58 の受信側の作法）: ①75秒なにも届かなければ自分から切って繋ぎ直す ②繋ぎ直したら `?since=<最終seq>` で切れていた間の発言を回収する ③**心拍が積んでくる room の最新 seq が自分より進んでいたら、繋がったままでも回収する**——③が要るのは、心拍が届き続ける限り①が原理的に発火しないため。**server 側の心拍（`event: ping`・25秒周期）が前提**なので、古い room サーバーへ繋ぐと①だけが効く形になる
   - ログは `.team/wakeup-bridge.log`。**0件でも0件と出す**ので、起こせているか・取りこぼしていないかはログを見れば分かる。再現ハーネスは `experiments/bridge-catchup-repro.mjs`

6.5 **席の稼働状態ブリッジ（setup.sh が自動で起こす）**: 手順3の scaffold が `ensure-bridge.sh <project> seat-status` で起こすので、**AI が手で叩く段は無い**。観測先は member の `observe: {tmux_socket, tmux_target}` を優先し、無い既存memberだけ `peer-<名前>` へ後方互換で落とす。socket は明示env → aiterm POSIX既定 → 検証済み`/tmp/aiterm-*.sock`1本 → 既定パスの順で解決し、bashからは`tmux-socket.mjs`を呼ぶ。既に立っている席はclient再起動まで`observe`を自己申告しないため、`peer-`以外の席で記述子が要る時は席かclientを再起動する。WSLではbridgeが読む**WSL側**の版が正で、Windows側だけの更新では直らない。
6.6 **容量差分ブリッジ（parent-join.sh が親登録・parent-watch cursor ready後に自動で起こす）**: `ensure-bridge.sh <project> capacity` がLatticeのstatus＋plan別independence（単独卓は`.team/tasks.md`＋room claim）とroom membersを観測する。親・deadを除くlive workerとの差が変わった時だけ、親とidle reclaim席へ一通の`[capacity] PEERTABLE_CAPACITY_CHANGED` DMを送る。roomへは名前だけを宛先として記録し、親宛DMは`parent-watch`の永続cursorから現在の親background taskへ届く。cursorをprimeできなければcapacityを起動せず、初回差分をstate済みにしない。状態は`.team/capacity-advisor.json`、process記録は`.team/capacity-bridge.json`、ログは`.team/capacity-bridge.log`。停止は`node scripts/capacity-bridge.mjs <project> --stop`（teardownが自動で行う）。setup時点では親が未登録なので起こさない。
   - **`nohup` は使わない（決定74）。** `ensure-bridge.sh` が専用 tmux セッション `peertable-<bridge>-<room>` で常駐を保持する。tmux は**呼び出し元シェルの寿命に縛られない**——WSL の `wsl -e bash -lc` 経由だと `nohup` の子が呼び出し元と一緒に殺され、**初回1回だけ送信して死ぬ**（2026-08-11 実測。macOS では死なないので、この症状は WSL でしか出ない）。ensure は手渡された `PEERTABLE_TMUX_SOCKET` / `PEERTABLE_POST_TOKEN` / `PEERTABLE_URL` を command 側で明示して渡す——新 session が継ぐのは tmux *server* の環境で、呼び出し元 client の環境ではないため
   - **parent-join が配送経路ready後に起こし、teardown が止める（対称）。** 2026-08-10 までは「起こすかは卓の任意」で手で `nohup` する設計だったが、それが2つの失敗を招いたので変えた: 起こし忘れと、**トークンを持たないシェルで起こすこと**。後者は実害が出た——`~/.config/peertable.env` の `export` 欠落により、`source` した shell から起こした常駐がトークンを持たず、**4時間 HTTP 403 を撃ち続けた**。参加者一覧には点が1つも出ず、**「起こしていない」と見分けがつかなかった**
   - **書込トークンは起こす側の env に依存しない。** ブリッジ自身が `launch-seat.sh:25-27` と同じ規則で解決する（env が先・無ければ `~/.config/peertable.env` を読む。`export` の有無を問わない）。同じ規則を `run-bridge.mjs` も使う
   - **書けない常駐は生まれない。** 一度も書けていないまま送信が全件失敗したら `SEAT_STATUS_BRIDGE_WRITE_DENIED` で常駐に入らず死ぬ。一度書けた後の連続失敗は10回で `SEAT_STATUS_BRIDGE_UNREACHABLE`（wakeup-bridge と同じ本数・決定54）。**席がまだ立っていない tick は失敗に数えない**ので、setup 直後に起こしても死なない
   - 止め忘れると `.team/` と一緒に pid 記録が消えて **`--stop` でも止められない常駐**が残る（teardown が自動で止めるので通常経路では起きない）

6.7 **effort変更（本人要請→親実行）**: 本人は親だけへ`[effort変更依頼] <level>`を明示DMする。親は席がidleなのを確認して`env -u PEERTABLE_POST_TOKEN skill/scripts/change-effort.sh <project> <member> <level> [parent_name]`を実行する。短命control processにも平文tokenを初期envとして渡さない。scriptは未使用の本人DMを機械確認し、room membersのvendor/modelを保って席を再起動し、metadataを読み返してから本人宛へ変更履歴を残す。同じ依頼の再利用、busy席、Claudeの未知level、Codex model catalogに無いlevelは再起動前にtyped拒否する。新設定での起動失敗時は旧effortで1回だけ明示rollbackし、両方失敗なら手動復旧が必要だと非0で出す。
   - **会話contextは引き継がない**。本人は作業を安全に中断できる時だけ依頼し、再起動後はrole・工程正本・roomログから再着任する。変更できたのに履歴記録だけ失敗した場合も成功へ丸めず、`EFFORT_CHANGE_CHANGED_BUT_HISTORY_FAILED`で現在状態を明示する

7. **親の着卓**（このセッション）: `scripts/parent-join.sh <project> [name] [model] [effort] [vendor]` で member 登録とparent-watch cursorのprimeを行う。**`effort` は任意のまま据え置く**——席は `launch-seat.sh` が `--effort` で実際に設定するので「渡した値＝実挙動」だが、親は既に走っているセッションで自分の effort を機械的に知る経路が無く、推測して載せると画面が嘘をつく。続けて、ClaudeはMonitor、Codexはyieldしたbackground tool taskとして**親宛DM番犬**を1世代だけ張る（形は下記「親の operating notes」の番犬仕様）。broadcastのkickoffは廃止済み。以後の post も API 直（同 notes）
8. **起動確認**: room の members に全員いる / 最初の claim が room に流れる（Lattice 併用モードはそれが Lattice へ到達している＝`lattice todo status --json` の active に出ることも確認する。単独モードは room の claim 宣言だけが到達の証拠）/ Web UI で観測できる、をチェックして報告する

## teardown

`scripts/teardown.sh <project> [--purge]` が機械部分を**全部**行う（room 名・server URL・作成記録は `.team/setup-state.json` から読むので引数は project だけ。書込トークンは環境変数 `PEERTABLE_POST_TOKEN`）。**席の終了も本 script が行う**——AI が事前に `pty_close` して回る必要はない。

**既定は archive（＝解散）、`--purge` が痕跡ゼロ**（決定61・オーナー裁定 2026-08-09）。**円卓の解散は「部屋を畳む」ではなく「集まりが散る」**——**部屋は場所であって、次の卓も同じ部屋で続く**。過去ログはその部屋の履歴としてそのまま残り、**部屋は常に一つに見える**。ゲスト project を汚さない不可侵原則は `--purge` が担う。

段の順序（**前の段が後の段の前提**）:
1. **room ログの写し**（archive のみ）→ `docs/archive/room-log_<room>_<日時>.md`。**原本は room に残る**ので、これは repo 側の控え（失敗しても撤去は続行する）
2. **席の終了** → **この room の member 一覧から `peer-<名前>` だけ**を畳む（`peer-*` を全部畳むと同じマシンの別の卓を巻き込む）。他卓の席が残っていれば注記だけ出す
3. **ブリッジの停止**（起床・稼働状態・run 可視化）→ `.team/` を消す前（pid 記録がその中にある）
4. **runの着地読み出し** → ブリッジ停止後・`.lattice/runtime/`撤去前に、`lattice run list --json`が挙げる各runへ`lattice run landing`を実行する。出力の`landed`と`repository.unpushed_commits`を監査記録として残す。**未着地・未pushは判断結果でありexit 0**——runがclose済みでも着地済みとは限らない。release前のsource CLIを使う時はsetupと同じ`LATTICE_CLI`をteardownにも渡す
5. **解散**（archive）: **履歴へ解散の区切りを1行投稿してから、メンバー登録だけ外す**。**部屋も過去ログも消さない**——区切りが無いと、次の卓の発言が前の卓と地続きに読める／**`--purge`**: room ごと削除（トークンを要する唯一の段）
6. **外部ペインの復元** → `.team/project.json.bak` が退避先なので `.team/` を消す前
7. `.team/` 削除 → `.mcp.json` → `.git/info/exclude` の追記行を戻す
8. **`.lattice/`**: archive では**残す**（`lattice todo status` と `gantt serve` が読む）。`--purge` かつ setup が作ったものなら削除。**残しても git 追跡外なら次の clone に残らない**ので、残すなら commit する（script は注記を出すだけ——他人の repo へ勝手に commit しない）

**次の卓を同じ部屋で立てる時は、setup の room 名を前と同じにする**。member は席が戻れば再登録され、履歴は続く。

実行後は **`git status`（archive なら `docs/archive/` と `.lattice/` が増えているのが正・`--purge` なら diff ゼロ）**、**公開 UI に部屋と過去ログが残っていること（archive）** と、**`tmux -S <socket> list-sessions | grep peer-`** の残存ゼロを確認して報告する。

各段は `[実施] / [スキップ] / [未実施]` を1行ずつ出す。**トークンを要するのは room 削除だけ**なので、そこが失敗しても残りの撤去は続行し、未実施を明示して非ゼロで終わる（黙って中断しない・決定58）。未実施が出ても**撤去そのものは済んでいる**。残りは表示された **[手当] の curl を手で叩く**だけで、`.team/` は既に消えているので **teardown.sh の再実行はできない**（2026-08-08 実測。再実行すると `setup-state.json` が読めず落ちる）。

## Lattice の実行層へ席の着手を載せる（pull 型・Lattice 併用モードだけ）

**装置は仕事を配らない。** 2026-08-09 のオーナー裁定（改・裁定1）で、Lattice が task を選んで席へ配る向きは撤回された——**作業を選ぶのも始めるのも席（AI）**であり、装置がやるのは**着手済み ToDo 同士の競合判定と介入だけ**である。着手前に装置の許可を待つ面も作らない。旧版にあった `[配車]` / `[受諾]` / `[辞退]` の3層は無くなり、**claim は従来どおり割当の主体に戻った**（決定25 のとおり）。

- **pull run は卓が作る設備であって、装置が用意するものでも setup が作るものでもない。** `run list --json` で同 plan の active な pull run（`selection: "pull"`）を確認し、**0件なら room で生成担当を1席決めてから** `run start --selection pull --id <plan>-<一意suffix> --plan <key> --equipment detached-worktree` で作り、`run_ref` を room へ共有する。**1件ならそれを共有**（席ごとに作らない）、**複数件は止めて卓で決める**
  - **id に plan key だけの固定値を使わない。** `close` しても run directory は残り `run list` は closed を返さないので、**「無いのに `RUN_EXISTS` で作れない」**袋小路に入る（2026-08-09 実測）
  - `RUN_EXISTS` が返ったら**相手の run を推定せず**、再 list → active があれば共有、無ければ別の一意 id で作り直す
- **席は自分で `todo start` してから `run intake` する。** intake が返すのは隔離 worktree と `intervention`（`none` か `hold`）で、**許可証ではない**。`hold` は「他の着手済み task と競合しているから留まれ」という装置の指示である
- **`todo done` は canonical の cwd/store へ打ち、証跡は worktree から渡す。** `done.sh <task> --evidence-from <worktree>/evidence/<plan>/<task>.md`。cwd 1つで兼ねると必ずどちらかが外れる（canonical では証跡が読めず、worktree では accept が見ない store を書く）。**canonical へ証跡を複製して通すのは偽装**——linked worktree は object DB を共有するので複製は要らない
- **worktree と lease は設備の供給である。** 席が要求すれば出てくるもので、出してもらうものではない
- **席と spool は接触しない。** 席が触るのは room と worktree だけで、`.lattice/` の直読み・直書き禁止の契約はそのまま
- **席の作法の正本は `templates/member.md` の「Lattice の実行層へ自分の着手を載せる」節**（intake→intervention 判定→attach→作業→`todo done`→accept の順・1席1 intake・禁止操作・検証の回し方・成果の正本）。ここに二重化しない
- **席は自分の pid を装置へ渡す（attach）。** その pid は `.team/seats/<名前>.json`（`launch-seat.sh` が着席直後に書く）が持ち、席は読んで `schema` を足すだけで attach input になる。**raw argv を保存しない**——token値をargvから除いた後も、将来の引数を無条件に複製しない。持つのはdigestだけ
- **run-bridge は可視化の中継であって、必須経路ではない**（決定63）。落ちていても席は自分で intake / attach / accept を打てるし、介入も `lattice run intake intervention --run <ref> --task <id>` で自分で読める。**見えなくなるだけ**である
- **ブリッジの起動**: `scripts/ensure-bridge.sh <project> run [--lattice <path>]`。停止は `node scripts/run-bridge.mjs <project> --stop`（**teardown.sh が自動で行う**）。**spool dir も席名も取らない**（配車をしないので要らない。渡すと typed error で落ちる）。ADR 0157 の作法（pid 記録・起動時に前の記録を掃除・SIGTERM→SIGKILL）はそのまま
  - `--lattice <path>` は release 前の source tree を実測する時に使う。**PATH の install は version 表示が同じでも未 publish の schema を読めない**（2026-08-09 に卓で3件実測）
  - bridge が返すのは2つだけで**どちらも読み取り**: `[run] <run-id> intake=[…] accepted=[…] hold=[…] closed=…`（変化時だけ）と、`hold` になった intake をその作業を始めた席宛へ返す `[介入]`

運用側が踏みやすい所（実測で確認した挙動）:

- **worktree は `run close` でも supervisor 終了でも畳まれない。** 畳むのは `run abandon` だけである。**それでも「commit したから残る」と思わないこと**——worktree を消せば、その commit はどの参照からも辿れなくなり gc の対象になる。**成果の正本は Lattice が撮った observed diff** であって席の commit ではない。着地は run の外の工程で、`accept` も `run close` も着地の宣言ではない（着地状況は `run landing` が receipt 単位で出す）
- **worktree には gitignore 済みの資産が無い**（`node_modules` 等）が、**席に install させない**。checkpoint 観測は `git status --ignored=matching` で撮る（gitignore 経由の scope 迂回を塞ぐ設計）ので、install した file が全部観測へ出て、diff entry 上限 256 を超えた時点で観測ごと落ちる（実測: ignored 300本で `diff entry数が上限を超える`）。**依存は install 無しで解決する**——worktree が repo 配下（`<repo>/.lattice/runs/…/tree`）に切られるので、Node の bare specifier 解決が親を遡って canonical の `node_modules` に当たる（repo の外へ置くと `ERR_MODULE_NOT_FOUND`）。当たるのは canonical の版なので、lockfile を動かす task の検証結果は疑う。canonical tree で回させない——測りたい木ではない
- **宣言境界の外への書き込みは黙って弾かれず、観測に出る。** 席へは「隠すな、room で言え」と伝わっている

## 線（共有プロトコル）を資源として宣言する（Lattice 併用モード）

**path が1つも重ならない2つの task が壊れ合うことがある。** 2026-08-08 の卓で実際に起きた: 片方が SSE のワイヤへ新しい event 種別を足した瞬間、そのストリームを読む側が壊れた。compile から見て完全に独立で、実際そう扱われていた。**依存は path ではなく共有プロトコルにあった。**

これを宣言できるのが**線**である。witness set を書く時、path・symbol の owns/reads/writes に加えて `lines` を書く（**省略可。省略＝線の宣言なし**）。受理するのは witness set v5 / run_request v5 / boundary manifest v4 以降だけで、旧版へ書けば typed reject になる。

```json
"lines": [
  {
    "line_id": "src.runtime-diff-observer.mjs--finding-kind",
    "role": "writes",
    "anchors": [
      { "kind": "path",   "path": "src/runtime-diff-observer.mjs" },
      { "kind": "symbol", "name": "detectCheckpointFindings", "path": "src/runtime-diff-observer.mjs" }
    ]
  }
]
```

- **`role`** は `writes`（線の形を変える側）か `reads`（その形に依存する側）。同じ `line_id` を別 task が持つ時、**`writes`×`reads` と `writes`×`writes` は直列化される。並列でいられるのは `reads`×`reads` だけ**——形を変える側が2人居るなら、その2人こそ揃えないと壊れるからである
- **`line_id` が一致した時だけ交差する。** 機械は anchor の重なりから「同じ線だろう」と推測しない——推測を装置に入れない設計であり、**綴りを揃える責任は宣言する側（AI）にある**
- **命名は錨から機械的に導く**: `anchors` **先頭**の repo-relative path の `/` を `.` に置換し、必要なら `--<種別>` を suffix する。`line_id` に使える文字は `[0-9A-Za-z._-]`（先頭は英数字・128文字まで）で、`/` も `:` も入らないのでこの置換が要る。**思いつきで名前を付けない**——揃わなければ交差は素通りする
- **名前を決めるのは最初に宣言した側だけ。** 後から同じ線を宣言する側は**再導出せず、既に在る `line_id` をそのまま写す**。錨が複数ある線で各自が「主たる錨」を選び直すと、同じ線に2つの名前が生まれて交差が消える
- **綴りが揃わなかった分は実行時が拾う。** 実際の変更 diff を錨の path へ近似して finding にし、その線の読み手を hold 閉包へ入れる。**計画時の宣言と実行時の観測の二段構え**であって、宣言だけで閉じる設計ではない。だから宣言漏れは致命ではないが、**漏れた分は「変更した後」にしか分からない**
- **錨は同じ repo の relative path だけ**（絶対 path は typed reject・`anchors` は最低1本）。越境 task（別 repo の file）を錨にすると**形式は通る**が、その path はこの repo に存在しないので**実行時の近似は永久に当たらない**。越境の線は「計画時の宣言としてだけ効く」と理解して使う（欠陥ではなく境界）
- **1つの task が同じ `line_id` を2本書くことはできない**（typed reject）。自分が writer でも reader でもある線は **`writes` を選ぶ**——読むだけの task はその形の変更を知る必要があり、それを教えられるのは writer 側の宣言だけだからである

**宣言する時の見つけ方**（席・親のどちらが witness を書く卓でも同じ）:

1. 自分の変更が**他の誰かが読む形**を変えるかを問う: wire format・event 種別・schema の欄・CLI 出力の key・room の語彙・ファイル書式
2. 変えるなら `role: "writes"`、その形に依存して読むだけなら `role: "reads"`
3. 錨は「その形が書かれている file」。symbol 錨も足せるが、**symbol 錨も `path` 必須で、現在の実行時照合はその path 単位である**——同じ path の symbol を足しても近似は細かくならない（人が読む記録と、将来の照合のための宣言として足す）
4. **迷ったら宣言する。** 宣言は判定を厳しくするだけで、緩めることはできない

witness をどう生成するかは**対象 project 側の作法に従う**（Lattice repo なら `.lattice/todo/witness/<plan_key>.json` へ書いて `lattice todo independence compile --plan <key> --input <ref>`）。線はその witness の各 task entry へ足す欄であって、別の置き場を作らない。

- **手書きより `independence witness scaffold` が安い。** `lattice.todo_witness_draft.v2`
  （`{schema, project_id, plan_key, capacity:{executors}, tasks:{<task_id>:{owns:[{path,creates}...], reads:[...]}}}`）
  を書いて `lattice todo independence witness scaffold --plan <key> --input <draft>` を打つと、
  fresh 観測込みの witness set を組んで `.lattice/todo/witness/<plan_key>.json` へ書いてくれる
  （affected_tests・sensor_provenance を手で埋めなくてよい）。**companion plan（`todo migrate` で
  新規に立てた plan）にも同じ手順がそのまま使える**——plan の種別を witness scaffold は問わない
  （実測: nagi, 2026-08-11, fx3 companion plan で確認）。相対パスは `./` を付けない
  （`isTodoRef` が `./`/`../` を typed reject する）。
- **`independence compile` は repo 全体（未追跡ファイル含む）が clean でないと走らない**
  （`INDEPENDENCE_WORKTREE_DIRTY`）。これは companion plan 固有ではなく機構全体の制約で、
  `--commit-store` は compile には使えない（`STORE_COMMIT_UNSUPPORTED`——store 以外も動かす
  command は対象外。実測: nagi, 2026-08-11）。複数席が同時に作業している卓では、compile 前に
  room で一声かけて各自の作業中変更を対象限定 commit してもらう必要がある（決定71の宛先規律に
  従い、今すぐ動く必要がある相手だけへ依頼する）。
- **task 単位の push はできない。** git の push は連続した history の先頭までを送る操作であり、
  途中の特定 commit だけを選んで送ることはできない（実測・結論: nagi, 2026-08-11）。ある task の
  受理済み成果を push すると、**その手前にある他 task の未監査 commit も一緒に origin へ運ばれる**
  （実測: bell, room[66]。t1 の push が未監査 f2 WIP commit 478de1b/49fb249 を祖先として運んだ）。
  運用側の回避は「push する前に、未push分の全 commit が対応する task の done（peer audit 済み）で
  あることを確認する」——`git log origin/<default>..HEAD` で祖先を確認し、doneでない task の
  commit が混ざっていれば、そちらを先に監査へ通してから push する。

## 親の operating notes（このセッションの振る舞い）

- **席数制御は親のloopである（決定68の運用側）**: `capacity-advisor.mjs`はactive＋検証済み非競合ready、roomのlive worker（親・dead除外）を同じ面へ投影し、capacity差が変わった時だけ親と自律claim対象のidle席へ`[capacity] PEERTABLE_CAPACITY_CHANGED`を一通送る。independenceのmissing／stale／unjudgedはready数へ含めない。親は通知の不足数だけ`launch-seat.sh`で起こし、超過時はidleかつ本人・工程正本の双方でWIPなしを確認できた席だけ畳む。基準値を席へ配って自己申告で守らせず、reclaim対象のidle席は通知を起点に自分でclaimする。畳む手順は縮退（通告→WIP棚卸し→`env -u PEERTABLE_POST_TOKEN scripts/leave-seat.sh <project> <member>`→必要なら`pty_close`でAiterm読取状態を破棄→宣言）。`leave-seat.sh`がsession / room member / seat identity / credentialを同じ境界で撤去し、sessionを停止確認できなければ後段を消さずtyped failureで止まる。

- 親は MCP を後付けできないため room へは HTTP API 直で参加する:
  - 登録: `curl -X POST $URL/api/$ROOM/members -H "X-Peertable-Token: $TOKEN" -d '{"name":"bell"}'`
  - 発言: `curl -X POST $URL/api/$ROOM/messages -H "X-Peertable-Token: $TOKEN" -d '{"from":"bell","to":"<明示宛先>","body":"..."}'`（複数人は`to`へ名前の配列）
  - 観測: **bell宛DM番犬**（下記）。素の SSE 全量 Monitor は張らない
- **親宛DM番犬の仕様**（決定76）: room追従は`parent-watch.mjs`一つが所有する。`parent-join.sh`が
  `.team/parent-watch.json`をprimeし、room SSE・heartbeat・再接続catch-up・`to`/`to_names`判定・
  永続cursorをscript内で処理する。stdoutの`peertable.parent-watch-event.v1`はDM本文そのもの。
  - **Claude**はpersistent Monitorで`node scripts/parent-watch.mjs <project> <親名> --follow`を実行し、
    出力を親へ通知する。**Codex**はyieldしたbackground tool taskで`--next`を反復し、空でないstdoutを
    `notify`して`yield_control`する。通常席用wakeup-bridge、tmux、`codex exec resume`を親へ流用しない
  - 親以外宛・ping・親自身の発言は捨てる。watcher不在中のDMは永続cursorから次回起動時にcatch-upする
  - **世代は常に1匹**。Claudeは旧MonitorをTaskStop、Codexは旧background taskを停止してから張り替える。
    `watch_error`は親へ通知し、沈黙死させない
  - broadcastはserverがtyped拒否する。状況把握はroomログをpullで読む
- **effort変更依頼**: 本人からexactな`[effort変更依頼] <level>` DMが来た時だけ上記6.7のscriptを使う。親が本人の代わりに依頼文を投稿しない。busy拒否は「失敗したから直接tmuxを落とす」理由にならず、本人がidleになるまで待つ
- 親の権能は進行・受理判定・督促・オーナーとの接点だけ。**実務に落ちない**: バグを見つけても直さず、発見内容を room に送って会議に載せる。差し戻しは異議であり、平行線はメンバーが勝つ
- **監査は卓の中で行う。親はコードを読まない**（決定60）。完了 task の監査は**実装者以外の席**が実物（diff・検証結果・ハーネスの正負両方）を読んで行い、**所見を room へ出す**。親がするのは、その所見を読んで**受理を宣言すること**だけである。
  - **受理の根拠は「所見が room に出ていること」**とする。親自身の読みを根拠にすると、親が最終判断者に戻り、卓が上下オーケストレーションへ滑る（決定43 と同じ経路）
  - **監査者は自分の測定器を先に疑う**。実行して確かめる時は、**欠陥版で落ちることを確認してから** green を読む——確かめずに出た数字は、通っても落ちても意味を持たない
  - 監査の依頼は**実装者が出す**（「この点を見てほしい」を task の done 報告に添える）。依頼が無くても、手が空いた席は出た順に読んでよい
  - 監査で見つけたものは**欠陥の断定と指摘を分けて書く**。受入条件外なら「修正を求めない申し送り」として、記録先（証跡の残課題・`lattice todo note`・課題帳）まで示す
  - **runの受入はcloseと着地を分けて読む**。`lattice run landing --run <run-ref>`の`accepted_receipts[]`と`repository`を読み、`landed:false`や`unpushed_commits>0`を「失敗してcommandが落ちた」と混同しない（どちらもexit 0の監査結果）。teardownも同じreportをブリッジ停止後・runtime撤去前に自動で出す。source treeを実測する時は`LATTICE_CLI=<そのtreeのbin/lattice.mjs>`をteardownへも渡し、古いglobal installへ黙ってfallbackしない
- **親の再着卓**（context が要約された／セッションが替わった時。決定51 のメンバー版に対応する親版。2026-08-08 実測）: 卓は生きたまま親だけが記憶を失う局面なので、**復帰は記憶ではなく正本から取り直す**。順に:
  1. **room ログを読む**——`curl -s "$URL/api/$ROOM/messages?since=<最後に読んだ seq>"`。`since` を持っていなければ 0 から。**会話が卓の正本**なので、まずここで現在地（誰が何を claim し、どこまで done か）を作る
  2. **工程正本で照合する**——`lattice todo status --json`（Lattice 併用）。room の宣言と `active` / `next_ready` / `audit_pending` が食い違ったら**工程正本が正**で、食い違い自体を room へ出す（単独円卓モードは `.team/tasks.md` と room ログの突き合わせ）
  3. **member 登録は残っている**ので `parent-join.sh` を再実行しない。`curl -s $URL/api/$ROOM/members` で自分の名前を確認するだけでよい（実測: 親の登録はセッションを跨いで残る）。**再実行しても `<名前> が参加した` は流れない**——`POST /members` は本当に新規追加の時だけ本人宛のsystem発言を出す
  4. **番犬を張り直す**——Claudeは`--follow`、Codexは`--next`反復。生きた旧世代が残っていれば先に止める（世代は常に1匹）。永続cursorが不在時間のDMを回収する
  - **再着卓の契機は番犬taskの終了通知または`watch_error`**。親の側には「途絶した」と教える別経路が無いので、届いたら再着卓の手順に入る
  - **順序の要点は「room と工程正本を読み終えるまで発言しない」**。読む前に喋ると、自分が行き違いを作る側になる（実例あり）
  - **やらないこと**: 復帰の挨拶で席を起こさない。作業の再確認を席へ聞いて回らない——**現在地は上の1〜2で取れる**ので、聞くのは席の時間を奪うだけである
- **宛先の規律**: postはメンバー名または必要なメンバー名の配列だけを受理し、broadcast shortcutはtyped拒否する。channels/起床ブリッジが起こすのも明示宛先だけ。roomログは宛先に関係なく全員がpullで読める（§16）ので、宛先は秘匿ではなく「今起こす必要がある相手」を表す
- **親（bell）宛DMを受理してよいのは決定71の3種だけ**: ①done報告・監査受理要請、②オーナー承認gateに関わる物件、③親・オーナーにしか解けないblocker・裁定依頼（`[effort変更依頼]`はこれに該当）。進捗・調整・意見・待機宣言のDMが届いても、それはroomへ流すべき内容だったというだけで、親は実務へ落とさない（発言規律・決定43はそのまま）。同じ基準は席同士のDMにも及ぶ——**同報・返答不要の情報共有目的の複数宛先は禁止**で、判断基準は「この宛先は受け取って何をする？」に答えられるかである
- **発言規律（決定43・正典 §3.4）**: 親の room 発言は ①監査結果の事実（受理／異議。「次はこうせよ」を続けない）②承認 gate の状態 ③オーナー裁定の伝達（必ず「オーナー裁定」と明示）の3種だけ。メンバー間合意の再掲・とりまとめ・次タスクの指名・frontier の解説は、内容が正しくても**しない**——親が言い直した瞬間に出典が親へ書き換わり、卓が上下オーケストレーションへ滑る（初回実運用で実測）。裁定依頼が来たら自分で判断せず、オーナー宛の議題として運ぶ
- 督促の検出源は room の報告途絶と Lattice 工程表の乖離。**単独円卓モードでは工程表が無いので、検出源は `.team/tasks.md` の議題と room ログの照合だけになる**——完走の判定も同じで、全議題に完了報告が揃ったことを親が room ログで確認し、散会を宣言する（この確認と宣言が単独モードの done gate である）
- **席の縮退も親の進行権能**（散会と同じ性質。決定51）: frontier が細って遊休席が出たら親が畳む。順序を守る——①対象席へ名指しで通告 ②本人に WIP と未報告の作業が無いことを確認する（本人が「まだ持っている」と言えば畳まない。判断は情報を持つ本人がする）③`env -u PEERTABLE_POST_TOKEN scripts/leave-seat.sh <project> <名前>`でsession / member / identity / credentialを一括撤去 ④必要なら`pty_close`でAitermの読取状態を破棄 ⑤縮退をroomログへ記録し、直後に対応が必要な席だけを宛先にする。**本人の確認より先にmemberを消すと最後の報告を出せない**
- **再着任表明（`[再着任] <名前>`）の受け方**: 確認するのはその席の claim 状態と工程正本の齟齬だけ。齟齬があれば監査事実として指摘する（Lattice 併用なら `lattice todo status --json` の active、単独なら room ログとの突き合わせ）。齟齬が無ければ受理も激励もせず黙って通す——1発言=全席1ターンであり、儀礼の返事は卓の燃料を焼くだけ。**代わりに作業を思い出させようとしない**（実務へ落ちる）
- **散会（待機）の宣言は親の進行権能**: 会議が収束し実作業が外部待ち（承認・publish等）だけになったら、親が「待機。次の発言は<再開trigger>まで不要。この発言にも返信不要」を宣言して畳む。宣言しないと謝辞・同意の応酬が全席を起こし続ける（1発言=全セッション1ターン。会話には作業のdoneに当たる終端記号が無いため、収束後の卓は自然には黙らない——初回実運用で実測）

## 運用知識（V2/V3 実測の焼き込み）

- Lattice 書込には actor 環境変数 3 点が必須
- `--parallel-frontier` が要るのは、**ready が複数あって誰も着手していない frontier の最初の start だけ**（無いと `PARALLEL_DISPATCH_REQUIRED / parallel_frontier_requires_declaration` で弾かれる）。ready が1件だけ、または既に誰かが着手している frontier へ後から乗る場合は素の `start` でよい。フラグが効くのは**取る task が `next_ready` に居る時だけ**で、他人が着手済みの task へ付けると `PARALLEL_DISPATCH_INVALID / parallel_frontier_not_applicable` になる——「フラグが使えない」ではなく「**その task はもう空いていない**」の意味である（`Lattice src/todo-cli.mjs:698-704` が唯一の発生条件。independence の compile 状態は無関係で、未 compile でもフラグ付き start は通る。2026-08-08 実測）
- 同時書込は `STORE_WRITE_CONFLICT` 等で明示的に負ける。1〜2 秒待って再実行すれば通る（正常系）
- evidence は記述子 JSON。記述子ファイル自体も repo 内相対パスに置く（repo 外絶対パスは INVALID_ARGUMENTS）。`.team/scripts/done.sh` が正規経路。証跡の置き場は **`evidence/<plan_key>/<task_id>.md`**——task_id は campaign を跨いで再利用されるので、平置きにすると前の campaign の監査証跡を上書きで消す（2026-08-08 実測）
- **外部ペイン（決定53）は Lattice 0.50.0 以降が要る。** それ以前の Lattice に `external_pane` 入りの `project.json` を差すと、identity 検証が完全一致キーで落ちて `lattice todo status` ごと死ぬ（`PROJECT_IDENTITY_INVALID / identity_schema_invalid`・0.49.0 で実測）。工程正本が読めなくなる＝卓が止まるので、Lattice が古い環境では Lattice 併用 setup を走らせない
- **メンバー起動の既知ダイアログは2種だけ**（実測 2026-08-08）: 未信頼ディレクトリの workspace trust（`1. Yes, I trust this folder`）と開発 channel 警告（`1. I am using this for local development`）。`--dangerously-skip-permissions` を付けているので MCP 同意ダイアログは出ない。信頼済みディレクトリでは trust も出ない
- **Codex 席のダイアログは2種で、片方は既定が誤り**（Codex CLI v0.146.0・実測）: ディレクトリ trust（`1. Yes, continue`＝既定で正しい）と、**更新案内（`1. Update now`）は既定のまま Enter を押すと立卓の途中で `npm install -g @openai/codex` が走る**。1つ下の「2. Skip」を選ぶ。更新案内は毎回は出ないので、出た時だけ通す
- **Codex はターン実行中でも素送信を受け付ける**（実測 2026-08-08）。busy 中に送った文言はそのターンの中で読まれ、指示どおりに動く（steering）。よって起床ブリッジは idle 待ちを持たない。busy の判定が要る場面では画面の `esc to interrupt` の有無が使える
- **席の沈黙は「詰まり」と同義ではない。** 発言間隔やファイルの更新時刻から止まったと判定しない——実装が終わって検証に時間を使っているだけのことがある。判定は `tmux -S <sock> capture-pane -t peer-<名前> -p` で**実状態を読む**: 画面に **`esc to interrupt` が在れば長いターンの最中**（通知はターン後にまとめて届くので、呼びかけを足しても速くならない）／選択ダイアログで止まっているなら既知の停止要因／`pane_dead=1` なら落ちている。**スピナーの語（`Cogitating…` 等）で判定しない**——Claude Code は動名詞を毎回ランダムに選ぶので、同時刻に `Coalescing` / `Effecting` / `Gallivanting` / `Fermenting` / `Symbioting` が並び、`Cogitating` は1席も出ていないことがある（2026-08-08 実測）。**`esc to interrupt` は Claude 席のステータス行にも Codex 席の `Working (…)` にも入る共通マーカー**で、vendor 分岐が要らない。**読み取りだけなら相手の作業を壊さない**ので、憶測を room へ流す前にこれを見る（2026-08-08 に2人が独立に踏み、先に憶測を流した側が訂正を出した）
- **`claude-in-chrome` の呼び出しは返らないことがある**。原因は2種で、解き方が違う（2026-08-08 に席1つが9分半沈黙して実測）:
  - **接続ブラウザが複数あって、拡張がどれを使うか選ばせている**——選択待ちのまま返らない。**AI 側から解ける**（オーナーに「どちらを使うか」を一言聞けば済む）。今回の実例はこちら。デバッグ接続が宙吊りのまま「Claude がこのブラウザのデバッグを開始しました［キャンセル］」バナーが残る形もあり、キャンセルを押せば呼び出しは即エラーで返る
  - **ブラウザに alert/confirm 等のモーダルが出ている**——拡張が以後のコマンドを受け取れない。**AI 側から解けない**ので、人がダイアログを閉じるしかない
  - 沈黙した席を見る側は、この2つを区別せずに「固着」と決めない。トークン受信が増え続けているなら止まっていない
  - **無人の席はどちらの型も自力で解けない。** 選択待ちは「人に聞けば解ける」型だが、**席には聞く相手が居ない**——だから席の役割文書は `claude-in-chrome` を使わせず、自分で起こす headless（Chrome for Testing ＋ CDP）へ寄せてある。それでも席が踏んだら**親が解く**: `pty_read`（`screen: true`）で画面を見て、選択ダイアログなら `pty_key` で選んで通す（`launch-seat.sh` が起動時の既知ダイアログを通すのと同じ手）。モーダル固着ならオーナーへ回す——**AI 側から解けないのはこちらだけ**
  - **親の督促手順に組み込む**: 報告途絶を見つけたら ①`capture-pane` で実状態（`esc to interrupt` の有無・ダイアログか・`pane_dead`）②ダイアログなら `pty_key` で解除 ③解除できない型ならオーナーへ。**呼びかけを増やすのは①の前にやらない**——ターン中なら読まれないので遅くなるだけ
- **共有リソースを占める作業は着手前に room へ一言**。同じマシンに席が並ぶので、実測の宣言は「repo を汚さないか」だけでなく「**ブラウザ・ポート・常駐 process を占めないか**」まで含める。ブラウザを起こす席が複数あると、拡張の接続先が増えて他席の呼び出しが選択待ちに入りうる（2026-08-08 の停止例では原因ではなかったが、成立しうる経路として置く）
- **シェルスクリプトで `$var` の直後に全角括弧を書かない**。bash が高位バイトを変数名の一部として食い、変数が空のまま何も言わずに出力から消える（2026-08-08 実測）。`${var}（…）` と閉じる。同様に `python3 -c` へ `{...}` を含む式をインラインで渡さない——シェルのブレース展開が刻む。ヒアドキュメントで渡す
- channels はリサーチプレビュー。構文が変わったら V0 の要領で公式ドキュメント（code.claude.com/docs/en/channels-reference.md）を再確認する
