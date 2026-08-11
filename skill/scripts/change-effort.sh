#!/bin/bash
# 互換入口（配布済みの effort 専用入口）。実体は change-seat.sh で、ここは引数の形だけを保つ。
# usage: change-effort.sh <project_dir> <member> <effort> [parent_name]
#
# **本人DMの完全一致検査は持たない。** 依頼の意味判断は親（AI）が行い、script は確定した target だけを受ける。
# 出力・終了コードは change-seat.sh のもの（SEAT_CHANGE_*）をそのまま返す。
set -eu

proj="${1:-}"; name="${2:-}"; effort="${3:-}"; parent="${4:-bell}"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$effort" ] || {
  echo "SEAT_CHANGE_ARGS_INVALID: usage: change-effort.sh <project_dir> <member> <effort> [parent_name]" >&2
  exit 2
}

exec "$(dirname "$0")/change-seat.sh" "$proj" "$name" --effort "$effort" --parent "$parent"
