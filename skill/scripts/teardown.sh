#!/bin/bash
# Peertable teardown の機械部分。席（tmux）も本 script が畳む。
# usage: teardown.sh <project_dir> [--purge]
#   既定（archive）: room のログを `docs/archive/` へ書き出し、`.lattice/` は残して畳む
#   --purge        : 何も残さず全部消す（従来の痕跡ゼロ・ゲスト project 向け）
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN から取る（`~/.config/peertable.env` は export 付きで定義すること）。
#
# 撤去は「何が実施され、何が実施されなかったか」を1行ずつ出す。room 削除だけがトークンを要するので、
# そこが失敗しても残りの撤去は続行し、未実施を明示して非ゼロで終わる（黙って中断しない・決定58）。
#
# **既定が archive なのはオーナー裁定（2026-08-09・決定61）**。痕跡ゼロを既定にしていた時代は、
# 畳んだ瞬間に room の会話ログ（server 側の正本）と Lattice store が消えていた——**卓の議論と
# 工程の記録は、卓そのものより寿命が長い**。ゲスト project を汚さない不可侵原則は `--purge` が持つ。
set -e
proj="$1"
mode=archive
for arg in "${@:2}"; do
  case "$arg" in
    --purge) mode=purge ;;
    --archive) mode=archive ;;
    *) echo "ERROR: 未知の引数: ${arg}（受けるのは --purge / --archive だけ）" >&2; exit 1 ;;
  esac
done
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

echo "teardown: mode=${mode}（archive=ログとstoreを残す／purge=痕跡ゼロ）"

# ---- ログの控え（archive だけ）。room 自体は残るので、これは repo 側の写し ----
# 失敗しても撤去は続ける（room に原本があるため）。--purge の時だけ「消す前の最後の機会」になる
log_saved=skip
if [ "$mode" = archive ]; then
  arc="$proj/docs/archive"
  out="$arc/room-log_${room}_$(date +%Y%m%d-%H%M%S).md"
  mkdir -p "$arc"
  if python3 "$(dirname "$0")/archive-room-log.py" "$url" "$room" "$out"; then
    did "room ログの写しを ${out#"$proj/"} へ（原本は room に残る）"
    log_saved=yes
  else
    miss "room ログの写しに失敗（$url/api/$room が読めない）— **原本は room に残っている**ので撤去は続行する"
    log_saved=no
  fi
fi

# ---- 席（tmux）の終了。**`.team/` を消す前**に、この room の member だけを畳む ----
# `peer-*` を全部畳むと、同じマシンの別の卓を巻き込む（bridge が members 起点にしているのと同じ理由）
sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR}claude-tmux-sockets/claude.sock}"
seats=$(python3 "$(dirname "$0")/archive-room-log.py" --members "$url" "$room" 2>/dev/null || true)
if [ -z "$seats" ]; then
  miss "席の終了 — member 一覧が取れず、畳む相手を特定できない。手で確認: tmux -S \"$sock\" list-sessions | grep peer-"
else
  closed=0
  for name in $seats; do
    if tmux -S "$sock" has-session -t "peer-$name" 2>/dev/null; then
      tmux -S "$sock" kill-session -t "peer-$name" && closed=$((closed + 1))
    fi
  done
  if [ "$closed" -gt 0 ]; then did "席の終了（${closed}席）"; else skip "席の終了（生きている席なし）"; fi
  left=$(tmux -S "$sock" list-sessions 2>/dev/null | grep -c '^peer-' || true)
  [ "${left:-0}" -eq 0 ] || echo "teardown: [注記] 他の卓の peer-* が ${left}件 残っている（この卓のものではないので畳まない）"
fi

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

# ---- 解散（archive）: **部屋は残し、メンバー登録だけ外す** ----
# 円卓の解散は「部屋を畳む」ではなく「集まりが散る」。部屋は場所であって、次の campaign も
# 同じ部屋で続く——**過去ログが同じ部屋の履歴として繋がり、部屋は常に一つに見える**
# （オーナー裁定 2026-08-09・決定61）。参加者一覧だけ空にして、席が戻れば再登録される
if [ "$mode" = archive ]; then
  if [ -z "${PEERTABLE_POST_TOKEN:-}" ]; then
    miss "メンバー登録の解除 — TOKEN_MISSING: \`~/.config/peertable.env\` の定義が \`export\` 付きでないと子 process へ渡らない"
    echo "teardown: [手当] 参加者は次で外せる: curl -X DELETE \"$url/api/$room/members/<名前>\" -H \"X-Peertable-Token: \$PEERTABLE_POST_TOKEN\"" >&2
  elif [ -z "$seats" ]; then
    skip "メンバー登録の解除（一覧が取れていない）"
  else
    # 履歴に解散の区切りを残す。**部屋が続く以上、どこで卓が変わったかが読めないと
    # 過去ログが一続きの会話に見えてしまう**（次の campaign の発言と地続きになる）
    body="解散。この卓はここまで。参加者: ${seats}。部屋と過去ログはこのまま残り、次の卓も同じ部屋で続く。"
    python3 -c "
import json,sys,urllib.request
req=urllib.request.Request('$url/api/$room/messages', method='POST',
  data=json.dumps({'from':'system','to':'all','body':'''$body'''}).encode(),
  headers={'Content-Type':'application/json','X-Peertable-Token':'$PEERTABLE_POST_TOKEN'})
urllib.request.urlopen(req, timeout=10).read()
" 2>/dev/null && did "解散の区切りを履歴へ" || skip "解散の区切り（投稿できず・撤去は続行）"
    n=0
    for name in $seats; do
      c=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$url/api/$room/members/$name" -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" || true)
      [ "$c" = 200 ] && n=$((n + 1))
    done
    did "メンバー登録の解除（${n}名）— **部屋と過去ログは残す**（$url/$room）"
  fi
# room 削除は --purge だけ。トークンを要する唯一の段で、ここだけが外部サービスへの依存境界
elif [ "$log_saved" = no ]; then
  miss "room 削除 $room — ログを保全できていないので消さない（保全より先に消すと会話は二度と戻らない）"
elif [ -z "${PEERTABLE_POST_TOKEN:-}" ]; then
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

if [ "$lat_pre" = "True" ] || [ "$lat_pre" = "true" ]; then
  skip ".lattice/（setup 以前から存在）"
elif [ "$mode" = archive ]; then
  # 工程正本を残すのが archive の本体。**残すだけでは git が知らない**ので、追跡へ入れるのは人の判断
  did ".lattice/ を残す（工程正本・\`lattice todo status\` と \`gantt serve\` が読む）"
  echo "teardown: [注記] .lattice/ は git 追跡外のままなら次の clone に残らない。残すなら commit すること"
else
  rm -rf "$proj/.lattice"
  did ".lattice/ 削除（setup が作ったもの・--purge）"
fi

if [ "$fail" -ne 0 ]; then
  # 「再実行すればいい」と書かないこと。`.team/` は上で消えているので、2回目は setup-state.json が
  # 読めずに落ちる＝**再実行の経路は存在しない**。残っている道は上の [手当] の curl だけ（2026-08-08 実測）
  echo "teardown: 未完了 — 撤去は上のとおり済んでいる。残りは上の [手当] を手で叩くこと（.team/ は削除済みなので teardown.sh の再実行はできない）" >&2
  exit 1
fi
echo "teardown done: $proj"
