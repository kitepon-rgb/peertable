// 席起動時の model liveness 再現ハーネス（f3）。
//
// 罠: `launch-seat.sh` の着席判定は tmux pane の**画面文字列**（Claude=channels バナー /
// Codex=セッションヘッダ）だけを見る。2026-08-11 実測では、fable-5 の席はバナーが出たので
// `seated:` を出して成功終了したが、その後の入力は全て model unavailable で 0 秒失敗し、
// 席は一度も仕事をしなかった（room [11]）。**利用不能な席が成功として卓へ載る**。
//
// 直し方: 席を畳む前に、非対話入口（claude -p / codex exec）で model が実際に応答するかを測る。
// 落ちたら席を立てない＝**動いている旧席も殺さない**。この harness はその契約を測る。
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const root = await mkdtemp(join(tmpdir(), 'peertable-seat-liveness-'))
const project = join(root, 'project')
const bin = join(root, 'bin')
const tmuxLog = join(root, 'tmux.log')
const deadModels = join(root, 'dead-models')

await mkdir(join(project, '.team'), { recursive: true })
await mkdir(bin)
await mkdir(join(root, '.config'))
await writeFile(join(root, '.config/peertable.env'), 'export PEERTABLE_POST_TOKEN=fixture-token\n')
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({
  room: 'fixture', server_url: 'http://127.0.0.1:1', mode: 'team', plan_key: null,
  added_root_mcp: true,
}) + '\n')
await writeFile(join(project, '.mcp.json'), JSON.stringify({
  mcpServers: { room: { command: 'peertable-client', args: [] } },
}) + '\n')

// tmux は「呼ばれたこと」だけ記録する。preflight で落ちる契約なら、そもそも1行も出ないはず。
await writeFile(join(bin, 'tmux'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TMUX_LOG"
case " $* " in
  *" capture-pane "*) printf 'Channels (experimental) server:room\\n' ;;
  *" display-message "*) printf 'fixture\\n' ;;
  *" list-panes "*) printf '\\n' ;;
esac
exit 0
`)
// DEAD_MODELS に載っている model は、非対話入口だけ失敗する＝**対話起動は成功して画面には
// バナーが出る**。これが実際に踏んだ形（画面は正常・実応答は不能）である。
const stub = (nonInteractiveFlag, deadMessage) => `#!/bin/bash
model=""
nonint=false
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  [ "\${args[$i]}" = "--model" ] && model="\${args[$((i+1))]}"
  [ "\${args[$i]}" = "${nonInteractiveFlag}" ] && nonint=true
done
if [ "$nonint" = true ]; then
  if grep -qx "$model" "$DEAD_MODELS" 2>/dev/null; then
    echo "${deadMessage}: $model" >&2; exit 1
  fi
  echo ok; exit 0
fi
exit 0
`
await writeFile(join(bin, 'claude'), stub('-p', 'model unavailable'))
await writeFile(join(bin, 'codex'), stub('exec', 'ERROR: model is not supported'))
await Promise.all(['tmux', 'claude', 'codex'].map(name => chmod(join(bin, name), 0o755)))
await writeFile(deadModels, 'fable-5\ngpt-9-nonexistent\n')

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HOME: root,
  TMUX_LOG: tmuxLog,
  DEAD_MODELS: deadModels,
}
const launch = (model, vendor, effort = 'high') => spawnSync(
  join(REPO, 'skill/scripts/launch-seat.sh'),
  [project, 'fixture-seat', '実装', '--model', model, '--vendor', vendor, '--effort', effort],
  { env, encoding: 'utf8', timeout: 60_000 },
)
const tmuxCalls = async () => {
  if (!existsSync(tmuxLog)) return []
  return (await readFile(tmuxLog, 'utf8')).trim().split('\n').filter(Boolean)
}
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  // 1. live で使えない model は、seated 成功にならない
  let result = launch('fable-5', 'claude')
  check('live で使えない claude model は seated 成功にならない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /model が live で使えない: claude \/ fable-5/)
    assert.doesNotMatch(result.stdout, /seated:/)
  })

  // 2. **既存の席を殺す前に**落ちる（tmux を一度も触っていない）
  const afterDeadClaude = await tmuxCalls()
  check('落ちる時は tmux を触らない（動いている旧席を殺さない）', () => {
    assert.deepEqual(afterDeadClaude, [], 'preflight 失敗時に tmux 呼び出しが1件も無い')
  })

  // 3. codex 側も同じ契約
  result = launch('gpt-9-nonexistent', 'codex')
  check('live で使えない codex model も seated 成功にならない', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /model が live で使えない: codex \/ gpt-9-nonexistent/)
  })
  assert.deepEqual(await tmuxCalls(), [], 'codex 側も tmux を触らずに落ちる')

  // 4. 応答する model では preflight を通過して起動シーケンスへ進む
  result = launch('opus', 'claude')
  const calls = await tmuxCalls()
  const roomMcp = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')).mcpServers.room
  check('応答する model では preflight を通り、起動シーケンスへ進む', () => {
    assert.ok(calls.length > 0, 'tmux 呼び出しが始まっている')
    assert.ok(calls.some(line => line.includes('new-session')), 'session を作っている')
    assert.ok(calls.some(line => line.includes('PEERTABLE_POST_TOKEN=')), 'new sessionでtmux global tokenを空上書きしている')
    assert.doesNotMatch(result.stderr, /model が live で使えない/)
    assert.equal(roomMcp.command, 'node')
    assert.equal(roomMcp.args[0], join(REPO, 'room/client.mjs'))
  })

  console.log(`seat-model-liveness repro: ${checks}/${checks} green`)
} finally {
  await rm(root, { recursive: true, force: true })
}
