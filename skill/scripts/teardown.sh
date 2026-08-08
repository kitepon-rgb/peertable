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
# 旧 state（added_root_mcp 不在・手動フォールバック時代の root_mcp_json_fallback）も読む
added_mcp=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('added_root_mcp', d.get('root_mcp_json_fallback', False)))")
added_mcp_ex=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('added_mcp_exclude', d.get('root_mcp_json_fallback', False)))")

curl -sf -X DELETE "$url/api/$room" -H "X-Peertable-Token: ${PEERTABLE_POST_TOKEN:-}" > /dev/null
rm -rf "$proj/.team"
if [ "$added_mcp" = "True" ] || [ "$added_mcp" = "true" ]; then
  rm -f "$proj/.mcp.json"
fi
if [ "$added_mcp_ex" = "True" ] || [ "$added_mcp_ex" = "true" ]; then
  grep -vx '/\.mcp\.json' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
fi
if [ "$added" = "True" ] || [ "$added" = "true" ]; then
  grep -vx '\.team/' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
fi
if [ "$lat_pre" = "False" ] || [ "$lat_pre" = "false" ]; then
  rm -rf "$proj/.lattice"
fi
echo "teardown done: $proj"
