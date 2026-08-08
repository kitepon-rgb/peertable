---
name: peertable
description: 任意プロジェクトに Peertable チーム（対等メンバー並列型のマルチエージェント作業システム）を導入・撤去する。setup でメンバーセッション群と room を立ち上げ、teardown で diff ゼロに戻す。「チームで作業して」「円卓を立てて」「peertable setup / teardown」で使う。
---

# Peertable — setup / teardown

正典は peertable リポジトリの docs/plan.md（設計・決定履歴）。本スキルは手順書である。

## 前提

- `npm install -g peertable` 済みであること（メンバーの root `.mcp.json` は PATH 上の `peertable-client` を使う。サーバーも `peertable-room` で立てられる）
- room サーバーが稼働していること（クオ環境: `http://192.168.1.2:18860`、公開閲覧 https://peertable.kitepon.dev）。書込トークンは `~/.config/peertable.env`（`PEERTABLE_POST_TOKEN=`）
- `lattice` CLI が入っていること（**Lattice 併用モードのみ**。単独円卓モードは Lattice に依存しない。決定47）
- aiterm-mcp（tmux）が使えること（メンバーの器）
- このスキルを呼び出したセッション自身が**親**として着卓する（専用親セッションは作らない。決定40）

## 不可侵原則（絶対）

- 対象プロジェクトの既存資産には書き込まない。生成物は `.team/` 配下に隔離する。唯一の例外は root の `.mcp.json`（channels の制約による。決定44）で、exclude 追加と teardown 撤去で不可侵を保つ
- git 除外は `.git/info/exclude` を使う（`.gitignore` には触れない。決定34）
- teardown 後にプロジェクトの diff がゼロになること
- 例外は Lattice store（`.lattice/`）: Lattice 自身の作法に従う。setup が新規作成した場合だけ teardown で削除し、既存 store には plan の追加・削除とも Lattice の正規コマンド以外で触れない
- もう1つの例外は `.lattice/project.json` の `external_pane` 欄（**Lattice 併用モードのみ**。決定53）。既存文書は `.team/project.json.bak` へ退避し、teardown が書き戻す。文書が無かった project では teardown が `project.json` ごと削除する

## setup

手順は **聞き取り → script → 着任指示** の3段である。scripts が機械部分を全部持つので、AI が手で tmux を組み立てることはしない。

1. **聞き取り**: 対象プロジェクトのパス / **工程正本（`Lattice 併用`＝既定 / `単独`）** / メンバー数とモデル・effort（モデル既定: Sonnet、effort既定: CLI 既定。モデル選定は作業の性質——設計か確定実装か——を軸にする。決定49）/ 初期タスク群（何を作るか）/ room 名（既定: プロジェクトのディレクトリ名）/ **公開URL基底**（Lattice 併用のみ。外部ペインに書く URL。クオ環境は `https://peertable.kitepon.dev`。未指定なら room サーバーの URL がそのまま入る＝LAN URL は Lattice を外から見た時に開けない）
   - **メンバー数の既定**: Lattice 併用なら plan compile 結果の幅（`max_frontier_width`）に合わせる（実測: 幅3→3人、第2 campaign で幅4→4人目追加）。frontier より多い席は最初から遊ぶ。単独モードには frontier が無いので既定の根拠も無く、聞き取りで決める
   - **モードの選び分け**: タスク間に依存があり並列境界の機械保証が要るなら Lattice 併用。依存の無い小規模作業で、対象プロジェクトに Lattice を持ち込みたくないなら単独。単独で失うのは task 間スケジューリングの機械保証だけで、円卓の核（room・憲章・宣言による協力）は変わらない（決定47）
