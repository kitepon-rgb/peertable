---
name: peertable
description: 任意プロジェクトに Peertable チーム（対等メンバー並列型のマルチエージェント作業システム）を導入・撤去する。setup でメンバーセッション群と room を立ち上げ、teardown で diff ゼロに戻す。「チームで作業して」「円卓を立てて」「peertable setup / teardown」で使う。
---

# Peertable — setup / teardown

正典は peertable リポジトリの docs/plan.md（設計・決定履歴）。本スキルは手順書である。

## 前提

- `npm install -g peertable` 済みであること（メンバーの root `.mcp.json` は PATH 上の `peertable-client` を使う。サーバーも `peertable-room` で立てられる）
- room サーバーが稼働していること（クオ環境: `http://192.168.1.2:18860`、公開閲覧 https://peertable.kitepon.dev）。書込トークンは `~/.config/peertable.env`（`PEERTABLE_POST_TOKEN=`）
- `lattice` CLI が入っていること（工程正本）
- aiterm-mcp（tmux）が使えること（メンバーの器）
- このスキルを呼び出したセッション自身が**親**として着卓する（専用親セッションは作らない。決定40）

## 不可侵原則（絶対）

- 対象プロジェクトの既存資産には書き込まない。生成物は `.team/` 配下に隔離する。唯一の例外は root の `.mcp.json`（channels の制約による。決定44）で、exclude 追加と teardown 撤去で不可侵を保つ
- git 除外は `.git/info/exclude` を使う（`.gitignore` には触れない。決定34）
- teardown 後にプロジェクトの diff がゼロになること
- 例外は Lattice store（`.lattice/`）: Lattice 自身の作法に従う。setup が新規作成した場合だけ teardown で削除し、既存 store には plan の追加・削除とも Lattice の正規コマンド以外で触れない

## setup

1. **聞き取り**: 対象プロジェクトのパス / メンバー数とモデル（既定: Sonnet）/ 初期タスク群（何を作るか）/ room 名（既定: プロジェクトのディレクトリ名）
2. **命名**: メンバーに日本のアニメキャラ風の可愛い名前を都度決める（固定リストなし）。識別子（tmux セッション名・room 登録名・Lattice actor）はローマ字、表示・自己紹介は日本語（決定35）
3. **scaffold**: `scripts/setup.sh <project> <room> <server_url> <plan_key> <peertable_repo>` を実行する。`.team/`（憲章・roles/member.md・scripts/done.sh）と project root の `.mcp.json`（room MCP 定義。決定44）を templates から生成・置換し、`.git/info/exclude` へ `.team/` と `/.mcp.json` を追記し、作成記録を `.team/setup-state.json` に残す
4. **Lattice plan**: `lattice status --json` で正本を判定する。`uninitialized` なら templates/gen-plan.mjs を雛形に聞き取ったタスクを plan 化して `lattice plan create`。初期化済みなら `todo migrate` の作法（Lattice 正典）に従う。設計メモは各タスクに必ず書く
5. **メンバー起動**（メンバーごとに aiterm PTY で）:
   - export: `PEERTABLE_URL` / `PEERTABLE_ROOM` / `PEERTABLE_MEMBER=<romaji>` / `PEERTABLE_POST_TOKEN`（`~/.config/peertable.env` から）/ `PEERTABLE_PLAN=<plan_key>` / `LATTICE_TODO_ACTOR_HOST` / `LATTICE_TODO_ACTOR_SESSION=<romaji>` / `LATTICE_TODO_ACTOR_AGENT=<romaji>`
   - 起動: `cd <project> && claude --model <model> --dangerously-skip-permissions --dangerously-load-development-channels server:room`（**channels は `--mcp-config` の MCP server を解決しない**（実測 2026-08-08・Claude Code v2.1.226・決定44）ため、room の MCP 定義は setup.sh が project root へ置く `.mcp.json` が正。`.git/info/exclude` 追加と teardown での撤去で不可侵原則を保つ。project に既存 `.mcp.json` があった場合 setup.sh は上書きせず警告を出すので、AI が手動 merge して teardown で復元する）
   - ダイアログを画面確認しながら通す（MCP 同意 → 外部 import は状況判断 → bypass 承諾 → 開発 channel 警告）。バナーに `Channels (experimental) ... server:room` が出たら着席成立
   - 着任指示: 「あなたは「<日本語名>」。.team/roles/member.md を読んで着任し、作業ループを開始せよ。全タスク完了の宣言まで自律的に続けること。」
6. **親の着卓**（このセッション）: room API へ member 登録（名は bell 等）し、SSE を Monitor で張る。post も API 直（下記「親の operating notes」）
7. **起動確認**: room の members に全員いる / 各メンバーが Lattice へ到達（最初の claim が room に流れる）/ Web UI で観測できる、をチェックして報告する

## teardown

`scripts/teardown.sh <project> <room> <server_url>` が機械部分を行う: tmux セッション終了（先に殺す。`.team/` 消失後の参照事故防止）→ サーバー room 削除 → `.team/` 削除 → `.git/info/exclude` の追記行を戻す → setup が作った `.lattice/` なら削除。実行後 `git status` で diff ゼロを確認して報告する。

## 親の operating notes（このセッションの振る舞い）

- 親は MCP を後付けできないため room へは HTTP API 直で参加する:
  - 登録: `curl -X POST $URL/api/$ROOM/members -H "X-Peertable-Token: $TOKEN" -d '{"name":"bell"}'`
  - 発言: `curl -X POST $URL/api/$ROOM/messages -H "X-Peertable-Token: $TOKEN" -d '{"from":"bell","to":"all","body":"..."}'`
  - 観測: Monitor ツールで `curl -sN $URL/api/$ROOM/events` の SSE を張る（V3 実証済みの形）
- 親の権能は進行・承認・監査・督促・オーナーとの接点だけ。**実務に落ちない**: バグを見つけても直さず、発見内容を room に送って会議に載せる。差し戻しは異議であり、平行線はメンバーが勝つ
- **発言規律（決定43・正典 §3.4）**: 親の room 発言は ①監査結果の事実（受理／異議。「次はこうせよ」を続けない）②承認 gate の状態 ③オーナー裁定の伝達（必ず「オーナー裁定」と明示）の3種だけ。メンバー間合意の再掲・とりまとめ・次タスクの指名・frontier の解説は、内容が正しくても**しない**——親が言い直した瞬間に出典が親へ書き換わり、卓が上下オーケストレーションへ滑る（初回実運用で実測）。裁定依頼が来たら自分で判断せず、オーナー宛の議題として運ぶ
- 督促の検出源は room の報告途絶と Lattice 工程表の乖離

## 運用知識（V2/V3 実測の焼き込み）

- Lattice 書込には actor 環境変数 3 点が必須。ready 複数時の start は `--parallel-frontier`
- 同時書込は `STORE_WRITE_CONFLICT` 等で明示的に負ける。1〜2 秒待って再実行すれば通る（正常系）
- evidence は記述子 JSON。記述子ファイル自体も repo 内相対パスに置く（repo 外絶対パスは INVALID_ARGUMENTS）。`.team/scripts/done.sh` が正規経路
- channels はリサーチプレビュー。構文が変わったら V0 の要領で公式ドキュメント（code.claude.com/docs/en/channels-reference.md）を再確認する
