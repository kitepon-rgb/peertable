#!/bin/bash
# 席を1つ立てる（tmux 作成 → env 注入 → エージェント起動 → 既知ダイアログ通過 → 着席確認）。
# usage: launch-seat.sh <project_dir> <name> <model> [vendor] [effort] [brief]
#   vendor: claude（既定）/ codex
#   brief:  着席が成立したら送る着任指示（省略時は送らない）
#
# room 名・server URL・モード・plan key は <project>/.team/setup-state.json から読む（setup.sh の後に呼ぶ）。
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN、無ければ ~/.config/peertable.env から取る。
# tmux は aiterm-mcp と同じソケットへ作るので、立てた席はそのまま pty_read / pty_send で読める。
set -e
proj="$1"; name="$2"; model="$3"; vendor="${4:-claude}"; effort="$5"; brief="$6"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$model" ] || { echo "usage: launch-seat.sh <project_dir> <name> <model> [vendor] [effort] [brief]" >&2; exit 1; }

sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR}claude-tmux-sockets/claude.sock}"
sess="peer-$name"
state="$proj/.team/setup-state.json"
read -r room url mode plan <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'],d['mode'],d.get('plan_key') or '-')")
EOF
# setup が解決した CLI の実 path。**席が PATH の `lattice` へ逸れないため**に渡す
# （release 前の source tree では、PATH の install は pull 系 command を持たない）。
# 無い卓（旧 setup-state）では空になり、席は既定どおり `lattice` を使う。
lattice_cli=$(python3 -c "import json;print(json.load(open('$state')).get('lattice_cli') or '')")

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

# 前の卓の残骸を回収してから立てる（同名セッションが残ると起動が黙って古い席に化ける）
tmux -S "$sock" kill-session -t "$sess" 2>/dev/null || true

# 素性記録（.team/seats/<name>.json）の掃除は**ここ**でやる。席を起こす経路は全席が必ず通るので、
# 死んだ記録がここで必ず消える（ADR 0157）。teardown や人が叩くコマンドに置くと、誰も叩かず溜まる。
# **消すのは同名の自分の分だけ**——`peer-*` を一括で消すと同じマシンの別卓を巻き込む。
rm -f "$proj/.team/seats/$name.json"
tmux -S "$sock" new-session -d -s "$sess" -x 200 -y 50 -c "$proj"

# 素性は席の env にも入れる。client が**登録のたびに**載せるので、member の状態が失われても戻る
env_line="export PEERTABLE_URL=$url PEERTABLE_ROOM=$room PEERTABLE_MEMBER=$name PEERTABLE_POST_TOKEN=$PEERTABLE_POST_TOKEN"
env_line="$env_line PEERTABLE_VENDOR=$vendor PEERTABLE_MODEL=$model"
[ -n "$effort" ] && env_line="$env_line PEERTABLE_EFFORT=$effort"
if [ "$mode" = "lattice" ]; then
  env_line="$env_line PEERTABLE_PLAN=$plan LATTICE_TODO_ACTOR_HOST=${LATTICE_TODO_ACTOR_HOST:-mac} LATTICE_TODO_ACTOR_SESSION=$name LATTICE_TODO_ACTOR_AGENT=$name"
  [ -n "$lattice_cli" ] && env_line="$env_line LATTICE_CLI=$lattice_cli"
fi
tmux -S "$sock" send-keys -t "$sess" "$env_line" Enter
sleep 1

case "$vendor" in
  claude)
    cmd="claude --model $model"
    [ -n "$effort" ] && cmd="$cmd --effort $effort"
    cmd="$cmd --dangerously-skip-permissions --dangerously-load-development-channels server:room"
    ;;
  codex)
    # Codex には channels が無いので room は stdio MCP として差す。
    # `[mcp_servers.X.env]` は closed mode（親 env を継がない）ので全変数を明示列挙する
    # （caveat `codex-cli-v0-130-0-mcp-servers-x-env-block-is-closed-mode-parent-env-not-inherited`）。
    envtbl="PATH=\\\"$PATH\\\",PEERTABLE_URL=\\\"$url\\\",PEERTABLE_ROOM=\\\"$room\\\",PEERTABLE_MEMBER=\\\"$name\\\",PEERTABLE_POST_TOKEN=\\\"$PEERTABLE_POST_TOKEN\\\""
    cmd="codex --model $model -C $proj --dangerously-bypass-approvals-and-sandbox"
    # Codexのeffortは環境変数だけでは適用されない。member metadataへ表示する値と、
    # 実際の推論設定を同じ引数から渡して食い違わせない。
    [ -n "$effort" ] && cmd="$cmd -c 'model_reasoning_effort=\"$effort\"'"
    cmd="$cmd -c 'mcp_servers.room.command=\"peertable-client\"'"
    cmd="$cmd -c \"mcp_servers.room.env={$envtbl}\""
    ;;
  # 変数展開の直後に全角括弧を置かない（bash が高位バイトを変数名の一部として食い、
  # 変数が空になって黙って情報が消える。2026-08-08 実測）。必ず ${var} で閉じる
  *) echo "unknown vendor: ${vendor}（claude / codex）" >&2; exit 1 ;;
