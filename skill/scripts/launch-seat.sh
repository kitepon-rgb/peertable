#!/bin/bash
# 席を1つ立てる（tmux 作成 → env 注入 → エージェント起動 → 既知ダイアログ通過 → 着席確認）。
# usage: launch-seat.sh <project_dir> <name> --roles <role>[,<role>...] [--mission <text>] [--model <slug>] [--effort <effort>] [--vendor <vendor>] [brief]
#   --roles: 必須。02_models の公式役割。位置引数に公式役割を置いてもよい
#   --model: 任意。省略時は先頭役割の着席可能な1位。指定時は表外でも通す
#   brief: 着席が成立したら送る着任指示（省略時は送らない）
set -e
usage() {
  echo "usage: launch-seat.sh <project_dir> <name> --roles <role>[,<role>...] [--mission <text>] [--model <slug>] [--effort <effort>] [--vendor <vendor>] [brief]" >&2
}
proj="$1"; name="$2"
[ -n "$proj" ] && [ -n "$name" ] || { usage; exit 1; }
shift 2
brief=""
roles=""; mission=""
opt_model=""; opt_vendor=""; opt_effort=""
while [ $# -gt 0 ]; do
  case "$1" in
    --roles) roles="${2:-}"; shift 2 ;;
    --mission) mission="${2:-}"; shift 2 ;;
    --model) opt_model="${2:-}"; shift 2 ;;
    --vendor) opt_vendor="${2:-}"; shift 2 ;;
    --effort) opt_effort="${2:-}"; shift 2 ;;
    --*) echo "SEAT_LAUNCH_ARGS_INVALID: 不明な引数 $1" >&2; usage; exit 1 ;;
    *)
      if [ -z "$roles" ]; then roles="$1"; shift
      elif [ -z "$brief" ]; then brief="$1"; shift
      else echo "SEAT_LAUNCH_ARGS_INVALID: 余分な引数 $1" >&2; usage; exit 1
      fi
      ;;
  esac
done
[ -n "$roles" ] || { usage; exit 1; }

if [ -n "${PEERTABLE_MEMBER:-}" ]; then
  echo "SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN: PEERTABLE_MEMBER=${PEERTABLE_MEMBER} を継承した呼出元からの席起動を拒否" >&2
  exit 1
fi

# 呼出元が古い手順でtokenをexportしていても、preflight・tmux・model CLIへ継承しない。
# 値の解決はcredential helperだけが設定fileから行う。env/argvへのfallbackは持たない。
unset PEERTABLE_POST_TOKEN
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$(dirname "$0")/seat-credential.mjs}"
room_mcp_helper="${PEERTABLE_ROOM_MCP_HELPER:-$(dirname "$0")/ensure-room-mcp.mjs}"
codex_room_mcp_helper="${PEERTABLE_CODEX_ROOM_MCP_HELPER:-$(dirname "$0")/ensure-codex-room-mcp.mjs}"
aiterm_launch_helper="${PEERTABLE_AITERM_LAUNCH_HELPER:-$(dirname "$0")/aiterm-launch.mjs}"
placement_helper="${PEERTABLE_PLACEMENT_HELPER:-$(dirname "$0")/resolve-seat-placement.mjs}"
# shellcheck disable=SC1091
. "$(dirname "$0")/tmux-at.bash"
peertable_repo=$(cd "$(dirname "$0")/../.." && pwd -P)
peertable_client="$peertable_repo/room/client.mjs"
credential_file=""
credential_persist=false
aiterm_session_id=""

placement_argv=(--roles "$roles")
[ -n "$opt_model" ] && placement_argv+=(--model "$opt_model")
[ -n "$opt_effort" ] && placement_argv+=(--effort "$opt_effort")
[ -n "$opt_vendor" ] && placement_argv+=(--vendor "$opt_vendor")
placement=$(node "$placement_helper" "${placement_argv[@]}") || exit "$?"
IFS=$'\t' read -r model vendor effort role <<EOF
$(python3 -c 'import json,sys
p=json.load(sys.stdin)
s=p.get("settings") or {}
roles=",".join(p.get("roles") or [])
print("\t".join((s.get("model") or "", s.get("vendor") or "", s.get("effort") or "", roles)))' <<<"$placement")
EOF
echo "SEAT_PLACEMENT: ${role} → ${vendor} / ${model}${effort:+ / $effort}"
python3 -c 'import json,sys
p=json.load(sys.stdin)
for item in p.get("dropped") or []:
    print("SEAT_PLACEMENT_DROPPED: rank %s %s %s" % (item.get("rank"), item.get("reason"), item.get("cell") or ""), file=sys.stderr)
' <<<"$placement" || true
case "$vendor" in
  claude|codex|grok) ;;
  *) echo "SEAT_LAUNCH_VENDOR_UNSUPPORTED: vendor=${vendor}" >&2; exit 1 ;;