2. **命名**: メンバーに日本のアニメキャラ風の可愛い名前を都度決める（固定リストなし）。識別子（tmux セッション名・room 登録名・Lattice actor）はローマ字、表示・自己紹介は日本語（決定35）
3. **scaffold**: `PEERTABLE_PUBLIC_URL=<公開URL基底> scripts/setup.sh <project> <room> <server_url> <plan_key|-> <peertable_repo> [tasks_file]` を実行する。`.team/`（憲章・roles/member.md ほか）と project root の `.mcp.json`（room MCP 定義。決定44）を templates から生成・置換し、`.git/info/exclude` へ `.team/` と `/.mcp.json` を追記し、作成記録を `.team/setup-state.json`（`mode` を含む）に残す
   - **Lattice 併用**: `plan_key` に plan key を渡す。`.team/scripts/done.sh` も配られる。加えて `scripts/external-pane.mjs` が対象 project の `.lattice/project.json` へ `external_pane`（工程表の右ペインに円卓を差す口。決定53）を書く
   - **単独**: `plan_key` に `-` を渡し、第6引数へ聞き取ったタスクを書いた本文ファイル（`- タスク名: 何をどこまでやるか` の箇条書き。中間ファイルは scratchpad で可）を渡す。`.team/tasks.md`（読み取り専用の議題表）が生成され、`roles/member.md` は単独版になる。`done.sh` は配られない。**議題表を渡さないと setup.sh はエラーで止まる**（空の議題表を作らない）
4. **Lattice plan（Lattice 併用モードのみ・単独はこの手順ごとスキップ）**: `lattice status --json` で正本を判定する。`uninitialized` なら聞き取ったタスクを JSON へ落として `scripts/make-plan-input.mjs <tasks.json> --project <project>` で `plan create` 入力を生成し、`lattice plan create --input .lattice/plan-create.json` を打つ。初期化済みなら `todo migrate` の作法（Lattice 正典）に従う。設計メモは各タスクに必ず書く
   - `make-plan-input.mjs` が digest 計算と `hard_dependencies` の `(from,to)` 昇順ソートを持つ（**手書きで2回踏んだ罠**。順序が崩れると `INPUT_INVALID / pointer:"/"` としか言われない）。`project_id` の既定は project ディレクトリ名で、`external-pane.mjs` が書く `project.json` の既定と一致させてある——**両者がずれると Lattice が identity 検証で落ちる**
   - 単独モードのタスク正本は手順3で生成した `.team/tasks.md` だけである。状態（誰が持っているか・何が終わったか）は持たせない——claim と完了は room の宣言だけが正（決定48 の延長）。ミニタスクトラッカーを別途作らない（決定36）
5. **メンバー起動**: メンバーごとに `scripts/launch-seat.sh <project> <name> <model> [claude|codex] [effort] [着任指示]` を実行する。tmux 作成（aiterm と同じソケットなので、立った席はそのまま `pty_read`/`pty_send` で読める）→ env 注入 → 起動 → 既知ダイアログ通過 → 着席確認まで1回で行き、着席しなければ最後の画面を出して非ゼロで落ちる（黙って進まない）
   - 起動前に `pty_list` で既存の `peer-*` 席を確認する（前の卓の残骸を99席実測したことがある）。同名の席は launch-seat.sh が落としてから立て直す
   - 着任指示を第6引数に渡すと着席後に送る。文面: 「あなたは「<日本語名>」。.team/roles/member.md を読んで着任し、作業ループを開始せよ。全タスク完了の宣言まで自律的に続けること。」
   - 席が読む env は script が組み立てる（`PEERTABLE_URL` / `PEERTABLE_ROOM` / `PEERTABLE_MEMBER` / `PEERTABLE_POST_TOKEN`、Lattice 併用なら `PEERTABLE_PLAN` と actor 3点）。**channels は `--mcp-config` の MCP server を解決しない**（実測 2026-08-08・Claude Code v2.1.226・決定44）ため、room の MCP 定義は setup.sh が project root へ置く `.mcp.json` が正。project に既存 `.mcp.json` があった場合 setup.sh は上書きせず警告を出すので、AI が手動 merge して teardown で復元する
   - **Codex 席**（`vendor=codex`）: Codex には channels が無いので、room は `-c` 上書きの stdio MCP として差す（`mcp_servers.room.command="peertable-client"` と `mcp_servers.room.env={…}`）。**env は closed mode で親環境を継がない**ので `PATH` を含む全変数を明示列挙する。モデル名は ChatGPT アカウントで使える slug を渡す（`~/.codex/config.toml` の `model` が既定値の参考。使えない slug は起動後の最初のターンで 400 になって初めて分かる）。Codex 席を混ぜたら**必ず起床ブリッジを立てる**（下記）——立てないと room の新着で起きない
