#!/bin/bash
# 席の model / effort を変更する（同じ vendor の中で）。
# usage: change-seat.sh <project_dir> <member> [--model <model>] [--effort <effort>] [--parent <name>] [--reason <text>]
#
# **自然文の依頼を再解釈しない。** 依頼の意味・本人の意図・変更してよい局面を判断するのは親である AI で、
# この script が受け取るのは親が確定した target だけである（旧 change-effort.sh の
# 「本人→親の単独DMが `[effort変更依頼] <level>` と完全一致すること」という機械判定は廃止した。
# 明確な自然文の依頼を、同じ文面の再送を求めて拒否していたため）。
# この script が持つのは、親には出来ない外部境界の仕事だけである:
#   現在の素性の取得 / target の live catalog 検証 / 同値no-op / busy保護 / 再起動 /
#   metadata の読み返し / room 履歴 / 失敗時の旧設定への1回だけの明示rollback。
#
# 会話contextは引き継がない。作業状態はroomログ・工程正本・gitから再着任で回収する。
# vendor 変更は対象外（vendor を跨ぐと席の入口・MCP配線ごと別物になる）。
set -eu

# token値はこの制御processや再起動する席へ継承しない。launch後のroom記録も席別file経由で行う。
unset PEERTABLE_POST_TOKEN
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$(dirname "$0")/seat-credential.mjs}"

proj="${1:-}"; name="${2:-}"
shift 2 2>/dev/null || true
opt_model=""; opt_effort=""; parent="bell"; reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model)  opt_model="${2:-}";  shift 2 || true ;;
    --effort) opt_effort="${2:-}"; shift 2 || true ;;
    --parent) parent="${2:-}";     shift 2 || true ;;
    --reason) reason="${2:-}";     shift 2 || true ;;
    --vendor)
      echo "SEAT_CHANGE_VENDOR_UNSUPPORTED: vendor 変更は対象外。席を畳んで立て直す" >&2; exit 2 ;;
    *) echo "SEAT_CHANGE_ARGS_INVALID: 不明な引数 $1" >&2; exit 2 ;;
  esac
done
[ -n "$proj" ] && [ -n "$name" ] || {
  echo "SEAT_CHANGE_ARGS_INVALID: usage: change-seat.sh <project_dir> <member> [--model <model>] [--effort <effort>] [--parent <name>] [--reason <text>]" >&2
  exit 2
}
[ -n "$opt_model" ] || [ -n "$opt_effort" ] || {
  echo "SEAT_CHANGE_ARGS_INVALID: --model と --effort の少なくとも一方が要る" >&2; exit 2
}
case "$name:$parent" in
  *[!A-Za-z0-9._:-]*) echo "SEAT_CHANGE_ARGS_INVALID: member/parent名に使えない文字がある" >&2; exit 2 ;;
esac

state="$proj/.team/setup-state.json"
[ -f "$state" ] || { echo "SEAT_CHANGE_STATE_MISSING: $state" >&2; exit 1; }
read -r room url <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'])")
EOF

members=$(curl -sf "$url/api/$room/members") || {
  echo "SEAT_CHANGE_ROOM_UNREACHABLE: membersを読めない" >&2; exit 1;
}
meta=$(printf '%s' "$members" | python3 -c '
import json,sys
name=sys.argv[1]
member=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),None)
if not member or member.get("vendor") not in ("claude","codex") or not member.get("model"):
    raise SystemExit(1)
print("\t".join((member["vendor"],member["model"],member.get("effort") or "")))
' "$name") || { echo "SEAT_CHANGE_MEMBER_METADATA_MISSING: ${name} のvendor/modelが要る" >&2; exit 1; }
IFS=$'\t' read -r vendor old_model old_effort <<EOF
$meta
EOF

model="${opt_model:-$old_model}"
effort="${opt_effort:-$old_effort}"
# effort を持たない席（CLI 既定で走っている席）へ model だけ渡すと、再起動で effort が確定してしまう。
# 既定値をここへ埋めない——launch-seat.sh と同じく「席を立てる時に決める」（オーナー裁定）。
[ -n "$effort" ] || {
  echo "SEAT_CHANGE_EFFORT_UNKNOWN: ${name} の現在effortがmetadataに無い。--effort を明示する" >&2; exit 1
}

if [ "$model" = "$old_model" ] && [ "$effort" = "$old_effort" ]; then
  echo "SEAT_CHANGE_NOOP: ${name} は既に model=${model} / effort=${effort}（再起動しない）"
  exit 0
fi