esac
if [ "$vendor" = "claude" ] && [ -n "$effort" ]; then
  case "$effort" in
    low|medium|high|xhigh|max) ;;
    *) echo "unknown effort: ${effort}（claude は low|medium|high|xhigh|max）" >&2; exit 1 ;;
  esac
fi

# brief は tmux のコマンド引数へ直接載せない。長さを着席前に検証してから一時 file へ置き、
# tmux の buffer 経由で貼る。入力を受理できない時は model preflight・tmux・member 登録を
# 一つも行わず、何が拒否されたかを機械的に読める形で返す。
brief_file=""
brief_max_bytes=65536
brief_completed=false
brief_dispatched=false
seat_created=false
rollback_done=false
# ready を観測できないだけの不確実性は、投入後の真失敗と分ける。これは
# Aiterm から手動 dispatch できる空席として残し、席数へ成功着任とは数えない。
brief_not_ready=false
sock=""
sess=""
url=""
room=""
seat_file="$proj/.team/seats/$name.json"
cleanup_brief() {
  if [ -n "$brief_file" ]; then rm -f "$brief_file"; fi
  return 0
}
# brief を受け付けて送信した後に turn が始まらなかった場合は、作りかけの席を残さない。
# tmux を先に落とし、client が再登録しない状態にしてから room member を解除する。
# DELETE は idempotent だが、一覧の読み返しまで通らなければ rollback 成功とは言わない。
rollback_brief() {
  local original_rc="${1:-1}"
  local rollback_failed=0
  local encoded_name member_code listing

  if [ -n "$sess" ] && [ "$seat_created" = true ]; then
    if tmux_at has-session -t "$sess" 2>/dev/null; then
      if ! tmux_at kill-session -t "$sess" 2>/dev/null; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: tmux session を停止できない: ${sess}" >&2
      elif tmux_at has-session -t "$sess" 2>/dev/null; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: tmux session が停止後も残っている: ${sess}" >&2
      fi
    elif tmux_at list-sessions >/dev/null 2>&1; then
      : # serverへ到達でき、対象sessionが無い
    else
      rollback_failed=1
      echo "LAUNCH_BRIEF_ROLLBACK_FAILED: tmux session を観測できない: ${sess}" >&2
    fi
  fi

  if [ "$rollback_failed" -ne 0 ]; then
    # live clientを止めたと確認できない時は、member/identity/credentialを先に消して
    # rollback済みに見せない。credential cleanupはon_exitにもさせない。
    credential_persist=true
    return 1
  fi

  if [ -n "$seat_file" ] && [ -e "$seat_file" ]; then
    if ! rm -f "$seat_file"; then
      rollback_failed=1
      echo "LAUNCH_BRIEF_ROLLBACK_FAILED: seat identity を撤去できない: ${seat_file}" >&2
    fi
  fi

  if [ -n "$url" ] && [ -n "$room" ]; then
    if ! encoded_name=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$name"); then
      rollback_failed=1
      echo "LAUNCH_BRIEF_ROLLBACK_FAILED: member 名を URL 化できない: ${name}" >&2
    else
      if ! env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" DELETE \
        "$url/api/$room/members/$encoded_name" >/dev/null; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: room member を解除できない" >&2
      fi
      listing=$(curl -sf "$url/api/$room/members" || true)
      if ! printf '%s' "$listing" | python3 -c 'import json,sys; name=sys.argv[1]; members=json.load(sys.stdin).get("members",[]); raise SystemExit(0 if not any(m.get("name") == name for m in members) else 1)' "$name"; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: room member の解除を読み返せない: ${name}" >&2
      fi
    fi
  else
    rollback_failed=1
    echo "LAUNCH_BRIEF_ROLLBACK_FAILED: room の rollback 境界が未解決" >&2
  fi

  if [ "$rollback_failed" -ne 0 ]; then
    return 1
  fi
  echo "LAUNCH_BRIEF_ROLLED_BACK: ${sess}（tmux / room member / seat identity を撤去）" >&2
  return "$original_rc"
}

