# AGENTS.md

Peertable で働く全 AI エージェント共通のプロジェクト規約。上位のグローバル規約に加え、本書を優先する。

## 製品の役割

**Peertable** — A round table of peer agents. No orchestrator at the head.

親（オーケストレーター）に最終判断が集中しない、メンバー並列型のマルチエージェント作業システム。
メンバーは並列・対等・長寿命で、役割は作業履歴から堆積する。判断は情報を最も持つ者（メンバー）がする。

- 計画・設計・決定履歴の正本: [docs/plan.md](docs/plan.md)。**作業前に必ず読む**
- 実装物は room（ローカル MCP + ブリッジ + Web UI）と team-dev スキルのみ。Lattice・aiterm-mcp・Claude Code channels は既存資産・公式機能を使い、改造しない

## 開発規範

- **過剰設計を禁止する**（docs/plan.md 2.5 が正）。過度なセキュリティ・安全対策・失敗チェック機構を作らない。自プロジェクト内で完結する処理は、チェックで守るのではなくそもそも失敗しないように書く。チェック機構は外部プログラムに依存する境界だけに置く
- 検証は docs/plan.md 6章の V ゲート（V0→V4）を順に通す。前段が失敗したら後段に進まない
- push・publish・リモート作成はオーナーの明示指示時だけ行う

## 構成

```
peertable/
├── AGENTS.md             # 本書（聖典）
├── CLAUDE.md             # @AGENTS.md の 1 行 import のみ
├── docs/plan.md          # 計画書（設計・決定履歴の正本）
├── room/                 # room 実装
├── skill/                # team-dev スキル
└── experiments/          # V ゲートの検証コードと記録
```
