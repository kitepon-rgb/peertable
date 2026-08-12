#!/bin/bash
# 席を1つ立てる（tmux 作成 → env 注入 → エージェント起動 → 既知ダイアログ通過 → 着席確認）。
# usage: launch-seat.sh <project_dir> <name> <model> <vendor> <effort> [brief]
#   vendor: claude / codex
#   effort: 必須。既定値をコードへ埋めない——席を立てる時に決める（オーナー裁定）
#   brief:  着席が成立したら送る着任指示（省略時は送らない）
#
# room 名・server URL・モード・plan key は <project>/.team/setup-state.json から読む（setup.sh の後に呼ぶ）。
# 書込トークンは helper が ~/.config/peertable.env から席別 0600 file へ移し、pathだけを席へ渡す。
# tmux は aiterm-mcp と同じソケットへ作るので、立てた席はそのまま pty_read / pty_send で読める。
set -e
proj="$1"; name="$2"; model="$3"; vendor="$4"; effort="$5"; brief="$6"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$model" ] && [ -n "$vendor" ] && [ -n "$effort" ] || {
  echo "usage: launch-seat.sh <project_dir> <name> <model> <vendor> <effort> [brief]" >&2; exit 1;
}
if [ "$vendor" = "claude" ]; then
  case "$effort" in
    low|medium|high|xhigh|max) ;;
    *) echo "unknown effort: ${effort}（claude は low|medium|high|xhigh|max）" >&2; exit 1 ;;
  esac
fi

if [ -n "${PEERTABLE_MEMBER:-}" ]; then
  echo "SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN: PEERTABLE_MEMBER=${PEERTABLE_MEMBER} を継承した呼出元からの席起動を拒否" >&2
  exit 1
fi

# 呼出元が古い手順でtokenをexportしていても、preflight・tmux・model CLIへ継承しない。
# 値の解決はcredential helperだけが設定fileから行う。env/argvへのfallbackは持たない。
unset PEERTABLE_POST_TOKEN
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$(dirname "$0")/seat-credential.mjs}"
room_mcp_helper="${PEERTABLE_ROOM_MCP_HELPER:-$(dirname "$0")/ensure-room-mcp.mjs}"
peertable_repo=$(cd "$(dirname "$0")/../.." && pwd -P)
peertable_client="$peertable_repo/room/client.mjs"
credential_file=""
credential_persist=false

# brief は tmux のコマンド引数へ直接載せない。長さを着席前に検証してから一時 file へ置き、
# tmux の buffer 経由で貼る。入力を受理できない時は model preflight・tmux・member 登録を
# 一つも行わず、何が拒否されたかを機械的に読める形で返す。
brief_file=""
brief_max_bytes=65536
brief_completed=false
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

  if [ -n "$sock" ] && [ -n "$sess" ] && [ "$seat_created" = true ]; then
    if tmux -S "$sock" has-session -t "$sess" 2>/dev/null; then
      if ! tmux -S "$sock" kill-session -t "$sess" 2>/dev/null; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: tmux session を停止できない: ${sess}" >&2
      elif tmux -S "$sock" has-session -t "$sess" 2>/dev/null; then
        rollback_failed=1
        echo "LAUNCH_BRIEF_ROLLBACK_FAILED: tmux session が停止後も残っている: ${sess}" >&2
      fi
    elif tmux -S "$sock" list-sessions >/dev/null 2>&1; then
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
if [ -n "$brief" ]; then
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
preflight_dir="${TMPDIR:-/tmp}"
case "$vendor" in
  claude) preflight_cmd=(claude --model "$model" -p "ping") ;;
  codex)  preflight_cmd=(codex exec --model "$model" --skip-git-repo-check "ping") ;;
  *) echo "unknown vendor: ${vendor}（claude / codex）" >&2; exit 1 ;;
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
  rm -f "$preflight_log"
  exit 1
fi
if [ "$preflight_rc" != 0 ]; then
  echo "model が live で使えない: ${vendor} / ${model}（preflight rc=${preflight_rc}・席は立てない）" >&2
  tail -5 "$preflight_log" >&2
  rm -f "$preflight_log"
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