on_exit() {
  local exit_rc=$?
  local rollback_rc
  trap - EXIT
  cleanup_brief
  if [ "$seat_created" = true ] && [ "$brief_completed" != true ] && [ "$brief_not_ready" != true ] && [ "$rollback_done" != true ]; then
    rollback_done=true
    if rollback_brief "$exit_rc"; then
      :
    else
      rollback_rc=$?
      [ "$exit_rc" -eq 0 ] && exit_rc="$rollback_rc"
    fi
  fi
  if [ -n "$credential_file" ] && [ "$credential_persist" != true ]; then
    if ! env -u PEERTABLE_POST_TOKEN node "$credential_helper" remove "$proj" "$credential_file"; then
      echo "SEAT_CREDENTIAL_ROLLBACK_FAILED: ${credential_file}" >&2
      [ "$exit_rc" -eq 0 ] && exit_rc=1
    fi
  fi
  exit "$exit_rc"
}
trap on_exit EXIT
if [ -n "$brief" ] && [ "$brief_dispatched" != true ]; then
  brief_bytes=$(printf '%s' "$brief" | LC_ALL=C wc -c | tr -d '[:space:]')
  case "$brief_bytes" in
    ''|*[!0-9]*) echo "LAUNCH_BRIEF_INVALID: brief の byte 長を測定できない（席は立てない）" >&2; exit 2 ;;
  esac
  if [ "$brief_bytes" -gt "$brief_max_bytes" ]; then
    echo "LAUNCH_BRIEF_TOO_LONG: brief が ${brief_bytes} bytes（上限 ${brief_max_bytes} bytes・席は立てない）" >&2
    exit 2
  fi
  if ! brief_file=$(mktemp "${TMPDIR:-/tmp}/peertable-brief.XXXXXX"); then
    echo "LAUNCH_BRIEF_PREPARE_FAILED: brief の輸送 file を作れない（席は立てない）" >&2
    exit 2
  fi
  if ! printf '%s' "$brief" >"$brief_file"; then
    echo "LAUNCH_BRIEF_PREPARE_FAILED: brief を輸送 file へ書けない（席は立てない）" >&2
    exit 2
  fi
fi

# **画面の文字列は「model が使えること」を意味しない。** 2026-08-11 実測: fable-5 の席は
# Claude の channels バナーが出たので下の着席判定を通ったが、その後の入力は全て
# model unavailable で 0 秒失敗し、席は一度も仕事をできなかった（room [11]）。
# バナーは CLI が起動したことしか言わないので、**live に応答するかは非対話入口で先に測る**。
# 席を畳む前に測るのが要点である——ここで落ちれば、動いている席を殺さずに済む。
export PATH="${HOME}/.grok/bin:${PATH}"
preflight_dir="${TMPDIR:-/tmp}"
case "$vendor" in
  claude) preflight_cmd=(claude --model "$model" -p "ping") ;;
  codex)  preflight_cmd=(codex exec --model "$model" --skip-git-repo-check "ping") ;;
  grok)
    grok_bin=$(command -v grok || true)
    if [ -z "$grok_bin" ]; then
      echo "SEAT_GROK_CLI_MISSING: grok が PATH に無い（席は立てない）" >&2
      exit 1
    fi
    # 通常 GROK_HOME の config は booth 等 MCP を起動する。preflight がそれを待つと
    # 120 秒で空ログのまま死ぬ（2026-08-20）。live 席も同じ config を読むと
    # lattice MCP が数分固まる。認証だけ借りて MCP 無しの席専用 HOME を残す。
    grok_home="${proj}/.team/seats/${name}.grok-home"
    rm -rf "$grok_home"
    mkdir -p "$grok_home"
    if [ ! -f "${HOME}/.grok/auth.json" ]; then
      echo "SEAT_GROK_AUTH_MISSING: ${HOME}/.grok/auth.json が無い（席は立てない）" >&2
      exit 1
    fi
    cp "${HOME}/.grok/auth.json" "${grok_home}/auth.json"
    printf '%s\n' '[ui]' 'permission_mode = "always-approve"' >"${grok_home}/config.toml"
    echo "grok preflight: GROK_HOME=${grok_home} ${grok_bin} --model ${model} --reasoning-effort ${effort} -p ping"
    preflight_cmd=(env GROK_HOME="$grok_home" "$grok_bin" --model "$model" --reasoning-effort "$effort" -p "ping")
    ;;
  *) echo "unknown vendor: ${vendor}（claude / codex / grok）" >&2; exit 1 ;;
esac
preflight_log=$(mktemp "${TMPDIR:-/tmp}/peertable-preflight.XXXXXX")
( cd "$preflight_dir" && "${preflight_cmd[@]}" >"$preflight_log" 2>&1 </dev/null ) &
preflight_pid=$!
# 外部 CLI が黙って固まる場合に立卓ごと止めないための締切（外部境界なので上限を置く）。
preflight_deadline=$((SECONDS + 120))
preflight_rc=""
while [ $SECONDS -lt $preflight_deadline ]; do
  if ! kill -0 "$preflight_pid" 2>/dev/null; then
    # `set -e` の下では、失敗した子を素の `wait` で待つとそこで script ごと死ぬ。
    # 条件式として使い、rc を自分で受ける（＝失敗を握らず、メッセージを出して落とすため）
    if wait "$preflight_pid"; then preflight_rc=0; else preflight_rc=$?; fi
    break
  fi
  sleep 2
done
if [ -z "$preflight_rc" ]; then
  kill "$preflight_pid" 2>/dev/null || true
  echo "model preflight が 120 秒で返らない: ${vendor} / ${model}（席は立てない）" >&2
  echo "preflight log: ${preflight_log}" >&2
  cat "$preflight_log" >&2 || true
  [ -n "${grok_home:-}" ] && rm -rf "$grok_home"
  exit 1
