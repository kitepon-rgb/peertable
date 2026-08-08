#!/bin/bash
# Peertable setup の機械部分: .team/ scaffold と git 除外。
# usage: setup.sh <project_dir> <room> <server_url> <plan_key|-> <peertable_repo> [tasks_file] [--phase <id>]...
#   plan_key に `-` を渡すと単独円卓モード（工程正本を持たない。決定47）。
#   単独モードでは tasks_file（聞き取ったタスクを書いた本文）が必須で、議題表 .team/tasks.md になる。
#   --phase は複数指定可。指定すると卓の claim 範囲がその phase の task に限られる。
#   指定なしは plan 全体。他 campaign と同じ plan へ相乗りする時に、範囲外 phase の越境を止めるためのもの。
set -e
proj="$1"; room="$2"; url="$3"; plan="$4"; repo="$5"
[ $# -ge 5 ] && shift 5 || shift $#
# 第6引数の tasks_file は単独円卓モードだけが使う。`--` で始まるものはオプションなので
# 位置引数として食わない——食うと Lattice 併用モードの `… <repo> --phase p2` が
# 「未知の引数: p2」という原因を指さないエラーで落ちる（2026-08-08 実測・kotoha 監査）。
tasks=""
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then tasks="$1"; shift; fi

phases=()
while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      shift
      [ -n "$1" ] || { echo "ERROR: --phase には phase id が要る" >&2; exit 1; }
      case "$1" in
        *[!A-Za-z0-9._-]*) echo "ERROR: phase id に使えない文字がある: $1" >&2; exit 1 ;;
      esac
      phases+=("$1")
      ;;
    *) echo "ERROR: 未知の引数: $1（--phase <id> だけを受ける）" >&2; exit 1 ;;
  esac
  shift
done
tpl="$repo/skill/templates"
tdir="$proj/.team"

if [ "$plan" = "-" ] || [ -z "$plan" ]; then
  mode=standalone; plan=""
  # 単独円卓モードに phase は無い（工程正本を持たないため）。黙って無視せず止める
  [ ${#phases[@]} -eq 0 ] || { echo "ERROR: 単独円卓モードに --phase は使えない（工程正本を持たないため）" >&2; exit 1; }
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
  # claim 範囲は席へ渡す文書に焼き込む。範囲の出典を「誰かの記憶」でなく role 文書にする
  if [ ${#phases[@]} -eq 0 ]; then
    scope="この卓の claim 範囲は plan 全体（phase 指定なしで立っている）。"
  else
    scope="**この卓の claim 範囲は phase ${phases[*]} の task だけ**。範囲外の phase の task は、ready に見えていても取らない——同じ plan へ別 campaign が相乗りしている時、範囲外を取ると他卓の工程を横取りする（越境が2回実測されたことへの対処）。範囲外に手を入れる必要が出たら room へ出して裁定を仰ぐ。"
  fi
  sed -e "s|{{PLAN_KEY}}|$plan|g" -e "s|{{CLAIM_SCOPE}}|$scope|g" "$tpl/member.md" > "$tdir/roles/member.md"
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

# phases は追加キー（既存の読み手は .get で読むので壊れない）。空配列＝plan 全体
phases_json="[]"
if [ ${#phases[@]} -gt 0 ]; then
  phases_json=$(printf '"%s",' "${phases[@]}")
  phases_json="[${phases_json%,}]"
fi

printf '{"room":"%s","server_url":"%s","public_url":"%s","mode":"%s","plan_key":"%s","phases":%s,"added_exclude":%s,"lattice_preexisting":%s,"added_root_mcp":%s,"added_mcp_exclude":%s,"external_pane":%s,"project_json_preexisting":%s}\n' \
  "$room" "$url" "$public_url" "$mode" "$plan" "$phases_json" "$added_exclude" "$lattice_preexisting" "$added_root_mcp" "$added_mcp_exclude" "$external_pane" "$project_json_preexisting" > "$tdir/setup-state.json"
echo "scaffold done: $tdir"