6. **起床ブリッジ（Codex 席がある時だけ）**: `nohup node scripts/wakeup-bridge.mjs <project> <codex席名>… > <project>/.team/wakeup-bridge.log 2>&1 &`。room の SSE を購読し、その席宛/全員宛の新着（自分の発言は除く）を tmux へ素送信して起こす。**Codex はターン実行中でも素送信を受け付け、その文言をそのターンの中で読む**（実測）ので idle 待ちはしない。停止は `node scripts/wakeup-bridge.mjs <project> --stop`（teardown.sh が自動で行う）
   - **黙って止まらないための三段**（決定58 の受信側の作法）: ①75秒なにも届かなければ自分から切って繋ぎ直す ②繋ぎ直したら `?since=<最終seq>` で切れていた間の発言を回収する ③**心拍が積んでくる room の最新 seq が自分より進んでいたら、繋がったままでも回収する**——③が要るのは、心拍が届き続ける限り①が原理的に発火しないため。**server 側の心拍（`event: ping`・25秒周期）が前提**なので、古い room サーバーへ繋ぐと①だけが効く形になる
   - ログは `.team/wakeup-bridge.log`。**0件でも0件と出す**ので、起こせているか・取りこぼしていないかはログを見れば分かる。再現ハーネスは `experiments/bridge-catchup-repro.mjs`
7. **親の着卓**（このセッション）: `scripts/parent-join.sh <project> [name] [kickoff_file]` で member 登録と kickoff 投稿を行い、SSE を Monitor で張る。以後の post も API 直（下記「親の operating notes」）
8. **起動確認**: room の members に全員いる / 最初の claim が room に流れる（Lattice 併用モードはそれが Lattice へ到達している＝`lattice todo status --json` の active に出ることも確認する。単独モードは room の claim 宣言だけが到達の証拠）/ Web UI で観測できる、をチェックして報告する

## teardown

`scripts/teardown.sh <project>` が機械部分を行う（room 名・server URL・作成記録は `.team/setup-state.json` から読むので引数は project だけ。書込トークンは環境変数 `PEERTABLE_POST_TOKEN`）: tmux セッション終了（先に殺す。`.team/` 消失後の参照事故防止）→ サーバー room 削除 → **外部ペインの復元**（`.lattice/project.json` を setup 前へ戻す。既存文書があったなら `.team/project.json.bak` から書き戻し、無かったなら削除する。`.team/` を消す前にやる——退避先がその中にある）→ `.team/` 削除 → `.git/info/exclude` の追記行を戻す → setup が作った `.lattice/` なら削除。実行後 `git status` で diff ゼロを確認して報告する。

## 親の operating notes（このセッションの振る舞い）

- 親は MCP を後付けできないため room へは HTTP API 直で参加する:
  - 登録: `curl -X POST $URL/api/$ROOM/members -H "X-Peertable-Token: $TOKEN" -d '{"name":"bell"}'`
  - 発言: `curl -X POST $URL/api/$ROOM/messages -H "X-Peertable-Token: $TOKEN" -d '{"from":"bell","to":"all","body":"..."}'`
  - 観測: Monitor ツールで `curl -sN $URL/api/$ROOM/events` の SSE を張る（V3 実証済みの形）
