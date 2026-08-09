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
if [ $# -gt 0 ]; then
  case "$1" in
    -) shift ;;              # 明示的な「tasks_file 無し」
    -*) ;;                   # オプション（綴り誤りも含む）。下のループで typed に落とす
    *) tasks="$1"; shift ;;  # tasks_file
  esac
fi

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
    *) echo "ERROR: 未知の引数: $1（受けるのは --phase <id> だけ。tasks_file は単独円卓モード専用で、オプションより前に置く）" >&2; exit 1 ;;
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

# Lattice 併用モードは、登録に使う公開CLIと同梱work-order binaryを、projectへ
# 何か置く前に確定する。通常はglobal installされた lattice の隣を使う。
# release前のsource treeを実測する時だけ、2つのenvで同じtreeのbinを明示できる。
lattice_cli=""
work_order_binary=""
node_binary=""
if [ "$mode" = "lattice" ]; then
  lattice_cli="${LATTICE_CLI:-$(command -v lattice 2>/dev/null || true)}"
  [ -n "$lattice_cli" ] || { echo "ERROR: lattice CLI が見つからない" >&2; exit 1; }
  [ -x "$lattice_cli" ] || { echo "ERROR: lattice CLI が実行可能fileでない: $lattice_cli" >&2; exit 1; }
  lattice_cli=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$lattice_cli")

  work_order_binary="${LATTICE_WORK_ORDER_ADAPTER_BINARY:-$(dirname "$lattice_cli")/lattice-work-order-adapter.mjs}"
  [ -f "$work_order_binary" ] && [ -x "$work_order_binary" ] || {
    echo "ERROR: Lattice work-order adapter binary が見つからないか実行不能: $work_order_binary" >&2
    exit 1
  }
  work_order_binary=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$work_order_binary")
  node_binary=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.execPath))')
  [ -x "$node_binary" ] || { echo "ERROR: Node executable が実行可能fileでない: $node_binary" >&2; exit 1; }

  # config_refはgit root相対の公開契約。subdirectoryをprojectとして受けると別の
  # `.lattice/` を作ってしまうので、黙って親repoへ登録せずtypedに止める。
  project_root=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$proj")
  git_root=$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$git_root" ] || { echo "ERROR: Lattice 併用モードのprojectはgit repositoryでなければならない: $proj" >&2; exit 1; }
  git_root=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$git_root")
  [ "$project_root" = "$git_root" ] || {
    echo "ERROR: project_dirはgit rootを指さなければならない: project=$project_root git_root=$git_root" >&2
    exit 1
  }
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
runtime_preexisting=false
[ -d "$proj/.lattice/runtime" ] && runtime_preexisting=true

# adapter registry/config/spool はhost固有のruntime stateであり、sourceとして追跡しない。
# `.lattice/`の一部を正本として追跡するprojectでもruntimeだけをroot相対で除外する。
added_runtime_exclude=false
if [ "$mode" = "lattice" ] && [ -d "$proj/.git" ] \
  && ! grep -qx '/\.lattice/runtime/' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '/.lattice/runtime/' >> "$proj/.git/info/exclude"
  added_runtime_exclude=true
fi

# managed run の仕事口をLattice runtime stateとして用意する。configを`.team/`
# に置くとarchive teardownでregistryだけが残って壊れるため、registryと同じ
# `.lattice/runtime/`の寿命へ揃える。席はこのspoolへ直接触れない。
work_order_adapter=false
work_order_spool_ref=""
if [ "$mode" = "lattice" ]; then
  work_order_root="$proj/.lattice/runtime/work-order-adapter"
  work_order_spool="$work_order_root/spool"
  work_order_config="$work_order_root/config.json"
  work_order_registration="$tdir/work-order-adapter-registration.json"
  work_order_config_ref=".lattice/runtime/work-order-adapter/config.json"
  work_order_spool_ref=".lattice/runtime/work-order-adapter/spool"

  mkdir -p "$work_order_spool/orders" "$work_order_spool/reports"
  chmod 700 "$work_order_root" "$work_order_spool" "$work_order_spool/orders" "$work_order_spool/reports"
  work_order_spool=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$work_order_spool")

  node -e '
    const { writeFileSync } = require("node:fs");
    const [target, spool] = process.argv.slice(1);
    writeFileSync(target, `${JSON.stringify({
      schema: "lattice.work_order_adapter_config.v1",
      spool_dir: spool,
    })}\n`, { mode: 0o600 });
  ' "$work_order_config" "$work_order_spool"
  chmod 600 "$work_order_config"
  node -e '
    const { writeFileSync } = require("node:fs");
    const [target, binary, script, configRef] = process.argv.slice(1);
    writeFileSync(target, `${JSON.stringify({
      schema: "lattice.runtime_adapter_registration_input.v2",
      adapter_kind: "work-order",
      launch_kind: "host_binary",
      binary_path: binary,
      argv: [script],
      config_ref: configRef,
      host_driven_epoch: true,
    })}\n`, { mode: 0o600 });
  ' "$work_order_registration" "$node_binary" "$work_order_binary" "$work_order_config_ref"
  chmod 600 "$work_order_registration"

  (
    cd "$proj"
    "$lattice_cli" run adapter register --input "$work_order_registration"
  )
  work_order_adapter=true
  echo "work-order adapter: binary=$node_binary argv=$work_order_binary config=$work_order_config_ref spool=$work_order_spool_ref" >&2
fi

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

printf '{"room":"%s","server_url":"%s","public_url":"%s","mode":"%s","plan_key":"%s","phases":%s,"added_exclude":%s,"lattice_preexisting":%s,"runtime_preexisting":%s,"added_runtime_exclude":%s,"added_root_mcp":%s,"added_mcp_exclude":%s,"external_pane":%s,"project_json_preexisting":%s,"work_order_adapter":%s,"work_order_spool_ref":"%s"}\n' \
  "$room" "$url" "$public_url" "$mode" "$plan" "$phases_json" "$added_exclude" "$lattice_preexisting" "$runtime_preexisting" "$added_runtime_exclude" "$added_root_mcp" "$added_mcp_exclude" "$external_pane" "$project_json_preexisting" "$work_order_adapter" "$work_order_spool_ref" > "$tdir/setup-state.json"
echo "scaffold done: $tdir"