fi
if [ "$preflight_rc" != 0 ]; then
  echo "model が live で使えない: ${vendor} / ${model}（preflight rc=${preflight_rc}・席は立てない）" >&2
  cat "$preflight_log" >&2 || true
  rm -f "$preflight_log"
  [ -n "${grok_home:-}" ] && rm -rf "$grok_home"
  exit 1
fi
rm -f "$preflight_log"

sock=$(node "$(dirname "$0")/tmux-socket.mjs")
sess="peer-$name"
state="$proj/.team/setup-state.json"
read -r room url mode plan <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'],d['mode'],d.get('plan_key') or '-')")
EOF
# setup が解決した CLI の実 path。**席が PATH の `lattice` へ逸れないため**に渡す
# （release 前の source tree では、PATH の install は pull 系 command を持たない）。
# 無い卓（旧 setup-state）では空になり、席は既定どおり `lattice` を使う。
lattice_cli=$(python3 -c "import json;print(json.load(open('$state')).get('lattice_cli') or '')")
if [ "$mode" = lattice ] && [ -z "$lattice_cli" ]; then
  lattice_cli="${LATTICE_CLI:-lattice}"
fi

mcp_ownership=$(python3 -c "import json;d=json.load(open('$state'));print('managed' if d.get('added_root_mcp', d.get('root_mcp_json_fallback', False)) else 'preexisting')")
if ! node "$room_mcp_helper" "$proj" "$peertable_repo" "$mcp_ownership"; then
  echo "SEAT_ROOM_MCP_INVALID: Aiterm席のroom clientをcurrent treeへ束縛できない（席は立てない）" >&2
  exit 1
fi
if ! credential_file=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" prepare "$proj" "$room" "$name"); then
  echo "SEAT_CREDENTIAL_PREPARE_FAILED: 席別credentialを用意できない（席は立てない）" >&2
  exit 1
fi

# 同名の古いroom memberが残っていると、Codexの新しいroom clientが一度も登録していなくても
# 下のready確認を通ってしまう。古いmemberを別席のまま黙って消すのは危険なので、起動前に同名を
# conflictとして拒否し、明示的な退席後に再実行させる。一覧を読めない時も着席前に止める。
stale_members=$(curl -sf "$url/api/$room/members" || true)
stale_member_rc=0
python3 - "$name" "$stale_members" <<'PY' || stale_member_rc=$?
import json
import sys
try:
    members = json.loads(sys.argv[2])['members']
except Exception:
    raise SystemExit(2)
raise SystemExit(0 if any(member.get('name') == sys.argv[1] for member in members) else 1)
PY
case "$stale_member_rc" in
  1) : ;; # 同名memberなし。DELETEを発行せず、そのまま新席を起こす
  0)
    echo "SEAT_ROOM_MEMBER_RELAUNCH: 同名room memberが残っているので畳んでから起こす: ${name}" >&2
    if ! env -u PEERTABLE_POST_TOKEN "$(dirname "$0")/leave-seat.sh" "$proj" "$name"; then
      echo "SEAT_ROOM_MEMBER_RELAUNCH_FAILED: 同名席を畳めない: ${name}" >&2
      exit 1
    fi
    ;;
  *)
    echo "SEAT_ROOM_MEMBER_STATE_UNREADABLE: room member一覧を読み取れない（席は立てない）" >&2
    exit 1
    ;;
esac

# leave-seat が席専用 GROK_HOME を消す。同名再着席では preflight 後に空になるので、
# live 起動の直前に auth と ui だけを書き直す（user booth MCP は載せない）。
if [ "$vendor" = grok ]; then
  mkdir -p "$grok_home"
  if [ ! -f "${HOME}/.grok/auth.json" ]; then
    echo "SEAT_GROK_AUTH_MISSING: ${HOME}/.grok/auth.json が無い（席は立てない）" >&2
    exit 1
  fi
  cp "${HOME}/.grok/auth.json" "${grok_home}/auth.json"
  chmod 600 "${grok_home}/auth.json" 2>/dev/null || true
  printf '%s\n' '[ui]' 'permission_mode = "always-approve"' >"${grok_home}/config.toml"
fi

# 前の卓の残骸を回収してから、Aiterm の公開 agent launcher を唯一の席起動経路として呼ぶ。
# direct CLI launch へ戻るfallbackは置かない。Aiterm が作る同名PTYと launch receipt が、
# 以後の `pty_read` / `agent_configure` / room metadata を同じsessionへ束縛する。
tmux_at kill-session -t "$sess" 2>/dev/null || true
rm -f "$proj/.team/seats/$name.json"

