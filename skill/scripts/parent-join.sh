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

# 親はAiterm席ではない。Claude/Codexとも、親自身が所有するparent-watchを配送先にする。
# tmux observeやCodex thread IDを登録すると、通常席bridge／外部resumeへ誤配送される。
parent_vendor="${vendor:-claude}"
member=$(python3 - "$name" "$model" "$effort" "$parent_vendor" <<'PY'
import json, sys
name, model, effort, vendor = sys.argv[1:5]
body = {'name': name}
# 渡された欄だけ載せる。空欄を送ると、素性を持つ既存登録を空で上書きしうる
if model or vendor:
    body['vendor'] = vendor or 'claude'
if model:
    body['model'] = model
if effort:
    body['effort'] = effort
body['observe'] = None
body['delivery'] = {'kind': 'parent_watch', 'host': vendor}
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

# parent-watchが初回headを固定してからcapacityを起こす。以後のDMはwatcher不在時間を含め
# 永続cursorからcatch-upされる。host内のbackground task自体は親セッションだけが所有できる。
capacity_delivery_ready=0
if PEERTABLE_PARENT_HOST="$parent_vendor" node "$here/parent-watch.mjs" "$proj" "$name" --prime; then
  capacity_delivery_ready=1
  echo "parent-watch cursor ready: ${name}（host=${parent_vendor}）"
  if [ "$parent_vendor" = "codex" ]; then
    echo "PARENT_WATCH_START_REQUIRED: Codex親のbackground taskで ${here}/parent-watch.mjs ${proj} ${name} --next を反復し、stdout eventを親turnへnotifyすること"
  else
    echo "PARENT_WATCH_START_REQUIRED: Claude Monitor（persistent）で ${here}/parent-watch.mjs ${proj} ${name} --follow を起動すること"
  fi
else
  echo "WARN: PARENT_WATCH_PRIME_FAILED: 親（${name}）のDM cursorを準備できない" >&2
fi

# capacity通知はroomへ記録するだけでなく、上で準備したname→session descriptor経路から
# 親DMは上で固定したcursorから欠落なく回収できる状態になってからcapacityを起こす。
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
