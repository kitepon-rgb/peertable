# terminal-audit（seat-status-descriptor-fx-20260811）— 親裁定 2026-08-11

第1 plan の締め（受入・文書・版・publish）を工程正本へ載せ直した plan。f1〜f6 すべて done。

## 判定

**accept。**

| task | 担当 | 結果 |
|---|---|---|
| f1 wakeup catch-up 回帰 | sakuya | 本 campaign が入れた回帰。`refreshMembers()` を非致命化して base の green へ復帰 |
| f2 受入 A〜G | 親 | C=31分59秒/240tick、A-1/A-2/B/D/E/F 通過、G=15green/7red（7本は着手前から赤） |
| f3 SKILL.md | himari | 3ブリッジの ensure 化・観測契約・socket 解決順・既存席の再起動注意・WSL 二重 install |
| f4 決定74 と非目標 | chinatsu | `docs/plan.md` へ決定74、非目標7件を §未着手 へ |
| f5 0.3.8 publish | 親 | 公開後 smoke まで確認。prepublishOnly が版の食い違いを一度止めた |
| f6 第1 plan の gate | 親 | 受入を根拠に accept（`close-unaudited` で流していない） |

## この plan が生まれた理由（同じ穴を作らないため）

第1 plan は**席が実装する4 task しか起票せず**、受入・文書・版・publish を親のコンテキストと
Markdown だけに置いていた。結果 `lattice todo status` が「全部 done」を返す一方で作業が残り、
**工程正本と実態が食い違った**（オーナー指摘）。**AI の頭の中だけにある作業を作らない**——
campaign を起票する時点で、親が持つ範囲も同じ工程表へ載せる。

## 残した穴

`docs/plan.md` §未着手 に7件。最優先は **room 不達で bridge が「黙って無になる」**
（`seat-usage.mjs:64` で `attempted===0` → `verdict:'idle'`）。オーナーは「検出したら粘る」を
裁定済みだが、検出機能自体が本 campaign の範囲外だったため未消化のまま残る。

## この端末で取れなかった検証

**macOS では nohup 版の bridge も死なない**（実測）。死ぬのは WSL の `wsl -e bash -lc` 経由だけなので、
nohup との対照実験は組めなかった。tmux 常駐が呼び出し元シェルから独立していることまでを測り、
nohup 側の対照は WSL handoff（`f5.md`）へ回した。**取れないことを黙って省略していない。**
