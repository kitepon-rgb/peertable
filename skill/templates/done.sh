#!/bin/bash
# usage: .team/scripts/done.sh <task_id>
# evidence/<plan_key>/<task_id>.md（commit 済みであること）から記述子を作り lattice todo done を実行する。
# plan key は環境変数 PEERTABLE_PLAN から取る。
# 証跡を plan key で仕切るのは、task_id が campaign を跨いで再利用される（t1, t2, …）ため。
# 平置きだと次の campaign の t1 が前の campaign の t1 の監査証跡を上書きで消す（2026-08-08 実測）。
set -e
t="$1"
f="evidence/$PEERTABLE_PLAN/$t.md"
oid=$(git hash-object -w "$f")
digest=$(shasum -a 256 "$f" | cut -d' ' -f1)
# 記述子は repo 内の相対パスに置く（repo 外の絶対パスは --evidence が INVALID_ARGUMENTS で弾く）
tmp=".ev-$t.json"
printf '{"evidence_id":"ev-%s","repo_id":"self","path":"%s","git_blob_oid":"%s","content_digest":"%s","media_type":"text/markdown","anchor_digest":null}\n' "$t" "$f" "$oid" "$digest" > "$tmp"
lattice todo done --plan "$PEERTABLE_PLAN" --task "$t" --evidence "$tmp"
rm -f "$tmp"

# 完了の定義は「repo 内の変更は push まで」。done を打つ瞬間はそれが成り立っていなければ
# ならない唯一の時点で、かつ全員が必ず通る場所である。publish 経路の機械 gate は tarball
# しか見ないので、docs・証跡・experiments はその外側にある——黙ると誰も見ていない場所へ
# 成果物が取り残される（2026-08-08 実測。卓の全員が立っていた穴で、親の監査が見つけた）。
# 出すだけで止めない: push 既定でない repo も、まとめて push する運用も壊さないため。
# upstream 未設定・git 管理外でも done.sh 自体は死なせない（set -e の下なので必ずガードする）。
unpushed=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || true)
if [ -n "$unpushed" ] && [ "$unpushed" != 0 ]; then
  echo "未push ${unpushed}本: この done の成果物はまだ upstream へ着地していない" >&2
fi

# 外部ペインの喪失検出。Lattice 併用モードの卓は、公開工程表の右ペインに円卓が出ているのが正常。
# 2026-08-08、受入検証が本番のコネクタを「外して痕跡ゼロ」まで確かめて終わり、差し直しが人の記憶
# 頼みで漏れて、公開工程表から円卓が消えたままになった（オーナー発見）。**外したことは誰も間違えて
# いない——戻し忘れを誰も見ていなかった**ので、全員が必ず通る done の一点で見る。
# 未push 警告と同じ作法: 出すだけで止めない・読めない時は黙って継続する（この警告のために done.sh を殺さない）。
pane_missing=$(python3 - <<'PY' 2>/dev/null || true
import json
try:
    state = json.load(open('.team/setup-state.json'))
except Exception:
    raise SystemExit          # 卓が無い/読めない＝判定しない
if state.get('mode') != 'lattice':
    raise SystemExit          # 単独円卓モードには工程表が無い
try:
    identity = json.load(open('.lattice/project.json'))
except Exception:
    identity = {}
if not identity.get('external_pane'):
    print('yes')
PY
)
if [ "$pane_missing" = yes ]; then
  echo "外部ペイン未設置: 公開工程表に円卓が出ていない（差し直す: node <skill>/scripts/external-pane.mjs . <room> <public_base>）" >&2
fi