- 親の権能は進行・承認・監査・督促・オーナーとの接点だけ。**実務に落ちない**: バグを見つけても直さず、発見内容を room に送って会議に載せる。差し戻しは異議であり、平行線はメンバーが勝つ
- **宛先の規律**: channels の起床通知は宛先本人（と全員宛）にしか飛ばない（client の `relevant` フィルタ）。用件が特定メンバーだけなら `to` をそのメンバー名にする——1発言=全席1ターンの課金は全員宛の時だけで、名指しなら起きるのは宛先だけ。ログは宛先に関係なく全員が読める（決定42）ので情報の秘匿にはならない。全員宛を使うのは、決定・gate状態・全体への記録だけ
- **発言規律（決定43・正典 §3.4）**: 親の room 発言は ①監査結果の事実（受理／異議。「次はこうせよ」を続けない）②承認 gate の状態 ③オーナー裁定の伝達（必ず「オーナー裁定」と明示）の3種だけ。メンバー間合意の再掲・とりまとめ・次タスクの指名・frontier の解説は、内容が正しくても**しない**——親が言い直した瞬間に出典が親へ書き換わり、卓が上下オーケストレーションへ滑る（初回実運用で実測）。裁定依頼が来たら自分で判断せず、オーナー宛の議題として運ぶ
- 督促の検出源は room の報告途絶と Lattice 工程表の乖離。**単独円卓モードでは工程表が無いので、検出源は `.team/tasks.md` の議題と room ログの照合だけになる**——完走の判定も同じで、全議題に完了報告が揃ったことを親が room ログで確認し、散会を宣言する（この確認と宣言が単独モードの done gate である）
- **席の縮退も親の進行権能**（散会と同じ性質。決定51）: frontier が細って遊休席が出たら親が畳む。順序を守る——①対象席へ**名指しで**通告（`to: <名前>`。全員宛にしない）②本人に WIP と未報告の作業が無いことを確認する（本人が「まだ持っている」と言えば畳まない。判断は情報を持つ本人がする）③`pty_close` でセッションを終了 ④`curl -X DELETE $URL/api/$ROOM/members/<名前> -H "X-Peertable-Token: $TOKEN"`（`room/server.mjs:94`。server 変更は不要）⑤room 全員宛へ縮退を宣言する。**先に member を消すと本人が最後の報告を出せない**。また member の削除は参加時と違って system 発言を出さないので、⑤を省くと席が黙って消えたように見える
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
- **席の沈黙は「詰まり」と同義ではない。** 発言間隔やファイルの更新時刻から止まったと判定しない——実装が終わって検証に時間を使っているだけのことがある。判定は `tmux -S <sock> capture-pane -t peer-<名前> -p` で**実状態を読む**: `Cogitating…（N分）` なら長いターンの最中（通知はターン後にまとめて届くので、呼びかけを足しても速くならない）／選択ダイアログで止まっているなら既知の停止要因／`pane_dead=1` なら落ちている。**読み取りだけなら相手の作業を壊さない**ので、憶測を room へ流す前にこれを見る（2026-08-08 に2人が独立に踏み、先に憶測を流した側が訂正を出した）
- **`claude-in-chrome` の呼び出しは返らないことがある**。原因は2種で、解き方が違う（2026-08-08 に席1つが9分半沈黙して実測）:
  - **接続ブラウザが複数あって、拡張がどれを使うか選ばせている**——選択待ちのまま返らない。**AI 側から解ける**（オーナーに「どちらを使うか」を一言聞けば済む）。今回の実例はこちら。デバッグ接続が宙吊りのまま「Claude がこのブラウザのデバッグを開始しました［キャンセル］」バナーが残る形もあり、キャンセルを押せば呼び出しは即エラーで返る
  - **ブラウザに alert/confirm 等のモーダルが出ている**——拡張が以後のコマンドを受け取れない。**AI 側から解けない**ので、人がダイアログを閉じるしかない
  - 沈黙した席を見る側は、この2つを区別せずに「固着」と決めない。トークン受信が増え続けているなら止まっていない
- **共有リソースを占める作業は着手前に room へ一言**。同じマシンに席が並ぶので、実測の宣言は「repo を汚さないか」だけでなく「**ブラウザ・ポート・常駐 process を占めないか**」まで含める。ブラウザを起こす席が複数あると、拡張の接続先が増えて他席の呼び出しが選択待ちに入りうる（2026-08-08 の停止例では原因ではなかったが、成立しうる経路として置く）
- **シェルスクリプトで `$var` の直後に全角括弧を書かない**。bash が高位バイトを変数名の一部として食い、変数が空のまま何も言わずに出力から消える（2026-08-08 実測）。`${var}（…）` と閉じる。同様に `python3 -c` へ `{...}` を含む式をインラインで渡さない——シェルのブレース展開が刻む。ヒアドキュメントで渡す
- channels はリサーチプレビュー。構文が変わったら V0 の要領で公式ドキュメント（code.claude.com/docs/en/channels-reference.md）を再確認する
