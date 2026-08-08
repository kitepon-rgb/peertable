#!/bin/bash
# 親（ベル等）が room へ着卓し、必要なら kickoff を投げる。
# usage: parent-join.sh <project_dir> [name] [kickoff_file]
#   name 既定は bell。kickoff_file を渡すとその本文を全員宛で1回投稿する
#   （複数行・記号を安全に運ぶためファイル渡しにしている。引数のインライン渡しはしない）。
# 親は MCP を後付けできないので room へは HTTP API 直で入る（決定40 の operating notes）。
set -e
proj="$1"; name="${2:-bell}"; kickoff="$3"
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

member=$(python3 - "$name" <<'PY'
import json, sys
print(json.dumps({'name': sys.argv[1]}))
PY
)
curl -sf -X POST "$url/api/$room/members" \
  -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
  -d "$member" > /dev/null
echo "joined: ${name}（room=${room}）"

if [ -n "$kickoff" ]; then
  # JSON の組み立てはヒアドキュメントで行う。`-c` にインラインで書くと本文の `{...}`
  # をシェルのブレース展開が刻んで壊す（2026-08-08 実測）
  body=$(python3 - "$name" "$kickoff" <<'PY'
import json, sys
print(json.dumps({'from': sys.argv[1], 'to': 'all', 'body': open(sys.argv[2]).read().strip()}))
PY
)
  curl -sf -X POST "$url/api/$room/messages" \
    -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
    -d "$body" > /dev/null
  echo "kickoff posted: $kickoff"
fi

curl -sf "$url/api/$room/members" | python3 -c "import json,sys;print('members:', ', '.join(m['name'] for m in json.load(sys.stdin)['members']))"
