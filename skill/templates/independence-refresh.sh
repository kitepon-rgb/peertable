#!/bin/bash
# remaining の並列記録を、今の HEAD で compile し直す。親は呼ばない。
# usage: independence-refresh.sh <plan_key>
set -e
plan="${1:-${PEERTABLE_PLAN:-}}"
[ -n "$plan" ] || {
  echo "usage: independence-refresh.sh <plan_key>" >&2
  exit 2
}
witness=".lattice/todo/witness/${plan}.json"
[ -f "$witness" ] || {
  echo "ERROR: witness が無い: ${witness}。remaining A を witness に書いてから compile する" >&2
  exit 1
}
lattice_cli="${LATTICE_CLI:-lattice}"
compile_out=""
compile_rc=0
compile_out=$("$lattice_cli" todo independence compile --plan "$plan" --input "$witness" 2>&1) || compile_rc=$?
printf '%s\n' "$compile_out"
[ "$compile_rc" -eq 0 ] || {
  echo "ERROR: INDEPENDENCE_COMPILE_FAILED: 自分で witness を直して再実行する。親は呼ばない" >&2
  exit 1
}
