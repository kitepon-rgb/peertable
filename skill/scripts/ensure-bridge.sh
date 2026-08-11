#!/bin/bash
# bridge を tmux に常駐させ、最初の ready_at まで待つ薄い supervisor。
set -euo pipefail

proj="$1"; name="$2"; shift 2
case "$name" in seat-status) script="seat-status-bridge.mjs" ;; wakeup) script="wakeup-bridge.mjs" ;; run) script="run-bridge.mjs" ;; *) echo "usage: ensure-bridge.sh <project> <seat-status|wakeup|run> [args...]" >&2; exit 1 ;; esac
team="$proj/.team"; record="$team/$name-bridge.json"; log="$team/$name-bridge.log"
force=false
if [ "${1:-}" = "--force" ]; then force=true; shift; fi
if [ $# -eq 0 ] && [ -f "$record" ]; then
  saved=()
  while IFS= read -r arg; do saved+=("$arg"); done < <(node -e 'const x=require(process.argv[1]); for (const a of x.args||[]) console.log(a)' "$record")
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
# **死んだ記録をここで消す。** 残すと下の loop が前回の `ready_at` を読んで、
# 新しい bridge が1バイトも動いていない段階で success を返す——「起動していないのに
# 起動したと言う」＝この supervisor が塞ぐはずの穴そのものになる。
rm -f "$record"
: > "$log"
# **session が在るだけでは常駐が生きている証拠にならない**（中の node だけ死んで殻が残る）。
# 上で pid 生存を確かめて here まで来た＝生きていないので、殻は畳んでから立て直す。
tmux -S "$sock" kill-session -t "$session" 2>/dev/null || true
tmux -S "$sock" new-session -d -s "$session" "node $(dirname "$0")/$script $(printf '%q ' "$proj" "$@") >> $(printf '%q' "$log") 2>&1"
for _ in $(seq 1 30); do
  if [ -f "$record" ] && node -e 'process.exit(require(process.argv[1]).ready_at?0:1)' "$record"; then
    # **末尾は本物の改行にする。** `"\\n"` と書くと JS がリテラルの `\`+`n` を足し、
    # record が JSON として壊れる——`--stop` も次回起動も `JSON.parse` で落ちて、
    # 「止められない・建て直せない常駐」ができる（2026-08-11 実測）。一時 file→rename で原子的に。
    node -e 'const fs=require("fs");const p=process.argv[1],a=process.argv.slice(2);
      const t=`${p}.${process.pid}.tmp`;
      fs.writeFileSync(t,JSON.stringify({...JSON.parse(fs.readFileSync(p,"utf8")),args:a})+"\n");
      fs.renameSync(t,p)' "$record" "$@"
    exit 0
  fi
  sleep .5
done
echo "${name}-bridge: ready_at を待てなかった。ログ末尾:" >&2
tail -n 20 "$log" >&2 || true
exit 1
