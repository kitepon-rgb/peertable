#!/bin/bash
# 1席だけを通常退席させ、runtime credentialまで同じ境界で撤去する。
# usage: leave-seat.sh <project_dir> <member>
set -u

unset PEERTABLE_POST_TOKEN
proj="${1:-}"
name="${2:-}"
[ -n "$proj" ] && [ -n "$name" ] || {
  echo "SEAT_LEAVE_ARGS_INVALID: leave-seat.sh <project_dir> <member>" >&2
  exit 2
}
case "$name" in
  *[!A-Za-z0-9._:-]*) echo "SEAT_LEAVE_ARGS_INVALID: member名に使えない文字がある" >&2; exit 2 ;;
esac

script_dir=$(cd "$(dirname "$0")" && pwd -P)
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$script_dir/seat-credential.mjs}"
state="$proj/.team/setup-state.json"
[ -f "$state" ] || { echo "SEAT_LEAVE_STATE_MISSING: $state" >&2; exit 1; }
read -r room url <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'])")
EOF

credential_file=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" path "$proj" "$room" "$name") || exit 1
default_socket=$(node "$script_dir/tmux-socket.mjs" 2>/dev/null || true)
members=$(curl -sf "$url/api/$room/members" 2>/dev/null || true)
read -r member_socket target <<EOF
$(python3 - "$name" "$default_socket" "$members" <<'PY'
import json, sys
name, default_socket, raw = sys.argv[1:4]
try:
    member = next((x for x in json.loads(raw).get('members', []) if x.get('name') == name), {})
except Exception:
    member = {}
observe = member.get('observe') or {}
print(observe.get('tmux_socket') or default_socket, observe.get('tmux_target') or f'peer-{name}')
PY
)
EOF

failed=0
if [ -n "$member_socket" ] && tmux -S "$member_socket" has-session -t "$target" 2>/dev/null; then
  if ! tmux -S "$member_socket" kill-session -t "$target"; then
    echo "SEAT_LEAVE_SESSION_FAILED: $target" >&2
    failed=1
  elif tmux -S "$member_socket" has-session -t "$target" 2>/dev/null; then
    echo "SEAT_LEAVE_SESSION_FAILED: $target が撤去後も残っている" >&2
    failed=1
  fi
elif [ -n "$member_socket" ] && tmux -S "$member_socket" list-sessions >/dev/null 2>&1; then
  : # serverへ到達でき、対象sessionが無い
elif [ -n "$member_socket" ] && [ -S "$member_socket" ]; then
  echo "SEAT_LEAVE_SESSION_UNREADABLE: $member_socket" >&2
  failed=1
fi

# live clientを止めたと確認できない時は、member/identity/credentialを先に消して
# 「退席済み」に見せない。観測面を残したままtyped failureで止める。
[ "$failed" -eq 0 ] || exit 1

encoded_name=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$name")
if ! env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" DELETE \
  "$url/api/$room/members/$encoded_name" >/dev/null; then
  echo "SEAT_LEAVE_MEMBER_FAILED: $name" >&2
  failed=1
fi

if ! rm -f "$proj/.team/seats/$name.json"; then
  echo "SEAT_LEAVE_IDENTITY_FAILED: $name" >&2
  failed=1
fi
if ! env -u PEERTABLE_POST_TOKEN node "$credential_helper" remove "$proj" "$credential_file"; then
  echo "SEAT_LEAVE_CREDENTIAL_FAILED: $name" >&2
  failed=1
fi

[ "$failed" -eq 0 ] || exit 1
echo "SEAT_LEAVE_OK: ${name}（session / room member / seat identity / credential を撤去）"
