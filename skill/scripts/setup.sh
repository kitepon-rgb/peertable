#!/bin/bash
# Peertable setup の機械部分: .team/ scaffold と git 除外。
# usage: setup.sh <project_dir> <room> <server_url> <plan_key> <peertable_repo>
set -e
proj="$1"; room="$2"; url="$3"; plan="$4"; repo="$5"
tpl="$repo/skill/templates"
tdir="$proj/.team"

mkdir -p "$tdir/roles" "$tdir/scripts"
cp "$tpl/charter.md" "$tdir/CLAUDE.md"
sed "s|{{PLAN_KEY}}|$plan|g" "$tpl/member.md" > "$tdir/roles/member.md"
cp "$tpl/done.sh" "$tdir/scripts/done.sh" && chmod +x "$tdir/scripts/done.sh"

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

printf '{"room":"%s","server_url":"%s","plan_key":"%s","added_exclude":%s,"lattice_preexisting":%s,"added_root_mcp":%s,"added_mcp_exclude":%s}\n' \
  "$room" "$url" "$plan" "$added_exclude" "$lattice_preexisting" "$added_root_mcp" "$added_mcp_exclude" > "$tdir/setup-state.json"
echo "scaffold done: $tdir"
