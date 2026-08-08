#!/bin/bash
# Peertable setup の機械部分: .team/ scaffold と git 除外。
# usage: setup.sh <project_dir> <room> <server_url> <plan_key|-> <peertable_repo> [tasks_file]
#   plan_key に `-` を渡すと単独円卓モード（工程正本を持たない。決定47）。
#   単独モードでは tasks_file（聞き取ったタスクを書いた本文）が必須で、議題表 .team/tasks.md になる。
set -e
proj="$1"; room="$2"; url="$3"; plan="$4"; repo="$5"; tasks="$6"
tpl="$repo/skill/templates"
tdir="$proj/.team"

if [ "$plan" = "-" ] || [ -z "$plan" ]; then
  mode=standalone; plan=""
  # 引数の検証は project へ何か置く前に済ませる（不可侵原則: 半端な .team/ を残さない）
  if [ -z "$tasks" ] || [ ! -f "$tasks" ]; then
    echo "ERROR: 単独円卓モードは議題表の本文ファイル（第6引数）が必須: setup.sh ... - <peertable_repo> <tasks_file>" >&2
    exit 1
  fi
else
  mode=lattice
fi

mkdir -p "$tdir/roles"
cp "$tpl/charter.md" "$tdir/CLAUDE.md"
if [ "$mode" = "standalone" ]; then
  cp "$tpl/member-standalone.md" "$tdir/roles/member.md"
  cat "$tpl/tasks.md" "$tasks" > "$tdir/tasks.md"
else
  mkdir -p "$tdir/scripts"
  sed "s|{{PLAN_KEY}}|$plan|g" "$tpl/member.md" > "$tdir/roles/member.md"
  cp "$tpl/done.sh" "$tdir/scripts/done.sh" && chmod +x "$tdir/scripts/done.sh"
fi

# room MCP 定義は project root の .mcp.json が正（channels は --mcp-config を解決しない。決定44）
added_root_mcp=false
if [ -f "$proj/.mcp.json" ]; then
  echo "WARN: $proj/.mcp.json が既に存在する。上書きしない。room の server 定義を手動 merge し、teardown で復元すること" >&2
else
  sed "s|{{PEERTABLE_REPO}}|$repo|g" "$tpl/mcp.json" > "$proj/.mcp.json"
  added_root_mcp=true
fi

added_exclude=false
if [ -d "$proj/.git" ] && ! grep -qx '\.team/' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '.team/' >> "$proj/.git/info/exclude"
  added_exclude=true
fi
added_mcp_exclude=false
if [ "$added_root_mcp" = "true" ] && [ -d "$proj/.git" ] && ! grep -qx '/\.mcp\.json' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '/.mcp.json' >> "$proj/.git/info/exclude"
  added_mcp_exclude=true
fi

lattice_preexisting=false
[ -d "$proj/.lattice" ] && lattice_preexisting=true

# Lattice 併用モードだけ、工程表の右ペインへ円卓を差す（決定53・明示的コネクタ）。
# 公開URL基底は `PEERTABLE_PUBLIC_URL`（クオ環境: https://peertable.kitepon.dev）。
# 未設定なら room サーバーの URL をそのまま使う——LAN URL は Lattice を外から見た時に開けないので、
# 書いた URL は必ず標準エラーへ出す。
external_pane=false
project_json_preexisting=false
public_url=""
if [ "$mode" = "lattice" ]; then
  public_url="${PEERTABLE_PUBLIC_URL:-$url}"
  project_json_preexisting=$(node "$repo/skill/scripts/external-pane.mjs" "$proj" "$room" "$public_url")
  external_pane=true
fi

printf '{"room":"%s","server_url":"%s","public_url":"%s","mode":"%s","plan_key":"%s","added_exclude":%s,"lattice_preexisting":%s,"added_root_mcp":%s,"added_mcp_exclude":%s,"external_pane":%s,"project_json_preexisting":%s}\n' \
  "$room" "$url" "$public_url" "$mode" "$plan" "$added_exclude" "$lattice_preexisting" "$added_root_mcp" "$added_mcp_exclude" "$external_pane" "$project_json_preexisting" > "$tdir/setup-state.json"
echo "scaffold done: $tdir"