launch_env=(
  "PEERTABLE_URL=$url"
  "PEERTABLE_ROOM=$room"
  "PEERTABLE_MEMBER=$name"
  "PEERTABLE_CREDENTIAL_FILE=$credential_file"
  "PEERTABLE_VENDOR=$vendor"
  "PEERTABLE_MODEL=$model"
  "PEERTABLE_EFFORT=$effort"
  "PEERTABLE_ROLE=$role"
  "PEERTABLE_ROLES=$role"
  "PEERTABLE_MISSION=$mission"
  "PEERTABLE_TMUX_SOCKET=$sock"
)
if [ "$mode" = "lattice" ]; then
  launch_env+=(
    "PEERTABLE_PLAN=$plan"
    "LATTICE_TODO_ACTOR_HOST=${LATTICE_TODO_ACTOR_HOST:-$(hostname | tr -d '\r')}"
    "LATTICE_TODO_ACTOR_SESSION=$name"
    "LATTICE_TODO_ACTOR_AGENT=$name"
  )
  [ -n "$lattice_cli" ] && launch_env+=("LATTICE_CLI=$lattice_cli")
fi
if [ "$vendor" = grok ]; then
  # 実測 2026-08-21: auth の coding_data_retention_opt_out だけでは
  # `Help improve Grok [Opt out] [Opt in]` バナーが残る。席が死んだように見える。
  launch_env+=("GROK_HOME=$grok_home")
  launch_env+=("GROK_PRIVACY_NOTICE_ROLLOUT=0")
fi
if [ "$vendor" = codex ]; then
  codex_home="${proj}/.team/seats/${name}.codex"
  mkdir -p "$codex_home"
  if [ -f "${HOME}/.codex/auth.json" ]; then
    cp "${HOME}/.codex/auth.json" "${codex_home}/auth.json"
    chmod 600 "${codex_home}/auth.json" 2>/dev/null || true
  fi
  launch_env+=("CODEX_HOME=$codex_home")
fi
if [ "$vendor" = codex ] \
  && ! env -u PEERTABLE_POST_TOKEN "${launch_env[@]}" node "$codex_room_mcp_helper" ensure "$proj" "$peertable_repo"; then
  echo "SEAT_CODEX_ROOM_MCP_INVALID: Codexのproject設定へseat固有room clientを装備できない（席は立てない）" >&2
  exit 1
fi
# Aiterm launcherはsession作成後にtyped failureを返すことがある。ここから先は同名memberが
# 無いことを確認済みなので、launch試行が作ったtmux/memberをon_exitの対象として先に所有する。
seat_created=true
launch_receipt=$(env -u PEERTABLE_POST_TOKEN "${launch_env[@]}" node "$aiterm_launch_helper" "$sess" "$vendor" "$model" "$effort" "$proj" "$brief") || {
  echo "SEAT_AITERM_LAUNCH_FAILED: ${name} をAiterm公開launcherで起動できない（direct CLI fallbackなし）" >&2
  exit 1
}
if ! python3 - "$launch_receipt" "$sess" <<'PY'
import json, sys
try:
    receipt = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if receipt.get('schema') == 'aiterm.agent-launch-result.v1' and receipt.get('session_id') == sys.argv[2] else 1)
PY
then
  echo "SEAT_AITERM_LAUNCH_RECEIPT_INVALID: ${name} のsession_idを確定できない" >&2
  exit 1
fi
aiterm_session_id="$sess"
brief_dispatched=true
seat_tmux=$(tmux_at display-message -p -t "$sess" '#{socket_path}')

# Aiterm管理席の process 起動は公開launch receiptで確定している。旧direct CLI launch向けの
# ヘッダ/trust dialog待機をここへ重ねると、brief turnでヘッダが画面外へ流れた正常席をrollbackする。
# 必須room MCPの成立は、次の member登録readbackだけで判定する。
echo "launched: ${sess}（${vendor} / ${model}${effort:+ / $effort} / room=${room} / mode=${mode}）"

