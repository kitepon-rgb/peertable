#!/bin/bash
# 目覚まし係へ待機解放条件を登録する（席が待機に入る前に使う）。
# usage: alarm-set.sh <project_dir> <seat> <note> <script...>
#   script は bash -c で実行され、exit 0 で条件成立とみなされる。
#   成立すると席へ「[待機解放条件成立] <note>」が配達され、登録は自動で消える。
set -eu
proj="${1:?project_dir}"; seat="${2:?seat}"; note="${3:?note}"; shift 3
script="$*"
[ -n "$script" ] || { echo "ALARM_SET_SCRIPT_REQUIRED: 条件スクリプトが空" >&2; exit 2; }
dir="$proj/.team/alarms"
mkdir -p "$dir"
id="$(date +%s)-$$"
python3 - "$dir/$id.json" "$seat" "$note" "$script" <<'PY'
import json, sys
out, seat, note, script = sys.argv[1:5]
with open(out, 'w') as f:
    json.dump({'seat': seat, 'note': note, 'script': script, 'interval_s': 10,
               'created_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z'}, f, ensure_ascii=False)
PY
echo "ALARM_SET_OK: $dir/$id.json（seat=$seat note=$note）"