if [ "$vendor" = claude ]; then
  mcp_ownership=$(python3 -c "import json;d=json.load(open('$state'));print('managed' if d.get('added_root_mcp', d.get('root_mcp_json_fallback', False)) else 'preexisting')")
  if ! node "$room_mcp_helper" "$proj" "$peertable_repo" "$mcp_ownership"; then
    echo "SEAT_ROOM_MCP_INVALID: Claude席のroom clientをcurrent treeへ束縛できない（席は立てない）" >&2
    exit 1
  fi
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
    echo "SEAT_ROOM_MEMBER_CONFLICT: 同名room memberが残っているため着席前に停止（明示的に退席してから再実行）" >&2
    exit 1
    ;;
  *)
    echo "SEAT_ROOM_MEMBER_STATE_UNREADABLE: room member一覧を読み取れない（席は立てない）" >&2
    exit 1
    ;;
esac

# 前の卓の残骸を回収してから立てる（同名セッションが残ると起動が黙って古い席に化ける）
tmux -S "$sock" kill-session -t "$sess" 2>/dev/null || true

# 素性記録（.team/seats/<name>.json）の掃除は**ここ**でやる。席を起こす経路は全席が必ず通るので、
# 死んだ記録がここで必ず消える（ADR 0157）。teardown や人が叩くコマンドに置くと、誰も叩かず溜まる。
# **消すのは同名の自分の分だけ**——`peer-*` を一括で消すと同じマシンの別卓を巻き込む。
rm -f "$proj/.team/seats/$name.json"
# tmux serverは起動時のglobal envを保持する。旧手順のtokenが残っていても、新sessionでは
# 明示的に空で上書きし、shell/model/clientへ再注入させない。
tmux -S "$sock" new-session -d -s "$sess" -x 200 -y 50 -c "$proj" -e PEERTABLE_POST_TOKEN=
seat_created=true
# Codex の closed env には launcher 自身でなく、今作った session の識別子を渡す。
# 自己申告の observe が別 pane を指すと、稼働状態・起床とも別席を誤操作する。
seat_tmux=$(tmux -S "$sock" display-message -p -t "$sess" '#{socket_path}')
seat_tmux_pane=$(tmux -S "$sock" display-message -p -t "$sess" '#{pane_id}')

# 素性は席の env にも入れる。client が**登録のたびに**載せるので、member の状態が失われても戻る
credential_shell=$(printf '%q' "$credential_file")
env_line="export PEERTABLE_URL=$url PEERTABLE_ROOM=$room PEERTABLE_MEMBER=$name PEERTABLE_CREDENTIAL_FILE=$credential_shell"
env_line="$env_line PEERTABLE_VENDOR=$vendor PEERTABLE_MODEL=$model"
[ -n "$effort" ] && env_line="$env_line PEERTABLE_EFFORT=$effort"
if [ "$mode" = "lattice" ]; then
  env_line="$env_line PEERTABLE_PLAN=$plan LATTICE_TODO_ACTOR_HOST=${LATTICE_TODO_ACTOR_HOST:-mac} LATTICE_TODO_ACTOR_SESSION=$name LATTICE_TODO_ACTOR_AGENT=$name"
  [ -n "$lattice_cli" ] && env_line="$env_line LATTICE_CLI=$lattice_cli"
fi
tmux -S "$sock" send-keys -t "$sess" "$env_line" Enter
sleep 1

case "$vendor" in
  claude)
    cmd="claude --model $model"
    [ -n "$effort" ] && cmd="$cmd --effort $effort"
    cmd="$cmd --dangerously-skip-permissions --dangerously-load-development-channels server:room"
    ;;
  codex)
    # Codex には channels が無いので room は stdio MCP として差す。
    # `[mcp_servers.X.env]` は closed mode（親 env を継がない）ので全変数を明示列挙する
    # （caveat `codex-cli-v0-130-0-mcp-servers-x-env-block-is-closed-mode-parent-env-not-inherited`）。
    envtbl="PATH=\\\"$PATH\\\",PEERTABLE_URL=\\\"$url\\\",PEERTABLE_ROOM=\\\"$room\\\",PEERTABLE_MEMBER=\\\"$name\\\",PEERTABLE_CREDENTIAL_FILE=\\\"$credential_file\\\",TMUX=\\\"$seat_tmux\\\",TMUX_PANE=\\\"$seat_tmux_pane\\\""
    cmd="codex --model $model -C $proj --dangerously-bypass-approvals-and-sandbox"
    # Codexのeffortは環境変数だけでは適用されない。member metadataへ表示する値と、
    # 実際の推論設定を同じ引数から渡して食い違わせない。
    [ -n "$effort" ] && cmd="$cmd -c 'model_reasoning_effort=\"$effort\"'"
    cmd="$cmd -c 'mcp_servers.room.command=\"node\"'"
    cmd="$cmd -c 'mcp_servers.room.args=[\"$peertable_client\"]'"
    cmd="$cmd -c \"mcp_servers.room.env={$envtbl}\""
    if [ "$mode" = lattice ]; then
      cmd="$cmd -c 'mcp_servers.aiterm.env_vars=[\"PEERTABLE_MEMBER\",\"PEERTABLE_PLAN\",\"LATTICE_CLI\",\"LATTICE_TODO_ACTOR_HOST\",\"LATTICE_TODO_ACTOR_SESSION\",\"LATTICE_TODO_ACTOR_AGENT\"]'"
    fi
    ;;
  # 変数展開の直後に全角括弧を置かない（bash が高位バイトを変数名の一部として食い、
  # 変数が空になって黙って情報が消える。2026-08-08 実測）。必ず ${var} で閉じる
  *) echo "unknown vendor: ${vendor}（claude / codex）" >&2; exit 1 ;;
