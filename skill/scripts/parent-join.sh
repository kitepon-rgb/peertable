#!/bin/bash
# 親（ベル等）が room へ着卓する。
# usage: parent-join.sh <project_dir> [name] [model] [effort] [vendor]
#   name 既定は bell。broadcast廃止に伴いkickoff投稿は行わない。
#   model / effort / vendor は任意。親はオーナーの対話セッション（決定40）なので、席と違って
#   起動時に確定した値を script が知らない——**渡された時だけ**参加者一覧の素性として登録する。
#   渡さなければ欄ごと出ない（「不明」ではなく「素性を名乗っていない」）。
#   vendor は claude（既定）または codex。model だけ渡して vendor を渡さない場合は claude とみなす
#   （後方互換）。
# 親は MCP を後付けできないので room へは HTTP API 直で入る（決定40 の operating notes）。
set -e
proj="$1"; name="${2:-bell}"; model="$3"; effort="$4"; vendor="$5"
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")
mode=$(python3 -c "import json;print(json.load(open('$state')).get('mode',''))")

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

# 親が tmux 内で動いていれば、席と同じ観測記述子（tmux_socket/tmux_target）を自己申告する。
# これで seat-status-bridge.mjs / wakeup-bridge.mjs が親を通常の席と同じ経路で見つけられる
# （実測: tsubaki, room[95]。記述子が無いと wakeup-bridge は対象を解決できない）。
observe_socket=""; observe_target=""
if [ -n "${TMUX:-}" ]; then
  observe_socket=$(tmux display-message -p '#{socket_path}' 2>/dev/null || true)
  observe_target=$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)
fi

member=$(python3 - "$name" "$model" "$effort" "$vendor" "$observe_socket" "$observe_target" <<'PY'
import json, sys
name, model, effort, vendor, observe_socket, observe_target = sys.argv[1:7]
body = {'name': name}
# 渡された欄だけ載せる。空欄を送ると、素性を持つ既存登録を空で上書きしうる
if model or vendor:
    body['vendor'] = vendor or 'claude'
if model:
    body['model'] = model
if effort:
    body['effort'] = effort
if observe_socket and observe_target:
    body['observe'] = {'tmux_socket': observe_socket, 'tmux_target': observe_target}
print(json.dumps(body))
PY
)
curl -sf -X POST "$url/api/$room/members" \
  -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
  -d "$member" > /dev/null
echo "joined: ${name}（room=${room}）"

here="$(cd "$(dirname "$0")" && pwd)"

# owner裁定[46]④: 子processのexportは親shellへ伝播しないため、Lattice mutation
# （todo reopen 等）に要る actor 環境変数は親自身が source する持続ファイルとして配る。
if [ "$mode" = "lattice" ]; then
  env_file="$proj/.team/parent-env.sh"
  cat > "$env_file" <<EOF
export LATTICE_TODO_ACTOR_HOST=mac
export LATTICE_TODO_ACTOR_SESSION=${name}
export LATTICE_TODO_ACTOR_AGENT=${name}
EOF
  echo "Lattice mutation（todo reopen 等）を打つ前に: source ${env_file}"
fi

if [ -f "$proj/.team/roles/parent.md" ]; then
  echo "親役割は $proj/.team/roles/parent.md を読むこと"
fi

# Codex 親は wakeup-bridge が起床を担う（parent.md）。observe 記述子（＝tmux内で動いている）が
# 無いと対象を解決できず自動配線できないので、その場合は制約を明示して手動監視へ回す
# （実測: tsubaki, room[95]。owner候補[37]①と同系統）。
capacity_delivery_ready=1
if [ "$vendor" = "codex" ]; then
  if [ -n "$observe_target" ]; then
    if "$here/ensure-bridge.sh" "$proj" wakeup "$name"; then
      echo "wakeup-bridge を親（${name}）宛に起動した"
    else
      echo "WARN: wakeup-bridge の起動に失敗した。手動で ${here}/ensure-bridge.sh ${proj} wakeup ${name} を実行すること" >&2
      capacity_delivery_ready=0
    fi
  else
    echo "WARN: 親が tmux 外で動いているため wakeup-bridge を自動配線できない（外部注入面が無いhost）。room の新着は read_unread を自分で定期的に呼ぶこと" >&2
    capacity_delivery_ready=0
  fi
fi

# capacity通知はroomへ記録するだけでなく、上で準備したname→session descriptor経路から
# 親を実際に起こせて初めて届く。Codex親ではwakeup-bridge readyより先に初回差分を送らない。
if [ "$capacity_delivery_ready" = "1" ]; then
  if env -u PEERTABLE_POST_TOKEN PEERTABLE_PARENT_NAME="$name" "$here/ensure-bridge.sh" "$proj" capacity; then
    echo "capacity-bridge を親（${name}）の配送経路準備後に起動した"
  else
    echo "WARN: capacity-bridge の起動に失敗した。手動で ${here}/ensure-bridge.sh ${proj} capacity を実行すること" >&2
  fi
else
  echo "WARN: CAPACITY_BRIDGE_DELIVERY_NOT_READY: 親（${name}）の配送経路が無いためcapacity-bridgeを起動しない" >&2
fi

curl -sf "$url/api/$room/members" | python3 -c "import json,sys;print('members:', ', '.join(m['name'] for m in json.load(sys.stdin)['members']))"
