#!/bin/bash
# ensure-bridge.sh の再現ハーネス。**実物の ensure-bridge.sh を呼ぶ**——呼ばないハーネスは
# 「テストが在る」という見た目だけを作って、未検証を検証済みに見せる（2026-08-11 に一度そうなった）。
#
# 使い捨ての socket / project / room server だけを触り、稼働中の卓へは一切触れない。
#
# **macOS では nohup 版は死なない**（実測 2026-08-11: setup が起こした nohup の bridge は生存した）。
# 死ぬのは WSL の `wsl -e bash -lc` 経由だけなので、「nohup が落ちる」対照実験はここでは組めない。
# 代わりに **tmux 常駐が呼び出し元シェルの終了から独立している**ことを直接測る（c）。
# nohup との対照は WSL 側の受入で取る——ここで取れないことを黙って省略しない。
set -euo pipefail

root=$(mktemp -d)
sock="$root/t.sock"
proj="$root/proj"
mkdir -p "$proj/.team"
here=$(cd "$(dirname "$0")" && pwd)
ensure="$here/../skill/scripts/ensure-bridge.sh"
pass=0
srv_pid=""

cleanup() {
  [ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null || true
  tmux -S "$sock" kill-server 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

ok() { pass=$((pass + 1)); echo "  ok: $1"; }
die() { echo "FAIL: $1" >&2; exit 1; }

record="$proj/.team/seat-status-bridge.json"
bridge_pid() { node -e 'try{process.stdout.write(String(require(process.argv[1]).pid||""))}catch{}' "$record"; }
ready_at() { node -e 'try{process.stdout.write(String(require(process.argv[1]).ready_at||""))}catch{}' "$record"; }

# 使い捨て room。status を保持する版として振る舞う最小実装（bridge は GET /members の
# capabilities を見てから書き始めるので、これが無いと ready_at に到達しない）
port=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
node -e '
const http = require("http")
http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/members")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    return res.end(JSON.stringify({ members: [], capabilities: { member_observation_v1: true } }))
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}")
}).listen(Number(process.argv[1]))
' "$port" &
srv_pid=$!
disown 2>/dev/null || true   # 後始末の kill が job 終了メッセージで green を汚さないように
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$port/api/x/members" && break; sleep .25; done

printf '{"room":"x","server_url":"http://127.0.0.1:%s","mode":"standalone","plan_key":""}\n' "$port" > "$proj/.team/setup-state.json"
export PEERTABLE_TMUX_SOCKET="$sock"
export PEERTABLE_POST_TOKEN=""

echo "(a) 起動して ready_at が出るまで待ってから成功を返す"
"$ensure" "$proj" seat-status --interval 2 >/dev/null || die "(a) ensure が非ゼロ"
[ -n "$(ready_at)" ] || die "(a) 成功したのに ready_at が無い＝生存確認になっていない"
p1=$(bridge_pid); [ -n "$p1" ] && kill -0 "$p1" 2>/dev/null || die "(a) bridge が生きていない"
tmux -S "$sock" has-session -t peertable-seat-status-x 2>/dev/null || die "(a) 専用 tmux session が無い"
ok "ready_at を確認してから成功（pid ${p1}）"

echo "(b) 冪等——生きているなら何もしない"
"$ensure" "$proj" seat-status >/dev/null || die "(b) 2回目が非ゼロ"
[ "$(bridge_pid)" = "$p1" ] || die "(b) 生きている常駐を建て直した"
ok "2回目は同じ pid のまま"

echo "(c) 呼び出し元シェルが死んでも常駐は生きる（tmux 常駐の要点）"
outer=$(bash -c 'echo $$; exec sleep 0.1' | head -1)
sleep 1
kill -0 "$outer" 2>/dev/null && die "(c) 測定器の前提が崩れている（親シェルがまだ生きている）"
kill -0 "$p1" 2>/dev/null || die "(c) 呼び出し元の終了で常駐が死んだ"
ok "親シェル消滅後も常駐が生存"

echo "(d) 死んだ常駐の stale ready_at で success を返さない"
kill "$p1" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$p1" 2>/dev/null || break; sleep .25; done
# 常駐は SIGTERM で記録を消すので、**前回の ready_at が残っている状況を明示的に作る**
printf '{"pid":%s,"started_at":"2020-01-01T00:00:00.000Z","ready_at":"2020-01-01T00:00:00.000Z"}\n' "$p1" > "$record"
# 引数なしの stale record を復元する経路。args=[] の展開で落ちないこともここで測る。
"$ensure" "$proj" seat-status >/dev/null || die "(d) ensure が非ゼロ"
p2=$(bridge_pid)
[ "$p2" != "$p1" ] || die "(d) 死んだ pid のまま success を返した"
[ "$(ready_at)" != "2020-01-01T00:00:00.000Z" ] || die "(d) 前回の ready_at を自分の生存確認に使った"
kill -0 "$p2" 2>/dev/null || die "(d) 建て直した常駐が生きていない"
ok "stale ready_at を無視して建て直した（pid ${p1} → ${p2}）"

echo "(e) ready_at が出なければ非ゼロ＋ログ末尾"
"$ensure" "$proj" seat-status --stop >/dev/null 2>&1 || true
tmux -S "$sock" kill-session -t peertable-seat-status-x 2>/dev/null || true
rm -f "$record"
printf '{"room":"x","server_url":"http://127.0.0.1:1","mode":"standalone","plan_key":""}\n' > "$proj/.team/setup-state.json"
set +e
out=$("$ensure" "$proj" seat-status --interval 2 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ] || die "(e) 届いていないのに成功を返した"
echo "$out" | grep -q 'ready_at を待てなかった' || die "(e) 失敗理由が出ていない: $out"
ok "非ゼロで落ち、ログ末尾を出した"

echo "bridge supervisor repro: ${pass}/5 green"