esac
tmux -S "$sock" send-keys -t "$sess" "$cmd" Enter

# 既知ダイアログ（実測 2026-08-08・Claude Code v2.1.226 / Codex CLI v0.146.0）:
#   claude ① 未信頼ディレクトリの workspace trust「1. Yes, I trust this folder」
#          ② 開発 channel 警告「1. I am using this for local development」
#   codex  ① ディレクトリ trust「1. Yes, continue」
# いずれも既定の選択肢が正なので、文言を確認してから Enter を送る。信頼済みディレクトリでは
# trust が出ないので、出た時だけ通す（順不同・出ないものは待たない）。
# 着席の判定は claude=channels バナー / codex=セッションヘッダ。出なければ画面ごと出して落ちる。
deadline=$((SECONDS + 90))
seated=false
while [ $SECONDS -lt $deadline ]; do
  screen=$(tmux -S "$sock" capture-pane -t "$sess" -p)
  if [ "$vendor" = "claude" ]; then
    case "$screen" in *"Channels (experimental)"*"server:room"*) seated=true; break ;; esac
  else
    case "$screen" in *"OpenAI Codex (v"*) seated=true; break ;; esac
  fi
  case "$screen" in
    # Codex の更新案内だけは既定（1. Update now）が誤り——立卓の途中で
    # `npm install -g @openai/codex` が走る。1つ下の「2. Skip」を選ぶ
    *"1. Update now"*)
      tmux -S "$sock" send-keys -t "$sess" Down
      sleep 1
      tmux -S "$sock" send-keys -t "$sess" Enter ;;
    *"1. Yes, I trust this folder"*|*"1. I am using this for local development"*|*"1. Yes, continue"*)
      tmux -S "$sock" send-keys -t "$sess" Enter ;;
  esac
  sleep 2
done

if [ "$seated" != "true" ]; then
  echo "着席しなかった: ${sess}（最後の画面を出す）" >&2
  tmux -S "$sock" capture-pane -t "$sess" -p >&2
  exit 1
fi

echo "seated: ${sess}（${vendor} / ${model}${effort:+ / $effort} / room=${room} / mode=${mode}）"

# 席の素性を `.team/seats/<name>.json` へ置く。**席が自分の pid を知るための唯一の経路**である
# （Lattice の `run intake attach` は expected identity を要求し、pid を推定しない）。
# 着席の**後**に取る——起動途中の process を掴むと、ダイアログ通過で子が入れ替わりうる。
#
# 持たせるのは6欄だけで、**`lattice.pull_worker_attach_input.v1` の exact 集合から `schema` を
# 除いたもの**と一致する。席は読んで `schema` を被せるだけで attach input になる（変換不要）。
# **raw argv を持たせない**——Codex 起動の argv には `PEERTABLE_POST_TOKEN` が載るので、
# 保存すれば秘密の複製になる（2026-08-09 実測）。digest だけを持つ。
# この file が主張するのは「この pid はこの席だった」という**識別**であって、生死ではない。
# 生きているかは attach する側（Lattice）が lstart+argv の再観測で確かめる。
seat_pid=""
pane_pid=$(tmux -S "$sock" list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1 || true)
if [ -n "$pane_pid" ]; then
  # pane の子で pid===pgid のものが席本体。pane_pid（shell）を渡すと Lattice の直接 OS 観測が
  # 「worker process group を無関係 process と共有している」で正しく落ちる。
  # **1件でなければ推測で選ばない**（run-bridge.mjs の seatWorkerPid と同じ規律）。
  leaders=$(ps -Ao pid=,ppid=,pgid= | awk -v p="$pane_pid" '$2==p && $1==$3 {print $1}')
  if [ "$(printf '%s\n' "$leaders" | grep -c .)" = "1" ]; then seat_pid=$(printf '%s' "$leaders" | tr -d ' \n'); fi
fi
if [ -z "$seat_pid" ]; then
  # 記録が無ければ席は attach できず、装置の介入は協調 hold のままになる。**黙らない。**
  echo "seat identity を記録できなかった: ${sess} の process group leader を1つに確定できない（席は着席済み）" >&2
