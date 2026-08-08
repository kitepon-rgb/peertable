#!/bin/bash
# 席を1つ立てる（tmux 作成 → env 注入 → エージェント起動 → 既知ダイアログ通過 → 着席確認）。
# usage: launch-seat.sh <project_dir> <name> <model> [vendor] [effort] [brief]
#   vendor: claude（既定）/ codex
#   brief:  着席が成立したら送る着任指示（省略時は送らない）
#
# room 名・server URL・モード・plan key は <project>/.team/setup-state.json から読む（setup.sh の後に呼ぶ）。
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN、無ければ ~/.config/peertable.env から取る。
# tmux は aiterm-mcp と同じソケットへ作るので、立てた席はそのまま pty_read / pty_send で読める。
set -e
proj="$1"; name="$2"; model="$3"; vendor="${4:-claude}"; effort="$5"; brief="$6"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$model" ] || { echo "usage: launch-seat.sh <project_dir> <name> <model> [vendor] [effort] [brief]" >&2; exit 1; }

sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR}claude-tmux-sockets/claude.sock}"
sess="peer-$name"
state="$proj/.team/setup-state.json"
read -r room url mode plan <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'],d['mode'],d.get('plan_key') or '-')")
EOF

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

# 前の卓の残骸を回収してから立てる（同名セッションが残ると起動が黙って古い席に化ける）
tmux -S "$sock" kill-session -t "$sess" 2>/dev/null || true
tmux -S "$sock" new-session -d -s "$sess" -x 200 -y 50 -c "$proj"

env_line="export PEERTABLE_URL=$url PEERTABLE_ROOM=$room PEERTABLE_MEMBER=$name PEERTABLE_POST_TOKEN=$PEERTABLE_POST_TOKEN"
if [ "$mode" = "lattice" ]; then
  env_line="$env_line PEERTABLE_PLAN=$plan LATTICE_TODO_ACTOR_HOST=${LATTICE_TODO_ACTOR_HOST:-mac} LATTICE_TODO_ACTOR_SESSION=$name LATTICE_TODO_ACTOR_AGENT=$name"
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
    envtbl="PATH=\\\"$PATH\\\",PEERTABLE_URL=\\\"$url\\\",PEERTABLE_ROOM=\\\"$room\\\",PEERTABLE_MEMBER=\\\"$name\\\",PEERTABLE_POST_TOKEN=\\\"$PEERTABLE_POST_TOKEN\\\""
    cmd="codex --model $model -C $proj --dangerously-bypass-approvals-and-sandbox"
    cmd="$cmd -c 'mcp_servers.room.command=\"peertable-client\"'"
    cmd="$cmd -c \"mcp_servers.room.env={$envtbl}\""
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

# 席の素性（vendor / model / effort）を room へ渡す。参加者一覧のホバー表示に使う。
# 席自身の client も起動時に `{name}` だけで登録するので、server 側は
# **欄が無い登録で既存の素性を消さない**（upsert）ことが前提である。
# effort は渡された時だけ入れる——欄が無い＝「不明」ではなく「CLI 既定で走っている」。
# ここが失敗しても席は着席済みなので落とさない。ただし黙っては飲まない。
meta=$(python3 - "$name" "$vendor" "$model" "$effort" <<'PY'
import json, sys
name, vendor, model, effort = sys.argv[1:5]
body = {'name': name, 'vendor': vendor, 'model': model}
if effort:
    body['effort'] = effort
print(json.dumps(body))
PY
)
if curl -sf -o /dev/null -X POST "$url/api/$room/members" \
    -H "X-Peertable-Token: ${PEERTABLE_POST_TOKEN:-}" -H 'content-type: application/json' -d "$meta"; then
  # **200 は保存の証拠にならない**。素性欄を知らない server も 200 {"ok":true} を返して黙って捨てる
  # （登録が `if (!members.has(name))` の no-op になる経路もある）。読み返して実際に載ったかを見る。
  stored=$(curl -sf "$url/api/$room/members" | python3 - "$name" <<'PY'
import json, sys
# 読み返しに失敗しても生の traceback を出さない。ここは「保存されたか」を見るだけの確認段で、
# 判定不能は「保存されていない」と同じ扱いでよい（席は既に着席している）
try:
    members = json.load(sys.stdin)['members']
except Exception:
    members = []
m = next((x for x in members if x.get('name') == sys.argv[1]), {})
print('yes' if m.get('model') else 'no')
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

if [ -n "$brief" ]; then
  sleep 2
  tmux -S "$sock" send-keys -t "$sess" "$brief"
  sleep 1
  tmux -S "$sock" send-keys -t "$sess" Enter
  echo "briefed: $sess"
fi
