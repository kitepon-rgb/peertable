#!/bin/bash
# V2 並行アクセス検証ワーカー。usage: worker.sh <task番号>
# 別セッションを名乗る actor で start→note→done を一気に流す。
n="$1"
export LATTICE_TODO_ACTOR_HOST=mac
export LATTICE_TODO_ACTOR_SESSION="w$n"
export LATTICE_TODO_ACTOR_AGENT="bell-w$n"

echo "# t$n 完了証跡: 並行アクセス検証 worker w$n" > "ev-t$n.md"
oid=$(git hash-object -w "ev-t$n.md")
digest=$(shasum -a 256 "ev-t$n.md" | cut -d' ' -f1)
cat > "ev-t$n.json" <<EOF
{"evidence_id":"ev-t$n","repo_id":"self","path":"ev-t$n.md","git_blob_oid":"$oid","content_digest":"$digest","media_type":"text/markdown","anchor_digest":null}
EOF

lattice todo start --plan v2 --task "t$n" --parallel-frontier > "out-start-t$n.json" 2>&1
lattice todo note --plan v2 --task "t$n" --message "worker w$n 作業中" > "out-note-t$n.json" 2>&1
lattice todo done --plan v2 --task "t$n" --evidence "ev-t$n.json" > "out-done-t$n.json" 2>&1