else
  mkdir -p "$proj/.team/seats"
  # **`session` に tmux 名（`peer-<name>`）を入れてはいけない。** Lattice の attach は
  # `input.session === actor.session` を要求し（`runtime-pull-intake.mjs:674`）、actor session は
  # 上の env_line が入れる `LATTICE_TODO_ACTOR_SESSION=$name` である。tmux 識別子を混ぜると
  # attach が必ず `WORKER_ACTOR_MISMATCH` で拒否される（mio の監査で発覚・room [937]）。
  if ! python3 - "$proj/.team/seats/$name.json" "$name" "$name" "$seat_pid" <<'PY'
import hashlib, json, os, subprocess, sys, tempfile
out, name, session, pid = sys.argv[1:5]
pid = int(pid)
started = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)],
                         capture_output=True, text=True, check=True).stdout.strip()
argv = subprocess.run(['/bin/ps', '-o', 'args=', '-p', str(pid)],
                      capture_output=True, text=True, check=True).stdout.strip()
if not started or not argv:
    sys.exit('pid の lstart/args を観測できない')
record = {
    'argv_digest': hashlib.sha256(argv.encode()).hexdigest(),
    'name': name,
    'pid': pid,
    'recorded_at': subprocess.run(['date', '-u', '+%Y-%m-%dT%H:%M:%S.000Z'],
                                  capture_output=True, text=True, check=True).stdout.strip(),
    'session': session,
    'started_identity': started,
}
# canonical JSON（key 昇順・空白なし）＋ 0600 ＋ 一時file→fsync→rename で原子的に置く。
# 着席直後に席が読むので、部分読取が起きない形にする。
body = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix='.seat-', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, out)
except BaseException:
    os.unlink(tmp)
    raise
PY
  then
    echo "seat identity を記録できなかった: ${sess}（席は着席済み・attach は協調 hold のままになる）" >&2
  fi
fi

# 席の素性（vendor / model / effort）を room へ渡す。参加者一覧のホバー表示に使う。
# 席自身の client も起動時に `{name}` だけで登録するので、server 側は
# **欄が無い登録で既存の素性を消さない**（upsert）ことが前提である。
# effort は渡された時だけ入れる——欄が無い＝「不明」ではなく「CLI 既定で走っている」。
# ここが失敗しても席は着席済みなので落とさない。ただし黙っては飲まない。
meta=$(python3 - "$name" "$vendor" "$model" "$effort" <<'PY'
import json, sys
name, vendor, model, effort = sys.argv[1:5]
body = {'name': name, 'vendor': vendor, 'model': model}
if effort:
    body['effort'] = effort
print(json.dumps(body))
PY
)
if curl -sf -o /dev/null -X POST "$url/api/$room/members" \
    -H "X-Peertable-Token: ${PEERTABLE_POST_TOKEN:-}" -H 'content-type: application/json' -d "$meta"; then
  # **200 は保存の証拠にならない**。素性欄を知らない server も 200 {"ok":true} を返して黙って捨てる
  # （登録が `if (!members.has(name))` の no-op になる経路もある）。読み返して実際に載ったかを見る。
  # **パイプと heredoc を同じ stdin へ重ねない**。`curl | python3 - <<'PY'` は
  # 「プログラムを stdin から読む」と「データを stdin から読む」が衝突して、必ず失敗する
  # （そして try/except で包むと、失敗が「保存されていない」という**もっともらしい答え**に化ける。実測）
  listing=$(curl -sf "$url/api/$room/members" || true)
  stored=$(python3 - "$name" "$listing" <<'PY'
import json, sys
# 読み返しに失敗しても生の traceback を出さない。ここは「保存されたか」を見るだけの確認段で、
# 判定不能は「保存されていない」と同じ扱いでよい（席は既に着席している）
try:
    members = json.loads(sys.argv[2])['members']
except Exception:
    members = []
m = next((x for x in members if x.get('name') == sys.argv[1]), {})
print('yes' if m.get('model') else 'no')
PY
)
  if [ "$stored" = yes ]; then
    echo "metadata: ${vendor} / ${model}${effort:+ / $effort}"
  else
    echo "metadata は保存されなかった: この room サーバーは素性欄を持たない版（席は着席済み・一覧に素性が出ないだけ）" >&2
  fi
else
  echo "metadata の登録に失敗した: 席は着席済みで、参加者一覧に素性が出ないだけ（room の到達性とトークンを確認）" >&2
fi

if [ -n "$brief" ]; then
  sleep 2
  tmux -S "$sock" send-keys -t "$sess" "$brief"
  sleep 1
  tmux -S "$sock" send-keys -t "$sess" Enter
  echo "briefed: $sess"
fi
