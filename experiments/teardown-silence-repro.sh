#!/bin/bash
# teardown.sh の「黙って中断する」欠陥の再現ハーネス（refit-20260808 t6）。
#
# usage: teardown-silence-repro.sh [<teardown.sh へのpath>]
#   既定は skill/scripts/teardown.sh（修正版）。第1引数で旧版を指すと負のコントロールになる:
#     git show <旧commit>:skill/scripts/teardown.sh > /tmp/old.sh
#     experiments/teardown-silence-repro.sh /tmp/old.sh   # → 4ケース中3つが「無言・残存あり」で落ちる
#
# 欠陥（修正前）: `curl -sf` が非2xx/不達で非ゼロ終了し、`set -e` が**何も出力せずに**script を止める。
# 結果、room 削除より後の撤去段（.team/.mcp.json/exclude/.lattice）が全て未実行のまま残る。
# 使い捨ての project と使い捨ての room server だけを使う。本番にも他の席にも触らない。
set -u
TD="${1:-skill/scripts/teardown.sh}"
PORT=${PORT:-8802}
TOKEN=t6repro
WORK=$(mktemp -d)
trap 'kill $SRV 2>/dev/null; rm -rf "$WORK"' EXIT

PEERTABLE_POST_TOKEN=$TOKEN PEERTABLE_PORT=$PORT PEERTABLE_DATA="$WORK/data" node room/server.mjs 2>/dev/null &
SRV=$!
disown $SRV 2>/dev/null || true
for _ in $(seq 20); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.2; done

mkproj() { # <dir> <room>
  rm -rf "$1"; mkdir -p "$1"; ( cd "$1" && git init -q . && mkdir -p .team .lattice )
  printf '{"room":"%s","server_url":"http://localhost:%s","added_exclude":true,"lattice_preexisting":false,"added_root_mcp":true,"added_mcp_exclude":true,"external_pane":false,"project_json_preexisting":false}\n' "$2" "$PORT" > "$1/.team/setup-state.json"
  echo '{}' > "$1/.mcp.json"
  printf '.team/\n/.mcp.json\n' >> "$1/.git/info/exclude"
}
residue() { # 撤去し残しがあるか
  [ -d "$1/.team" ] || [ -f "$1/.mcp.json" ] || [ -d "$1/.lattice" ] || grep -q 'team/\|mcp\.json' "$1/.git/info/exclude"
}

pass=0; fail=0
check() { # <名前> <期待exit> <dir> <出力>
  local name=$1 want=$2 dir=$3 out=$4 ok=1
  [ "$RC" = "$want" ] || ok=0
  [ -n "$out" ] || ok=0                 # 無言で終わらないこと（これが本体の欠陥）
  residue "$dir" && ok=0                # 撤去し残しゼロ
  if [ $ok = 1 ]; then echo "  pass  $name"; pass=$((pass+1)); else
    echo "  FAIL  $name (exit=$RC 期待=$want / 出力$( [ -n "$out" ] && echo あり || echo なし) / 残存$( residue "$dir" && echo あり || echo なし))"; fail=$((fail+1)); fi
}

echo "対象: $TD"
curl -s -X POST "http://localhost:$PORT/api/r1/members" -H "X-Peertable-Token: $TOKEN" -d '{"name":"d"}' >/dev/null
mkproj "$WORK/p1" r1
OUT=$(env -u PEERTABLE_POST_TOKEN bash "$TD" "$WORK/p1" 2>&1); RC=$?
check "token 空 → 報告して残りを撤去し非ゼロ" 1 "$WORK/p1" "$OUT"

mkproj "$WORK/p2" r2
OUT=$(PEERTABLE_POST_TOKEN=wrong bash "$TD" "$WORK/p2" 2>&1); RC=$?
check "token 誤り(403) → 同上" 1 "$WORK/p2" "$OUT"

mkproj "$WORK/p3" r3
sed -i.bak "s|http://localhost:$PORT|http://localhost:9|" "$WORK/p3/.team/setup-state.json"
OUT=$(PEERTABLE_POST_TOKEN=$TOKEN bash "$TD" "$WORK/p3" 2>&1); RC=$?
check "server 不達(000) → 同上" 1 "$WORK/p3" "$OUT"

curl -s -X POST "http://localhost:$PORT/api/r4/members" -H "X-Peertable-Token: $TOKEN" -d '{"name":"d"}' >/dev/null
mkproj "$WORK/p4" r4
OUT=$(PEERTABLE_POST_TOKEN=$TOKEN bash "$TD" "$WORK/p4" 2>&1); RC=$?
check "正常 → 完走して exit 0" 0 "$WORK/p4" "$OUT"

echo "pass=$pass fail=$fail"
[ $fail = 0 ]