# CodexのヘッダはCLIが起動した証拠であって、必須room MCPが初期化された証拠ではない。
# 無関係MCPのwarningが画面へ出ても、room clientがmember登録まで到達した席だけを着席として扱う。
# 登録が無ければ「着席済み」と丸めず、on_exitのrollbackへ渡す。
# brief を launch prompt に載せると初手ターンが MCP 初期化と重なり、30秒では
# member 登録前に rollback する（2026-08-20 ひなた再着席）。
room_ready_deadline=$((SECONDS + 90))
room_ready=false
grok_trust_accepted=false
mcp_consent_accepted=false
codex_hooks_accepted=false
codex_update_accepted=false
codex_trust_accepted=false
while [ $SECONDS -lt "$room_ready_deadline" ]; do
  # Grok Build は初めて開く作業treeで、room MCPを初期化する前にworkspace trustを尋ねる。
  # Peertableが正式に着席させるtreeなので、この既知文言だけを一度通す。未知の確認画面を
  # 汎用的に承認するfallbackにはしない。承認後のMCP初期化時間は改めて30秒確保する。
  if [ "$vendor" = codex ]; then
    codex_screen=$(tmux_at capture-pane -t "$sess" -p 2>/dev/null || true)
    if [ "$codex_update_accepted" != true ]; then
      case "$codex_screen" in
        *"Update now"*)
          if tmux_at send-keys -t "$sess" Down && tmux_at send-keys -t "$sess" Enter; then
            codex_update_accepted=true
            room_ready_deadline=$((SECONDS + 90))
            echo "codex update prompt: skipped"
          fi
          ;;
      esac
    fi
    if [ "$codex_hooks_accepted" != true ]; then
      case "$codex_screen" in
        *"Hooks need review"*)
          if tmux_at send-keys -t "$sess" Down && tmux_at send-keys -t "$sess" Enter; then
            codex_hooks_accepted=true
            room_ready_deadline=$((SECONDS + 90))
            echo "codex hooks prompt: trust all"
          fi
          ;;
      esac
    fi
    if [ "$codex_trust_accepted" != true ]; then
      case "$codex_screen" in
        *"Yes, continue"*)
          if tmux_at send-keys -t "$sess" Enter; then
            codex_trust_accepted=true
            room_ready_deadline=$((SECONDS + 90))
            echo "codex directory trust: accepted"
          fi
          ;;
      esac
    fi
  fi
  if [ "$vendor" = grok ] && [ "$grok_trust_accepted" != true ]; then
    grok_screen=$(tmux_at capture-pane -t "$sess" -p 2>/dev/null || true)
    case "$grok_screen" in
      *"Do you trust the contents of this directory?"*)
        if ! tmux_at send-keys -t "$sess" y; then
          echo "SEAT_GROK_TRUST_FAILED: workspace trustへ応答できない" >&2
          exit 1
        fi
        grok_trust_accepted=true
        room_ready_deadline=$((SECONDS + 90))
        echo "grok workspace trust: accepted"
        ;;
    esac
  fi
  # aiterm claude_agent は --dangerously-skip-permissions を付けない。project の room MCP
  # 同意が member 登録より前に出る。選択肢2（this and all future）だけを通す。
  if [ "$vendor" = claude ] && [ "$mcp_consent_accepted" != true ]; then
    claude_screen=$(tmux_at capture-pane -t "$sess" -p 2>/dev/null || true)
    case "$claude_screen" in
      *"New MCP server found in this project: room"*)
        if ! tmux_at send-keys -t "$sess" Down || ! tmux_at send-keys -t "$sess" Enter; then
          echo "SEAT_CLAUDE_MCP_CONSENT_FAILED: room MCP 同意へ応答できない" >&2
          exit 1
        fi
        mcp_consent_accepted=true
        room_ready_deadline=$((SECONDS + 90))
        echo "claude room MCP consent: accepted"
        ;;
    esac
  fi
  room_members=$(curl -sf "$url/api/$room/members" 2>/dev/null || true)
  if printf '%s' "$room_members" | python3 -c 'import json,sys; name=sys.argv[1]; members=json.load(sys.stdin).get("members",[]); raise SystemExit(0 if any(m.get("name") == name for m in members) else 1)' "$name"; then
    room_ready=true
    break
  fi
  sleep 1
done
if [ "$room_ready" != true ]; then
  echo "SEAT_ROOM_MCP_NOT_READY: room member登録を観測できない（無関係MCP warningとroom不成立を分離。席をrollbackする）" >&2
  tmux_at capture-pane -t "$sess" -p >"$proj/.team/${name}-pane-on-fail.txt" 2>/dev/null || true
  echo "pane saved: $proj/.team/${name}-pane-on-fail.txt" >&2
  exit 1
fi
echo "room ready: ${room}/${name}"
if [ "$brief_dispatched" = true ]; then
  brief_completed=true
  echo "briefed: ${sess}（Aiterm launch prompt）"
fi

