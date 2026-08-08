#!/bin/bash
# usage: .team/scripts/done.sh <task_id>
# evidence/<plan_key>/<task_id>.md（commit 済みであること）から記述子を作り lattice todo done を実行する。
# plan key は環境変数 PEERTABLE_PLAN から取る。
# 証跡を plan key で仕切るのは、task_id が campaign を跨いで再利用される（t1, t2, …）ため。
# 平置きだと次の campaign の t1 が前の campaign の t1 の監査証跡を上書きで消す（2026-08-08 実測）。
set -e
t="$1"
f="evidence/$PEERTABLE_PLAN/$t.md"
oid=$(git hash-object -w "$f")
digest=$(shasum -a 256 "$f" | cut -d' ' -f1)
# 記述子は repo 内の相対パスに置く（repo 外の絶対パスは --evidence が INVALID_ARGUMENTS で弾く）
tmp=".ev-$t.json"
printf '{"evidence_id":"ev-%s","repo_id":"self","path":"%s","git_blob_oid":"%s","content_digest":"%s","media_type":"text/markdown","anchor_digest":null}\n' "$t" "$f" "$oid" "$digest" > "$tmp"
lattice todo done --plan "$PEERTABLE_PLAN" --task "$t" --evidence "$tmp"
rm -f "$tmp"
