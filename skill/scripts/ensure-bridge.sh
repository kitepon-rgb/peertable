#!/bin/bash
# bridge を tmux に常駐させ、最初の ready_at まで待つ薄い supervisor。
set -euo pipefail

proj="$1"; name="$2"; shift 2
case "$name" in seat-status) script="seat-status-bridge.mjs" ;; wakeup) script="wakeup-bridge.mjs" ;; run) script="run-bridge.mjs" ;; *) echo "usage: ensure-bridge.sh <project> <seat-status|wakeup|run> [args...]" >&2; exit 1 ;; esac
team="$proj/.team"; record="$team/$name-bridge.json"; log="$team/$name-bridge.log"
force=false
if [ "${1:-}" = "--force" ]; then force=true; shift; fi
if [ $# -eq 0 ] && [ -f "$record" ]; then
  mapfile -t saved < <(node -e 'const x=require(process.argv[1]); for (const a of x.args||[]) console.log(a)' "$record")
  set -- "${saved[@]}"
fi
if [ -f "$record" ]; then
  pid=$(node -e 'try{process.stdout.write(String(require(process.argv[1]).pid||""))}catch{}' "$record")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi
  if ! "$force" && grep -q 'WRITE_DENIED' "$log" 2>/dev/null; then echo "${name}-bridge: 前回はWRITE_DENIEDで終了。--forceを指定すること" >&2; exit 1; fi
fi
sock=$(node "$(dirname "$0")/tmux-socket.mjs")
room=$(node -e 'process.stdout.write(require(process.argv[1]).room)' "$team/setup-state.json")
session="peertable-${name}-${room}"
tmux -S "$sock" has-session -t "$session" 2>/dev/null || tmux -S "$sock" new-session -d -s "$session" "node $(dirname "$0")/$script $(printf '%q ' "$proj" "$@") >> $(printf '%q' "$log") 2>&1"
for _ in $(seq 1 30); do
  [ -f "$record" ] && node -e 'process.exit(require(process.argv[1]).ready_at?0:1)' "$record" && exit 0
  sleep .5
done
echo "${name}-bridge: ready_at を待てなかった。ログ末尾:" >&2
tail -n 20 "$log" >&2 || true
exit 1
