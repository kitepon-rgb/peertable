#!/bin/bash
# 明示DMの本人要請を確認し、親が席を新effortで再起動する。
# usage: change-effort.sh <project_dir> <member> <effort> [parent_name]
#
# 会話contextは引き継がない。作業状態はroomログ・工程正本・gitから再着任で回収する。
# busy席は止めず、起動失敗時は旧effortでの再起動を1回だけ明示rollbackする。
set -eu

proj="${1:-}"; name="${2:-}"; effort="${3:-}"; parent="${4:-bell}"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$effort" ] || {
  echo "EFFORT_CHANGE_ARGS_INVALID: usage: change-effort.sh <project_dir> <member> <effort> [parent_name]" >&2
  exit 2
}
case "$name:$parent" in
  *[!A-Za-z0-9._:-]*) echo "EFFORT_CHANGE_ARGS_INVALID: member/parent名に使えない文字がある" >&2; exit 2 ;;
esac

state="$proj/.team/setup-state.json"
[ -f "$state" ] || { echo "EFFORT_CHANGE_STATE_MISSING: $state" >&2; exit 1; }
read -r room url <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'])")
EOF

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi
[ -n "${PEERTABLE_POST_TOKEN:-}" ] || { echo "EFFORT_CHANGE_TOKEN_MISSING" >&2; exit 1; }

members=$(curl -sf "$url/api/$room/members") || {
  echo "EFFORT_CHANGE_ROOM_UNREACHABLE: membersを読めない" >&2; exit 1;
}
meta=$(printf '%s' "$members" | python3 -c '
import json,sys
name=sys.argv[1]
member=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),None)
if not member or member.get("vendor") not in ("claude","codex") or not member.get("model"):
    raise SystemExit(1)
print("\t".join((member["vendor"],member["model"],member.get("effort") or "")))
' "$name") || { echo "EFFORT_CHANGE_MEMBER_METADATA_MISSING: ${name} のvendor/modelが要る" >&2; exit 1; }
IFS=$'\t' read -r vendor model old_effort <<EOF
$meta
EOF

case "$vendor" in
  claude)
    case "$effort" in low|medium|high|xhigh|max) ;; *)
      echo "EFFORT_CHANGE_UNSUPPORTED: claude/${model} は low|medium|high|xhigh|max" >&2; exit 1 ;;
    esac
    ;;
  codex)
    catalog=$(codex debug models 2>/dev/null) || {
      echo "EFFORT_CHANGE_MODEL_CATALOG_UNAVAILABLE: codex debug models" >&2; exit 1;
    }
    if ! printf '%s' "$catalog" | python3 -c '
import json,sys
model,effort=sys.argv[1:3]
entry=next((m for m in json.load(sys.stdin).get("models",[]) if m.get("slug")==model),None)
levels=[] if entry is None else [x.get("effort") for x in entry.get("supported_reasoning_levels",[])]
raise SystemExit(0 if effort in levels else 1)
' "$model" "$effort"; then
      echo "EFFORT_CHANGE_UNSUPPORTED: codex/${model} は effort=${effort} をcatalogで提供していない" >&2
      exit 1
    fi
    ;;
esac

messages=$(curl -sf "$url/api/$room/messages") || {
  echo "EFFORT_CHANGE_ROOM_UNREACHABLE: messagesを読めない" >&2; exit 1;
}
request_seq=$(printf '%s' "$messages" | python3 -c '
import json,sys
name,parent,effort=sys.argv[1:4]
rows=json.load(sys.stdin).get("messages",[])
def addressed(row,target):
    return row.get("to")==target or target in row.get("to_names",[])
requests=[r for r in rows if r.get("from")==name and addressed(r,parent)
          and r.get("body")==f"[effort変更依頼] {effort}"]
if not requests: raise SystemExit(1)
req=max(requests,key=lambda r:r.get("seq",0))
marker="request #{}".format(req.get("seq",0))
completed=[r for r in rows if r.get("from")==parent and addressed(r,name)
           and str(r.get("body","")).startswith("[effort変更]")
           and marker in str(r.get("body",""))]
if completed and max(r.get("seq",0) for r in completed)>=req.get("seq",0): raise SystemExit(1)
print(req["seq"])
' "$name" "$parent" "$effort") || {
  echo "EFFORT_CHANGE_REQUEST_REQUIRED: ${name} → ${parent} の『[effort変更依頼] ${effort}』新着DMが要る" >&2
  exit 1
}

sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR:-/tmp/}claude-tmux-sockets/claude.sock}"
sess="peer-$name"
tmux -S "$sock" has-session -t "$sess" 2>/dev/null || {
  echo "EFFORT_CHANGE_SEAT_MISSING: ${sess}" >&2; exit 1;
}
screen=$(tmux -S "$sock" capture-pane -t "$sess" -p -S -25 2>/dev/null) || {
  echo "EFFORT_CHANGE_SEAT_UNREADABLE: $sess" >&2; exit 1;
}
case "$screen" in
  *"esc to interrupt"*) echo "EFFORT_CHANGE_SEAT_BUSY: ${sess} は処理中。本人がidleになってから再実行する" >&2; exit 1 ;;
esac

launch="$(dirname "$0")/launch-seat.sh"
brief="effortが${effort}へ変更され、席を再起動しました。.team/roles/member.mdと工程正本・roomログから再着任し、進行中taskを続けてください。"
if ! "$launch" "$proj" "$name" "$model" "$vendor" "$effort" "$brief"; then
  echo "EFFORT_CHANGE_RESTART_FAILED: effort=${effort}。旧effort=${old_effort:-default}へrollbackする" >&2
  rollback_brief="effort変更に失敗して旧設定へrollbackしました。.team/roles/member.mdと工程正本・roomログから再着任してください。"
  if "$launch" "$proj" "$name" "$model" "$vendor" "$old_effort" "$rollback_brief"; then
    echo "EFFORT_CHANGE_ROLLED_BACK: ${name} は旧effort=${old_effort:-default}で再着席" >&2
  else
    echo "EFFORT_CHANGE_ROLLBACK_FAILED: ${name} の席を手動で復旧する必要がある" >&2
  fi
  exit 1
fi

members_after=$(curl -sf "$url/api/$room/members") || {
  echo "EFFORT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、membersを読めない" >&2; exit 1;
}
if ! printf '%s' "$members_after" | python3 -c '
import json,sys
name,effort=sys.argv[1:3]
m=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),{})
raise SystemExit(0 if m.get("effort")==effort else 1)
' "$name" "$effort"; then
  echo "EFFORT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、member metadataがeffort=${effort}でない" >&2
  exit 1
fi

old_label="${old_effort:-default}"
history=$(python3 -c 'import json,sys;print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"body":f"[effort変更] {sys.argv[1]} が {sys.argv[2]} の effort を {sys.argv[3]} → {sys.argv[4]} に変更（席を再起動 / request #{sys.argv[5]}）"},ensure_ascii=False))' "$parent" "$name" "$old_label" "$effort" "$request_seq")
if ! curl -sf -o /dev/null -X POST "$url/api/$room/messages" \
  -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' -d "$history"; then
  echo "EFFORT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} はeffort=${effort}で再着席済み、room履歴の記録に失敗" >&2
  exit 1
fi

echo "EFFORT_CHANGE_OK: ${name} ${old_label} → ${effort}（request #${request_seq} / parent=${parent}）"
