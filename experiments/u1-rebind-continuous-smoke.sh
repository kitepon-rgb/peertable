#!/bin/bash
# u1 cross-plan rebind後の機械手順。新CLIを推測せず、exact wrapperを明示投入した時だけ進める。
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
plan_key='peertable-task-announcements-fx-20260812'
input_path='evidence/peertable-task-announcements-fx-20260812/u1-structure-input.json'
saved_source='.lattice/todo/structure/peertable-task-announcements-fx-20260812.json'
audit_receipt=${U1_REI_AUDIT_RECEIPT:-}
rebind_command=${U1_REBIND_COMMAND:-}
rebind_receipt=${U1_REBIND_RECEIPT_FILE:-}
lattice_cli=${LATTICE_CLI:-lattice}

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

# 未deploy時はこの判定より後の副作用を一切起こさない。
[ -n "$rebind_command" ] || fail 'U1_REBIND_COMMAND_UNSET' 64
[ -n "$rebind_receipt" ] || fail 'U1_REBIND_RECEIPT_FILE_UNSET' 64
[ "${rebind_command#/}" != "$rebind_command" ] || fail 'U1_REBIND_COMMAND_NOT_ABSOLUTE' 64
[ -x "$rebind_command" ] || fail 'U1_REBIND_COMMAND_NOT_EXECUTABLE' 64

case "$rebind_receipt" in
  /*) ;;
  *) fail 'U1_REBIND_RECEIPT_FILE_NOT_ABSOLUTE' 64 ;;
esac

run_silently() {
  local log
  log=$(mktemp "${TMPDIR:-/tmp}/u1-rebind-smoke.XXXXXX")
  trap 'rm -f "$log"' RETURN
  "$@" >"$log" 2>&1 || fail "U1_REBIND_SMOKE_COMMAND_FAILED:$1"
  rm -f "$log"
  trap - RETURN
}

cd "$repo_dir"

# characterization: staleを先に固定する。出力にはcredentialもreceipt本文も出さない。
run_silently node experiments/u1-binding-stale-rebind-repro.mjs

# wrapperの中身はdeploy後に実測したexact rebind commandだけ。ここではCLI名・引数を推測しない。
run_silently "$rebind_command"
[ -f "$rebind_receipt" ] && [ -s "$rebind_receipt" ] || fail 'U1_REBIND_RECEIPT_MISSING'

status_log=$(mktemp "${TMPDIR:-/tmp}/u1-rebind-status.XXXXXX")
trap 'rm -f "$status_log"' EXIT
"$lattice_cli" status --json >"$status_log" 2>&1 || fail 'U1_REBIND_STATUS_NOT_READY'
jq -e '.schema == "lattice.project_status.v1" and .state == "ready"' "$status_log" >/dev/null \
  || fail 'U1_REBIND_STATUS_NOT_READY'
rm -f "$status_log"
trap - EXIT

# input writerがcanonical saved sourceを作る。既存inputとsaved sourceを直接編集しない。
run_silently "$lattice_cli" todo structure input --plan "$plan_key" --input "$input_path"
[ -f "$saved_source" ] && [ -s "$saved_source" ] || fail 'U1_STRUCTURE_SAVED_SOURCE_MISSING'
run_silently "$lattice_cli" todo structure compile --plan "$plan_key" --input "$saved_source"

# peer audit前のupgrade/a6 startは禁止。receipt内容は出力・解釈せず、明示PASS後にだけ次へ進む。
[ -n "$audit_receipt" ] || fail 'U1_REI_AUDIT_RECEIPT_UNSET' 64
[ "${audit_receipt#/}" != "$audit_receipt" ] || fail 'U1_REI_AUDIT_RECEIPT_NOT_ABSOLUTE' 64
[ -f "$audit_receipt" ] && [ -s "$audit_receipt" ] || fail 'U1_REI_AUDIT_RECEIPT_MISSING' 64

run_silently bash skill/scripts/upgrade-team-assets.sh "$repo_dir"
run_silently bash .team/scripts/start.sh a6

printf '%s\n' 'U1_REBIND_CONTINUOUS_SMOKE_MACHINE_STEPS_COMPLETE'
printf '%s\n' 'U1_A6_STARTED_DELIVERY_ASSERTION_REQUIRED'