# target の検証は live 面だけを使い、古くなる hardcode を足さない。
case "$vendor" in
  claude)
    # Claude には非破壊で引ける model catalog が無い（`--help` の alias 例は catalog ではなく、
    # 実際 2026-08-11 に `fable` は例に載ったまま live では unavailable だった）。
    # よって **model 名は事前検証しない**——実 CLI の起動失敗と rollback が正式な検証境界である。
    # effort は `--help` が live に列挙するので、そこから取る。
    help_text=$(claude --help 2>/dev/null) || {
      echo "SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE: claude --help を読めない" >&2; exit 1;
    }
    levels=$(printf '%s' "$help_text" | python3 -c '
import re,sys
text=sys.stdin.read()
i=text.find("--effort")
m=re.search(r"\(([a-z0-9, ]+)\)", text[i:i+400]) if i>=0 else None
if not m: raise SystemExit(1)
print(" ".join(x.strip() for x in m.group(1).split(",") if x.strip()))
') || {
      echo "SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE: claude --help が effort の水準を列挙しない" >&2; exit 1;
    }
    case " $levels " in
      *" $effort "*) ;;
      *) echo "SEAT_CHANGE_EFFORT_UNSUPPORTED: claude は effort=${effort} を提供していない（live: ${levels}）" >&2; exit 1 ;;
    esac
    ;;
  codex)
    catalog=$(codex debug models 2>/dev/null) || {
      echo "SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE: codex debug models" >&2; exit 1;
    }
    verdict=$(printf '%s' "$catalog" | python3 -c '
import json,sys
model,effort=sys.argv[1:3]
entry=next((m for m in json.load(sys.stdin).get("models",[]) if m.get("slug")==model),None)
if entry is None:
    print("model"); raise SystemExit(0)
levels=[x.get("effort") for x in entry.get("supported_reasoning_levels",[])]
print("ok" if effort in levels else "effort")
' "$model" "$effort") || {
      echo "SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE: codex debug models の出力を読めない" >&2; exit 1;
    }
    case "$verdict" in
      model)  echo "SEAT_CHANGE_MODEL_UNSUPPORTED: codex catalog に model=${model} が無い" >&2; exit 1 ;;
      effort) echo "SEAT_CHANGE_EFFORT_UNSUPPORTED: codex/${model} は effort=${effort} をcatalogで提供していない" >&2; exit 1 ;;
    esac
    ;;
esac

sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR:-/tmp/}claude-tmux-sockets/claude.sock}"
sess="peer-$name"
tmux -S "$sock" has-session -t "$sess" 2>/dev/null || {
  echo "SEAT_CHANGE_SEAT_MISSING: ${sess}" >&2; exit 1;
}
screen=$(tmux -S "$sock" capture-pane -t "$sess" -p -S -25 2>/dev/null) || {
  echo "SEAT_CHANGE_SEAT_UNREADABLE: $sess" >&2; exit 1;
}
# busy の判定文字列は seat-status-bridge と同じ（Claude のステータス行にも Codex の `Working (…)` にも出る）
case "$screen" in
  *"esc to interrupt"*) echo "SEAT_CHANGE_SEAT_BUSY: ${sess} は処理中。本人がidleになってから再実行する" >&2; exit 1 ;;
esac

changes=""
[ "$model" = "$old_model" ] || changes="model ${old_model} → ${model}"
if [ "$effort" != "$old_effort" ]; then
  [ -z "$changes" ] || changes="$changes / "
  changes="${changes}effort ${old_effort:-default} → ${effort}"
fi

launch="$(dirname "$0")/launch-seat.sh"
brief="席設定が変更され（${changes}）、席を再起動しました。.team/roles/member.mdと工程正本・roomログから再着任し、進行中taskを続けてください。"
if ! "$launch" "$proj" "$name" "$model" "$vendor" "$effort" "$brief"; then
  echo "SEAT_CHANGE_RESTART_FAILED: ${changes}。旧設定（model=${old_model} / effort=${old_effort:-default}）へrollbackする" >&2
  rollback_brief="席設定の変更に失敗して旧設定へrollbackしました。.team/roles/member.mdと工程正本・roomログから再着任してください。"
  if "$launch" "$proj" "$name" "$old_model" "$vendor" "$old_effort" "$rollback_brief"; then
    echo "SEAT_CHANGE_ROLLED_BACK: ${name} は model=${old_model} / effort=${old_effort:-default} で再着席" >&2
  else
    echo "SEAT_CHANGE_ROLLBACK_FAILED: ${name} の席を手動で復旧する必要がある" >&2
  fi
  exit 1
fi

members_after=$(curl -sf "$url/api/$room/members") || {
  echo "SEAT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、membersを読めない" >&2; exit 1;
}
if ! printf '%s' "$members_after" | python3 -c '
import json,sys
name,model,effort=sys.argv[1:4]
m=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),{})
raise SystemExit(0 if m.get("model")==model and m.get("effort")==effort else 1)
' "$name" "$model" "$effort"; then
  echo "SEAT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、member metadataが model=${model} / effort=${effort} でない" >&2
  exit 1
fi

body="[席設定変更] ${parent} が ${name} の ${changes} に変更（席を再起動）"
[ -z "$reason" ] || body="${body}。理由: ${reason}"
history=$(python3 -c 'import json,sys;print(json.dumps({"from":sys.argv[1],"to":sys.argv[2],"body":sys.argv[3]},ensure_ascii=False))' "$parent" "$name" "$body")
credential_file=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" path "$proj" "$room" "$name")
if ! env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
  "$url/api/$room/messages" "$history" >/dev/null; then
  echo "SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} は ${changes} で再着席済み、room履歴の記録に失敗" >&2
  exit 1
fi

echo "SEAT_CHANGE_OK: ${name} ${changes}（parent=${parent}）"
