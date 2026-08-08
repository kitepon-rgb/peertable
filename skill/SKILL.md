---
name: peertable
description: 任意プロジェクトに Peertable チーム（対等メンバー並列型のマルチエージェント作業システム）を導入・撤去する。setup でメンバーセッション群と room を立ち上げ、teardown で diff ゼロに戻す。「チームで作業して」「円卓を立てて」「peertable setup / teardown」で使う。
---

# Peertable — setup / teardown

正典は peertable リポジトリの docs/plan.md（設計・決定履歴）。本スキルは手順書である。

## 前提

- `npm install -g peertable` 済みであること（メンバーの `.team/mcp.json` は PATH 上の `peertable-client` を使う。サーバーも `peertable-room` で立てられる）
- room サーバーが稼働していること（クオ環境: `http://192.168.1.2:18860`、公開閲覧 https://peertable.kitepon.dev）。書込トークンは `~/.config/peertable.env`（`PEERTABLE_POST_TOKEN=`）
- `lattice` CLI が入っていること（工程正本）
- aiterm-mcp（tmux）が使えること（メンバーの器）
- このスキルを呼び出したセッション自身が**親**として着卓する（専用親セッションは作らない。決定40）

## 不可侵原則（絶対）

- 対象プロジェクトの既存資産には書き込まない。生成物は `.team/` 配下に隔離する
- git 除外は `.git/info/exclude` を使う（`.gitignore` には触れない。決定34）
- teardown 後にプロジェクトの diff がゼロになること
- 例外は Lattice store（`.lattice/`）: Lattice 自身の作法に従う。setup が新規作成した場合だけ teardown で削除し、既存 store には plan の追加・削除とも Lattice の正規コマンド以外で触れない

## setup

1. **聞き取り**: 対象プロジェクトのパス / メンバー数とモデル（既定: Sonnet）/ 初期タスク群（何を作るか）/ room 名（既定: プロジェクトのディレクトリ名）
2. **命名**: メンバーに日本のアニメキャラ風の可愛い名前を都度決める（固定リストなし）。識別子（tmux セッション名・room 登録名・Lattice actor）はローマ字、表示・自己紹介は日本語（決定35）
3. **scaffold**: `scripts/setup.sh <project> <room> <server_url>` を実行する。`.team/`（憲章・roles/member.md・scripts/done.sh・mcp.json）を templates から生成・置換し、`.git/info/exclude` へ `.team/` を追記し、作成記録を `.team/setup-state.json` に残す
4. **Lattice plan**: `lattice status --json` で正本を判定する。`uninitialized` なら templates/gen-plan.mjs を雛形に聞き取ったタスクを plan 化して `lattice plan create`。初期化済みなら `todo migrate` の作法（Lattice 正典）に従う。設計メモは各タスクに必ず書く
5. **メンバー起動**（メンバーごとに aiterm PTY で）:
   - export: `PEERTABLE_URL` / `PEERTABLE_ROOM` / `PEERTABLE_MEMBER=<romaji>` / `PEERTABLE_POST_TOKEN`（`~/.config/peertable.env` から）/ `PEERTABLE_PLAN=<plan_key>` / `LATTICE_TODO_ACTOR_HOST` / `LATTICE_TODO_ACTOR_SESSION=<romaji>` / `LATTICE_TODO_ACTOR_AGENT=<romaji>`
   - 起動: `cd <project> && claude --model <model> --mcp-config .team/mcp.json --dangerously-skip-permissions --dangerously-load-development-channels server:room`（`--mcp-config` でプロジェクト root に `.mcp.json` を置かない＝不可侵原則。もし channels が `--mcp-config` のサーバーを解決しない場合だけ、root `.mcp.json` を置いて teardown で消すフォールバックを使い、その旨を報告する）
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
- 督促の検出源は room の報告途絶と Lattice 工程表の乖離

## 運用知識（V2/V3 実測の焼き込み）

- Lattice 書込には actor 環境変数 3 点が必須。ready 複数時の start は `--parallel-frontier`
- 同時書込は `STORE_WRITE_CONFLICT` 等で明示的に負ける。1〜2 秒待って再実行すれば通る（正常系）
- evidence は記述子 JSON。記述子ファイル自体も repo 内相対パスに置く（repo 外絶対パスは INVALID_ARGUMENTS）。`.team/scripts/done.sh` が正規経路
- channels はリサーチプレビュー。構文が変わったら V0 の要領で公式ドキュメント（code.claude.com/docs/en/channels-reference.md）を再確認する