if [ -n "$brief" ] && [ "$brief_dispatched" != true ]; then
  # Codex はヘッダを描いた後も MCP 初期化を続ける。Aiterm の ready 契約に合わせ、
  # 同じ可視 pane 内に入力候補行とモデルフッタがある構造を連続して観測する。
  # hook / MCP warning の更新で画面全体が変わっても、入力欄周辺が ready なら通す。
  brief_ready_deadline=$((SECONDS + 90))
  brief_ready_streak=0
  brief_ready=false
  while [ $SECONDS -lt "$brief_ready_deadline" ]; do
    brief_ready_screen=$(tmux_at capture-pane -t "$sess" -p 2>/dev/null || true)
    if [ "$vendor" != codex ] || printf '%s\n' "$brief_ready_screen" | python3 -c 'import sys; lines=sys.stdin.read().splitlines()[-24:]; has_prompt=any(line.strip() == "›" or line.lstrip().startswith("› ") for line in lines); has_footer=any("gpt-" in line and "·" in line for line in lines); raise SystemExit(0 if has_prompt and has_footer else 1)'; then
      brief_ready_streak=$((brief_ready_streak + 1))
      if [ "$brief_ready_streak" -ge 3 ]; then
        brief_ready=true
        break
      fi
    else
      brief_ready_streak=0
    fi
    sleep 1
  done
  if [ "$brief_ready" != true ]; then
    brief_not_ready=true
    echo "LAUNCH_BRIEF_NOT_READY: brief を受け付ける入力 prompt を観測できない（brief未投入・空席を保持。Aiterm手動dispatch対象）" >&2
  else
    # prompt の描画とキー入力受理の境界を分ける。Codex のTUIが入力欄を
    # mountした直後に paste と Enter を同一tickで受けると、Enterだけ落ちる。
    sleep 1

  brief_before=$(tmux_at capture-pane -S -1000 -t "$sess" -p 2>/dev/null || true)
  brief_buffer="peertable-brief-${name}-$$"
  if ! tmux_at load-buffer -b "$brief_buffer" "$brief_file"; then
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の tmux buffer 読み込みに失敗（席は着席済み）" >&2
    exit 1
  fi
  if ! tmux_at paste-buffer -b "$brief_buffer" -d -t "$sess"; then
    tmux_at delete-buffer -b "$brief_buffer" 2>/dev/null || true
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の tmux paste に失敗（席は着席済み）" >&2
    exit 1
  fi
  sleep 1
  if ! tmux_at send-keys -t "$sess" Enter; then
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の submit に失敗（席は着席済み）" >&2
    exit 1
  fi

  # 入力欄へ置けた事実だけでは着任成功としない。既存の席状態判定と同じ live marker が、
  # brief 投入後に画面へ現れたことを観測する。高速な fake/CLI の残像を拾わないよう、投入前の
  # 画面と異なることも同時に要求する。dispatch は Aiterm の手動送信と同じく、この1回だけ行う。
  brief_deadline=$((SECONDS + 30))
  brief_turn_started=false
  while [ $SECONDS -lt "$brief_deadline" ]; do
    brief_screen=$(tmux_at capture-pane -S -1000 -t "$sess" -p 2>/dev/null || true)
    case "$brief_screen" in
      *"esc to interrupt"*)
        if [ "$brief_screen" != "$brief_before" ]; then brief_turn_started=true; break; fi
        ;;
    esac
    sleep 1
  done
  if [ "$brief_turn_started" != true ]; then
    echo "LAUNCH_BRIEF_TURN_NOT_STARTED: brief 投入後の turn 開始を観測できない（席は着席済み）" >&2
    exit 1
  fi
  brief_completed=true
  echo "briefed: $sess"
fi
fi

# 席の素性を `.team/seats/<name>.json` へ置く。**席が自分の pid を知るための唯一の経路**である
# （Lattice の `run intake attach` は expected identity を要求し、pid を推定しない）。
# 着席の**後**に取る——起動途中の process を掴むと、ダイアログ通過で子が入れ替わりうる。
#
# 持たせるのは6欄だけで、**`lattice.pull_worker_attach_input.v1` の exact 集合から `schema` を
# 除いたもの**と一致する。席は読んで `schema` を被せるだけで attach input になる（変換不要）。
# **raw argv を持たせない**——秘密値はargvから除いたが、将来の引数も含めて複製しない。digest だけを持つ。
# この file が主張するのは「この pid はこの席だった」という**識別**であって、生死ではない。
# 生きているかは attach する側（Lattice）が lstart+argv の再観測で確かめる。
seat_pid=""
pane_pid=$(tmux_at list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1 || true)
seat_ident=""
if [ -n "$pane_pid" ] && [ -r "/proc/${pane_pid}/winpid" ]; then
  pane_pid=$(tr -d '[:space:]' < "/proc/${pane_pid}/winpid")
fi
if [ -n "$pane_pid" ]; then
  seat_ident=$(node "$(dirname "$0")/seat-identity.mjs" "$pane_pid") || seat_ident=""
fi
if [ -n "$seat_ident" ]; then
  seat_pid=$(python3 -c "import json,sys;print(json.load(sys.stdin)['pid'])" <<<"$seat_ident")
fi
if [ -z "$seat_pid" ]; then
  # 記録が無ければ席は attach できず、装置の介入は協調 hold のままになる。**黙らない。**
  echo "seat identity を記録できなかった: ${sess} の process group leader を1つに確定できない（席は着席済み）" >&2
else
  mkdir -p "$proj/.team/seats"
  # **`session` に tmux 名（`peer-<name>`）を入れてはいけない。** Lattice の attach は
  # `input.session === actor.session` を要求し（`runtime-pull-intake.mjs:674`）、actor session は
  # 上の env_line が入れる `LATTICE_TODO_ACTOR_SESSION=$name` である。tmux 識別子を混ぜると
  # attach が必ず `WORKER_ACTOR_MISMATCH` で拒否される（mio の監査で発覚・room [937]）。
  if ! python3 - "$proj/.team/seats/$name.json" "$name" "$name" "$seat_ident" <<'PY'
