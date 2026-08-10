# AGENTS.md

Peertable で働く全 AI エージェント共通のプロジェクト規約。上位のグローバル規約に加え、本書を優先する。

## 製品の役割

**Peertable** — A round table of peer agents. No orchestrator at the head.

親（オーケストレーター）に最終判断が集中しない、メンバー並列型のマルチエージェント作業システム。
メンバーは並列・対等・長寿命で、役割は作業履歴から堆積する。判断は情報を最も持つ者（メンバー）がする。

- 計画・設計・決定履歴の正本: [docs/plan.md](docs/plan.md)。**作業前に必ず読む**
- 実装物は room（サーバー + セッションクライアント + 読み取り専用 Web UI）と peertable スキルのみ。Lattice・aiterm-mcp・Claude Code channels は既存資産・公式機能を使い、改造しない
- 稼働状況: room は MS-A2 で Docker 常駐、公開閲覧は https://peertable.kitepon.dev（読み取り専用・決定42）。書込は API + トークンのみ
- 配布: npm **peertable**（bin: `peertable-room` / `peertable-client`）。publish はオーナーの明示指示時のみ。version bump と `npm pack --dry-run` の files 確認を publish 前に行う

## 開発規範

- **過剰設計を禁止する**（docs/plan.md 2.5 が正）。過度なセキュリティ・安全対策・失敗チェック機構を作らない。自プロジェクト内で完結する処理は、チェックで守るのではなくそもそも失敗しないように書く。チェック機構は外部プログラムに依存する境界だけに置く
- 検証ゲートは完結済み（V0〜V3 通過・V4 封印。docs/plan.md 6章）。以後の挙動変更は関連する実測を伴わせる
- **push は既定で行う**。Peertable は 2026-08-10 に dotagents 開発工場の管理対象（自作コア11製品の1つ）へ編入され、工場管理 repo への恒久 push 裁定の対象になった（dotagents `PLAN.md` 原則2・共通憲法 git 鉄則）。作業後は fetch→照合→push で真実を返す
- **publish・リモート作成・force 系・履歴改変はオーナーの明示指示時だけ行う**（編入後も変わらない。publish は H 操作であり、目的・影響・rollback を提示して承認を取る）

## 構成

```
peertable/
├── AGENTS.md             # 本書（聖典）
├── CLAUDE.md             # @AGENTS.md の 1 行 import のみ
├── package.json          # npm: peertable（bin 2 種・files 限定）
├── README.md / README.ja.md / LICENSE(MIT)
├── docs/plan.md          # 計画書（設計・決定履歴の正本）
├── room/                 # room サーバー + セッションクライアント + Dockerfile
├── deploy/               # MS-A2 常駐用 compose と Caddy snippet
├── skill/                # peertable スキル（setup/teardown。~/.claude/skills/peertable へ symlink）
└── experiments/          # V ゲートの検証コードと記録
```
