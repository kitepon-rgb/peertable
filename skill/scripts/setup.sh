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
sed "s|{{PEERTABLE_REPO}}|$repo|g" "$tpl/mcp.json" > "$tdir/mcp.json"

added_exclude=false
if [ -d "$proj/.git" ] && ! grep -qx '\.team/' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '.team/' >> "$proj/.git/info/exclude"
  added_exclude=true
fi

lattice_preexisting=false
[ -d "$proj/.lattice" ] && lattice_preexisting=true

printf '{"room":"%s","server_url":"%s","plan_key":"%s","added_exclude":%s,"lattice_preexisting":%s}\n' \
  "$room" "$url" "$plan" "$added_exclude" "$lattice_preexisting" > "$tdir/setup-state.json"
echo "scaffold done: $tdir"
