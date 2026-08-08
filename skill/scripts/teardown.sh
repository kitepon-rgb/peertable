#!/bin/bash
# Peertable teardown の機械部分。実行前にメンバーセッションを終了しておくこと（AI が pty_close で行う）。
# usage: teardown.sh <project_dir>
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN から取る。
set -e
proj="$1"
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")
added=$(python3 -c "import json;print(json.load(open('$state'))['added_exclude'])")
lat_pre=$(python3 -c "import json;print(json.load(open('$state'))['lattice_preexisting'])")

curl -sf -X DELETE "$url/api/$room" -H "X-Peertable-Token: ${PEERTABLE_POST_TOKEN:-}" > /dev/null
rm -rf "$proj/.team"
if [ "$added" = "True" ] || [ "$added" = "true" ]; then
  grep -vx '\.team/' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
fi
if [ "$lat_pre" = "False" ] || [ "$lat_pre" = "false" ]; then
  rm -rf "$proj/.lattice"
fi
echo "teardown done: $proj"