import hashlib, json, os, subprocess, sys, tempfile
out, name, session, ident_raw = sys.argv[1:5]
ident = json.loads(ident_raw)
pid = int(ident['pid'])
started = ident['started_identity']
argv = ident['argv']
if not started or not argv:
    sys.exit('pid の lstart/args を観測できない')
record = {
    'argv_digest': hashlib.sha256(argv.encode()).hexdigest(),
    'name': name,
    'pid': pid,
    'recorded_at': subprocess.run(['date', '-u', '+%Y-%m-%dT%H:%M:%S.000Z'],
                                  capture_output=True, text=True, check=True).stdout.strip(),
    'session': session,
    'started_identity': started,
}
# canonical JSON（key 昇順・空白なし）＋ 0600 ＋ 一時file→fsync→rename で原子的に置く。
# 着席直後に席が読むので、部分読取が起きない形にする。
body = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix='.seat-', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, out)
except BaseException:
    os.unlink(tmp)
    raise
PY
  then
    echo "seat identity を記録できなかった: ${sess}（席は着席済み・attach は協調 hold のままになる）" >&2
  fi
fi

# 席の素性（roles / settings / mission）を room へ渡す。一覧チップと席の名簿が同じ欄を見る。
tmux_ns=$(node "$(dirname "$0")/tmux-socket.mjs" --namespace)
# python stdout は Windows で cp932 になり 実装 が壊れる。Node が UTF-8 JSON を出す。
meta=$(node "$(dirname "$0")/seat-metadata.mjs" "$name" "$vendor" "$model" "$effort" "$sock" "$sess" "$role" "$mission" "$aiterm_session_id" "$tmux_ns")
if env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
    "$url/api/$room/members" "$meta" >/dev/null; then
  # **200 は保存の証拠にならない**。素性欄を知らない server も 200 {"ok":true} を返して黙って捨てる
  # （登録が `if (!members.has(name))` の no-op になる経路もある）。読み返して実際に載ったかを見る。
  # **パイプと heredoc を同じ stdin へ重ねない**。`curl | python3 - <<'PY'` は
  # 「プログラムを stdin から読む」と「データを stdin から読む」が衝突して、必ず失敗する
  # （そして try/except で包むと、失敗が「保存されていない」という**もっともらしい答え**に化ける。実測）
  listing=$(curl -sf "$url/api/$room/members" || true)
  stored=$(python3 - "$name" "$listing" <<'PY'
import json, sys
# 読み返しに失敗しても生の traceback を出さない。ここは「保存されたか」を見るだけの確認段で、
# 判定不能は「保存されていない」と同じ扱いでよい（席は既に着席している）
try:
    members = json.loads(sys.argv[2])['members']
except Exception:
    members = []
m = next((x for x in members if x.get('name') == sys.argv[1]), {})
print('yes' if m.get('model') and (m.get('roles') or m.get('role')) and m.get('aiterm_session_id') and m.get('observe', {}).get('tmux_target') else 'no')
PY
)
  if [ "$stored" = yes ]; then
    echo "metadata: ${vendor} / ${model}${effort:+ / $effort}${role:+ / $role}"
  else
    echo "metadata は保存されなかった: この room サーバーは素性欄を持たない版（席は着席済み・一覧に素性が出ないだけ）" >&2
  fi
else
  echo "metadata の登録に失敗した: 席は着席済みで、参加者一覧に素性が出ないだけ（room の到達性とトークンを確認）" >&2
fi

if PEERTABLE_CREDENTIAL_FILE="$credential_file" "$(dirname "$0")/ensure-bridge.sh" "$proj" seat-status; then
  echo "seat-status-bridge: 起動確認済み"
else
  echo "seat-status-bridge の起動確認に失敗した（席は着席済み）" >&2
fi

# Claude 席の新着は room client の notifications/claude/channel。TUI 配達は channels を持たない
# Codex / Grok 席だけ。Claude に立てると channel と二重配達になる。
if [ "$vendor" = codex ] || [ "$vendor" = grok ]; then
  if PEERTABLE_CREDENTIAL_FILE="$credential_file" "$(dirname "$0")/ensure-bridge.sh" "$proj" wakeup; then
    echo "wakeup-bridge: TUI配達 起動確認済み"
  else
    echo "SEAT_WAKEUP_BRIDGE_NOT_READY: Codex／Grok席の TUI 配達を準備できない" >&2
    exit 1
  fi
fi

if [ -z "$brief" ]; then brief_completed=true; fi
credential_persist=true
if [ "$brief_not_ready" = true ]; then
  # 空席の後段セットアップ（identity / metadata / bridge）まで済ませたうえで、
  # 呼び出し側にはready未確認を非0で返す。席はAiterm手動dispatchへ引き継ぐ。
  exit 1
fi