esac
tmux -S "$sock" send-keys -t "$sess" "$cmd" Enter

# 既知ダイアログ（実測 2026-08-08・Claude Code v2.1.226 / Codex CLI v0.146.0）:
#   claude ① 未信頼ディレクトリの workspace trust「1. Yes, I trust this folder」
#          ② 開発 channel 警告「1. I am using this for local development」
#   codex  ① ディレクトリ trust「1. Yes, continue」
# いずれも既定の選択肢が正なので、文言を確認してから Enter を送る。信頼済みディレクトリでは
# trust が出ないので、出た時だけ通す（順不同・出ないものは待たない）。
# 着席の判定は claude=channels バナー / codex=セッションヘッダ。出なければ画面ごと出して落ちる。
deadline=$((SECONDS + 90))
seated=false
while [ $SECONDS -lt $deadline ]; do
  screen=$(tmux -S "$sock" capture-pane -t "$sess" -p)
  if [ "$vendor" = "claude" ]; then
    case "$screen" in *"Channels (experimental)"*"server:room"*) seated=true; break ;; esac
  else
    case "$screen" in *"OpenAI Codex (v"*) seated=true; break ;; esac
  fi
  case "$screen" in
    # Codex の更新案内だけは既定（1. Update now）が誤り——立卓の途中で
    # `npm install -g @openai/codex` が走る。1つ下の「2. Skip」を選ぶ
    *"1. Update now"*)
      tmux -S "$sock" send-keys -t "$sess" Down
      sleep 1
      tmux -S "$sock" send-keys -t "$sess" Enter ;;
    *"1. Yes, I trust this folder"*|*"1. I am using this for local development"*|*"1. Yes, continue"*)
      tmux -S "$sock" send-keys -t "$sess" Enter ;;
  esac
  sleep 2
done

if [ "$seated" != "true" ]; then
  echo "着席しなかった: ${sess}（最後の画面を出す）" >&2
  tmux -S "$sock" capture-pane -t "$sess" -p >&2
  exit 1
fi

echo "seated: ${sess}（${vendor} / ${model}${effort:+ / $effort} / room=${room} / mode=${mode}）"

# CodexのヘッダはCLIが起動した証拠であって、必須room MCPが初期化された証拠ではない。
# 無関係MCPのwarningが画面へ出ても、room clientがmember登録まで到達した席だけを着席として扱う。
# 登録が無ければ「着席済み」と丸めず、on_exitのrollbackへ渡す。
room_ready_deadline=$((SECONDS + 30))
room_ready=false
while [ $SECONDS -lt "$room_ready_deadline" ]; do
  room_members=$(curl -sf "$url/api/$room/members" 2>/dev/null || true)
  if printf '%s' "$room_members" | python3 -c 'import json,sys; name=sys.argv[1]; members=json.load(sys.stdin).get("members",[]); raise SystemExit(0 if any(m.get("name") == name for m in members) else 1)' "$name"; then
    room_ready=true
    break
  fi
  sleep 1
done
if [ "$room_ready" != true ]; then
  echo "SEAT_ROOM_MCP_NOT_READY: room member登録を観測できない（無関係MCP warningとroom不成立を分離。席をrollbackする）" >&2
  exit 1
fi
echo "room ready: ${room}/${name}"

