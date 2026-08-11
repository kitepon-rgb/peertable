#!/bin/bash
# Peertable の正規着手入口。
# usage: .team/scripts/start.sh <task_id> [lattice todo start options...]
# Lattice 併用モードは todo start 成功後だけ started task event を一度送る。
# 単独円卓モードは .team/tasks.md の議題を解決して started task event を送る。
set -u

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] || fail "task_id が必要（usage: start.sh <task_id> [lattice todo start options...]）"
task_id="$1"
shift
case "$task_id" in
  ''|--*) fail "task_id が不正: $task_id" ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$project_dir" || fail "projectへ移動できない: $project_dir"
state="$project_dir/.team/setup-state.json"
[ -f "$state" ] || fail "setup-state.json が無い: $state"
helper="$script_dir/start-event.mjs"
[ -f "$helper" ] || fail "着手event helperが無い: $helper"

state_value() {
  node "$helper" state "$state" "$1"
}

mode=$(state_value mode) || fail "setup-state.json の mode を読めない"
url="${PEERTABLE_URL:-}"
[ -n "$url" ] || url=$(state_value server_url) || fail "room URL が無い"
room="${PEERTABLE_ROOM:-}"
[ -n "$room" ] || room=$(state_value room) || fail "room 名が無い"
actor="${PEERTABLE_MEMBER:-}"
[ -n "$actor" ] || fail "PEERTABLE_MEMBER が無い"
credential_file="${PEERTABLE_CREDENTIAL_FILE:-}"
[ -n "$credential_file" ] || fail "PEERTABLE_CREDENTIAL_MISSING: credential file pathが無い"
[ -f "$credential_file" ] || fail "PEERTABLE_CREDENTIAL_UNREADABLE: credential fileが無い"
[ -s "$credential_file" ] || fail "PEERTABLE_CREDENTIAL_INVALID: credential fileが空"

event_plan=""
event_title=""
lattice_cli=""

case "$mode" in
  lattice)
    plan=$(state_value plan_key) || fail "Lattice卓のplan_keyが無い"
    lattice_cli="${LATTICE_CLI:-$(command -v lattice 2>/dev/null || true)}"
    [ -n "$lattice_cli" ] && [ -x "$lattice_cli" ] || fail "lattice CLI が実行可能fileでない"

    # titleはcallerの自由文でなく、着手前に工程正本から解決する。
    task_json=$("$lattice_cli" todo show --plan "$plan" --task "$task_id" --json 2>&1) || {
      echo "$task_json" >&2
      exit 1
    }
    event_title=$(printf '%s' "$task_json" | node "$helper" lattice-title) || fail "工程正本からtask titleを解決できない: $task_id"
    event_plan="$plan"

    # --parallel-frontier、--phase等は捨てず、そのまま正規todo startへ渡す。
    start_output=""
    start_rc=0
    start_output=$("$lattice_cli" todo start --plan "$plan" --task "$task_id" "$@" 2>&1) || start_rc=$?
    printf '%s\n' "$start_output"
    [ "$start_rc" -eq 0 ] || exit "$start_rc"

    # start event digestをtransitionへ束縛する。同じstartの再試行は同じtransitionを再送できる。
    transition_digest=$(printf '%s' "$start_output" | node "$helper" start-digest) || fail "todo startのevent digestを解決できない（started通知を送らない）"
    transition_id="started:${transition_digest}"
    ;;
  standalone)
    [ "$#" -eq 0 ] || fail "standalone modeでは追加のLattice optionを渡せない"
    tasks_file="$project_dir/.team/tasks.md"
    [ -f "$tasks_file" ] || fail "単独卓の議題表が無い: $tasks_file"
    event_title=$(node "$helper" standalone-title "$tasks_file" "$task_id") || fail "議題表にtaskが無い: $task_id"
    event_plan="standalone"
    transition_id=$(TASK_EVENT_URL="$url" \
      TASK_EVENT_ROOM="$room" \
      TASK_EVENT_ACTOR="$actor" \
      TASK_EVENT_TASK="$task_id" \
      node "$helper" standalone-transition) || fail "standalone claimからtransitionを解決できない（started通知を送らない）"
    ;;
  *)
    fail "setup-state.json の mode が不正: $mode"
    ;;
esac

# credential fileはhelperのNode processだけで読み、tokenをargv・環境変数・出力へ載せない。
TASK_EVENT_URL="$url" \
TASK_EVENT_ROOM="$room" \
TASK_EVENT_ACTOR="$actor" \
TASK_EVENT_PLAN="$event_plan" \
TASK_EVENT_TASK="$task_id" \
TASK_EVENT_TITLE="$event_title" \
TASK_EVENT_TRANSITION="$transition_id" \
PEERTABLE_CREDENTIAL_FILE="$credential_file" \
node "$helper" send-event
