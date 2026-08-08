#!/bin/bash
# Peertable teardown の機械部分。実行前にメンバーセッションを終了しておくこと（AI が pty_close で行う）。
# usage: teardown.sh <project_dir>
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN から取る（`~/.config/peertable.env` は export 付きで定義すること）。
#
# 撤去は「何が実施され、何が実施されなかったか」を1行ずつ出す。room 削除だけがトークンを要するので、
# そこが失敗しても残りの撤去は続行し、未実施を明示して非ゼロで終わる（黙って中断しない・決定58）。
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

fail=0
did() { echo "teardown: [実施] $*"; }
skip() { echo "teardown: [スキップ] $*"; }
miss() { echo "teardown: [未実施] $*" >&2; fail=1; }
yes_() { [ "$1" = "True" ] || [ "$1" = "true" ]; }

# Codex 席の起床ブリッジ（決定54）。常駐 process なので、`.team/` を消す前に確実に止める
if [ -f "$proj/.team/wakeup-bridge.json" ]; then
  # 停止に失敗しても **ここで止まらない**。`set -e` で落ちると、t6 の契約（各段の実施・未実施を
  # 1行ずつ出す／黙って中断しない）が丸ごと破れる——[未実施] も [手当] も要約も出ずに撤去が全部残る
  if node "$(dirname "$0")/wakeup-bridge.mjs" "$proj" --stop; then
    did "wakeup-bridge 停止"
  else
    miss "wakeup-bridge 停止に失敗（常駐が残る）— 上の _STOP_FAILED を見て手で止める"
  fi
else
  skip "wakeup-bridge（起動記録なし）"
fi

# 席の稼働状態ブリッジ。同じく常駐 process なので `.team/` を消す前に止める。
# ここで止めないと、pid 記録が `.team/` ごと消えて **`--stop` でも止められなくなる**——しかも
# 「起動記録が無い（既に停止）」と rc=0 で報告する＝**止めたと嘘をつく残骸**になる（実測）
if [ -f "$proj/.team/seat-status-bridge.json" ]; then
  # 停止に失敗しても **ここで止まらない**。`set -e` で落ちると、t6 の契約（各段の実施・未実施を
  # 1行ずつ出す／黙って中断しない）が丸ごと破れる——[未実施] も [手当] も要約も出ずに撤去が全部残る
  if node "$(dirname "$0")/seat-status-bridge.mjs" "$proj" --stop; then
    did "seat-status-bridge 停止"
  else
    miss "seat-status-bridge 停止に失敗（常駐が残る）— 上の _STOP_FAILED を見て手で止める"
  fi
else
  skip "seat-status-bridge（起動記録なし）"
fi

# 外部ペイン（決定53）。`.team/` を消す前に戻す——退避先が `.team/` の中にある
ext=$(python3 -c "import json;print(json.load(open('$state')).get('external_pane', False))")
pj_pre=$(python3 -c "import json;print(json.load(open('$state')).get('project_json_preexisting', False))")

# room 削除。トークンを要する唯一の段で、ここだけが外部サービスへの依存境界
if [ -z "${PEERTABLE_POST_TOKEN:-}" ]; then
  miss "room 削除 $room — TOKEN_MISSING: PEERTABLE_POST_TOKEN が空。\`~/.config/peertable.env\` の定義が \`export\` 付きでないと子 process へ渡らない"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$url/api/$room" -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" || true)
  [ -n "$code" ] || code=000
  if [ "$code" = 200 ]; then
    did "room 削除 $room (HTTP 200)"
  else
    miss "room 削除 $room (HTTP $code) — 403/401 はトークン不一致、000 は server 不達"
  fi
fi
# 未実施なら `.team/` と一緒に room 名も消えるので、後から手で消せる形を先に出す
[ "$fail" -eq 0 ] || echo "teardown: [手当] room は次で消せる: curl -X DELETE \"$url/api/$room\" -H \"X-Peertable-Token: \$PEERTABLE_POST_TOKEN\"" >&2

if yes_ "$ext"; then
  if yes_ "$pj_pre"; then
    cp "$proj/.team/project.json.bak" "$proj/.lattice/project.json"
    did "外部ペイン復元（既存 project.json を書き戻し）"
  else
    rm -f "$proj/.lattice/project.json"
    did "外部ペイン撤去（project.json 削除）"
  fi
else
  skip "外部ペイン（登録なし）"
fi

rm -rf "$proj/.team"
did ".team/ 削除"

if yes_ "$added_mcp"; then
  rm -f "$proj/.mcp.json"
  did ".mcp.json 削除"
else
  skip ".mcp.json（setup が作っていない）"
fi

if yes_ "$added_mcp_ex"; then
  grep -vx '/\.mcp\.json' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
  did "exclude から /.mcp.json を撤去"
else
  skip "exclude の /.mcp.json（setup が足していない）"
fi

if yes_ "$added"; then
  grep -vx '\.team/' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
  did "exclude から .team/ を撤去"
else
  skip "exclude の .team/（setup が足していない）"
fi

if [ "$lat_pre" = "False" ] || [ "$lat_pre" = "false" ]; then
  rm -rf "$proj/.lattice"
  did ".lattice/ 削除（setup が作ったもの）"
else
  skip ".lattice/（setup 以前から存在）"
fi

if [ "$fail" -ne 0 ]; then
  # 「再実行すればいい」と書かないこと。`.team/` は上で消えているので、2回目は setup-state.json が
  # 読めずに落ちる＝**再実行の経路は存在しない**。残っている道は上の [手当] の curl だけ（2026-08-08 実測）
  echo "teardown: 未完了 — 撤去は上のとおり済んでいる。残りは上の [手当] を手で叩くこと（.team/ は削除済みなので teardown.sh の再実行はできない）" >&2
  exit 1
fi
echo "teardown done: $proj"