if [ -n "$brief" ]; then
  # Codex はヘッダを描いた後も MCP 初期化を続ける。Aiterm の ready 契約に合わせ、
  # 同じ可視 pane 内に入力候補行とモデルフッタがある構造を連続して観測する。
  # hook / MCP warning の更新で画面全体が変わっても、入力欄周辺が ready なら通す。
  brief_ready_deadline=$((SECONDS + 90))
  brief_ready_streak=0
  brief_ready=false
  while [ $SECONDS -lt "$brief_ready_deadline" ]; do
    brief_ready_screen=$(tmux -S "$sock" capture-pane -t "$sess" -p 2>/dev/null || true)
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

  brief_before=$(tmux -S "$sock" capture-pane -S -1000 -t "$sess" -p 2>/dev/null || true)
  brief_buffer="peertable-brief-${name}-$$"
  if ! tmux -S "$sock" load-buffer -b "$brief_buffer" "$brief_file"; then
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の tmux buffer 読み込みに失敗（席は着席済み）" >&2
    exit 1
  fi
  if ! tmux -S "$sock" paste-buffer -b "$brief_buffer" -d -t "$sess"; then
    tmux -S "$sock" delete-buffer -b "$brief_buffer" 2>/dev/null || true
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の tmux paste に失敗（席は着席済み）" >&2
    exit 1
  fi
  sleep 1
  if ! tmux -S "$sock" send-keys -t "$sess" Enter; then
    echo "LAUNCH_BRIEF_SEND_FAILED: brief の submit に失敗（席は着席済み）" >&2
    exit 1
  fi

  # 入力欄へ置けた事実だけでは着任成功としない。既存の席状態判定と同じ live marker が、
  # brief 投入後に画面へ現れたことを観測する。高速な fake/CLI の残像を拾わないよう、投入前の
  # 画面と異なることも同時に要求する。dispatch は Aiterm の手動送信と同じく、この1回だけ行う。
  brief_deadline=$((SECONDS + 30))
  brief_turn_started=false
  while [ $SECONDS -lt "$brief_deadline" ]; do
    brief_screen=$(tmux -S "$sock" capture-pane -S -1000 -t "$sess" -p 2>/dev/null || true)
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
pane_pid=$(tmux -S "$sock" list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1 || true)
if [ -n "$pane_pid" ]; then
  # pane の子で pid===pgid のものが席本体。pane_pid（shell）を渡すと Lattice の直接 OS 観測が
  # 「worker process group を無関係 process と共有している」で正しく落ちる。
  # **1件でなければ推測で選ばない**（run-bridge.mjs の seatWorkerPid と同じ規律）。
  leaders=$(ps -Ao pid=,ppid=,pgid= | awk -v p="$pane_pid" '$2==p && $1==$3 {print $1}')
  if [ "$(printf '%s\n' "$leaders" | grep -c .)" = "1" ]; then seat_pid=$(printf '%s' "$leaders" | tr -d ' \n'); fi
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
  if ! python3 - "$proj/.team/seats/$name.json" "$name" "$name" "$seat_pid" <<'PY'
import hashlib, json, os, subprocess, sys, tempfile
out, name, session, pid = sys.argv[1:5]
pid = int(pid)
started = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)],
                         capture_output=True, text=True, check=True).stdout.strip()
argv = subprocess.run(['/bin/ps', '-o', 'args=', '-p', str(pid)],
                      capture_output=True, text=True, check=True).stdout.strip()
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

# 席の素性（vendor / model / effort）を room へ渡す。参加者一覧のホバー表示に使う。
# 席自身の client も起動時に `{name}` だけで登録するので、server 側は
# **欄が無い登録で既存の素性を消さない**（upsert）ことが前提である。
# effort は渡された時だけ入れる——欄が無い＝「不明」ではなく「CLI 既定で走っている」。
# ここが失敗しても席は着席済みなので落とさない。ただし黙っては飲まない。
meta=$(python3 - "$name" "$vendor" "$model" "$effort" "$sock" "$sess" <<'PY'
import json, sys
name, vendor, model, effort, sock, sess = sys.argv[1:7]
body = {'name': name, 'vendor': vendor, 'model': model, 'observe': {'tmux_socket': sock, 'tmux_target': sess}}
if effort:
    body['effort'] = effort
print(json.dumps(body))
PY
)
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
print('yes' if m.get('model') and m.get('observe', {}).get('tmux_target') else 'no')
PY
)
  if [ "$stored" = yes ]; then
    echo "metadata: ${vendor} / ${model}${effort:+ / $effort}"
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

if [ -z "$brief" ]; then brief_completed=true; fi
credential_persist=true
if [ "$brief_not_ready" = true ]; then
  # 空席の後段セットアップ（identity / metadata / bridge）まで済ませたうえで、
  # 呼び出し側にはready未確認を非0で返す。席はAiterm手動dispatchへ引き継ぐ。
  exit 1
fi
