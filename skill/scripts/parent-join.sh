#!/bin/bash
# 親（ベル等）が room へ着卓する。
# usage: parent-join.sh <project_dir> [name] [model] [effort]
#   name 既定は bell。broadcast廃止に伴いkickoff投稿は行わない。
#   model / effort は任意。親はオーナーの対話セッション（決定40）なので、席と違って
#   起動時に確定した値を script が知らない——**渡された時だけ**参加者一覧の素性として登録する。
#   渡さなければ欄ごと出ない（「不明」ではなく「素性を名乗っていない」）。
# 親は MCP を後付けできないので room へは HTTP API 直で入る（決定40 の operating notes）。
set -e
proj="$1"; name="${2:-bell}"; model="$3"; effort="$4"
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

member=$(python3 - "$name" "$model" "$effort" <<'PY'
import json, sys
name, model, effort = sys.argv[1:4]
body = {'name': name}
# 渡された欄だけ載せる。空欄を送ると、素性を持つ既存登録を空で上書きしうる
if model:
    body['vendor'] = 'claude'
    body['model'] = model
if effort:
    body['effort'] = effort
print(json.dumps(body))
PY
)
curl -sf -X POST "$url/api/$room/members" \
  -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
  -d "$member" > /dev/null
echo "joined: ${name}（room=${room}）"

curl -sf "$url/api/$room/members" | python3 -c "import json,sys;print('members:', ', '.join(m['name'] for m in json.load(sys.stdin)['members']))"
