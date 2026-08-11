// launch-seat.sh の brief 輸送と turn 開始観測の再現ハーネス（h2）。
//
// 欠陥版は長い brief を tmux send-keys の一引数へ載せるため、輸送上限で落ちる。
// しかもその時点では preflight・tmux 着席・metadata・bridge 起動が済んでいる。
// 修正版は着席前に byte 上限を拒否し、受理した長文は tmux buffer 経由で送り、
// `esc to interrupt` の画面遷移を turn 開始の実測として確認する。
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const LAUNCH = join(REPO, 'skill/scripts/launch-seat.sh')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const root = await mkdtemp(join(tmpdir(), 'peertable-launch-brief-'))
const project = join(root, 'project')
const bin = join(root, 'bin')
const tmuxSocket = join(root, 'tmux.sock')
const tmuxLog = join(root, 'tmux.log')
const claudeLog = join(root, 'claude.log')
const briefPasted = join(root, 'brief-pasted')
const submitMarker = join(root, 'brief-submitted')
const legacyLaunch = join(root, 'launch-seat-legacy.sh')
const fixedLaunch = join(root, 'launch-seat-fixed.sh')
const longBrief = 'brief-' + 'x'.repeat(12_000)

await mkdir(join(project, '.team', 'seats'), { recursive: true })
await mkdir(bin)
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({
  room: 'fixture', server_url: 'http://127.0.0.1:1', mode: 'team', plan_key: null,
}) + '\n')

await writeFile(tmuxLog, '')
await writeFile(claudeLog, '')
await writeFile(join(root, 'tmux-socket.mjs'),
  "process.stdout.write(process.env.PEERTABLE_TMUX_SOCKET || '')\n")
await writeFile(join(root, 'ensure-bridge.sh'), '#!/bin/bash\nexit 0\n')
await chmod(join(root, 'ensure-bridge.sh'), 0o755)
await writeFile(join(root, '.zshrc'),
  'export PATH=' + bin + ':$PATH\nexport SUBMIT_MARKER=' + submitMarker + '\n')

// 長い send-keys だけを旧版の失敗として再現し、それ以外は実 tmux へ渡す。
await writeFile(join(bin, 'tmux'), `#!/bin/bash
real_tmux=${JSON.stringify(realTmux)}
for arg in "$@"; do
  if [ "\$arg" = "send-keys" ]; then
    for value in "$@"; do
      if [ \${#value} -gt 8192 ]; then
        echo "command too long" >&2
        exit 1
      fi
    done
    break
  fi
done
has_paste=false
has_enter=false
for arg in "$@"; do
  [ "$arg" = "paste-buffer" ] && has_paste=true
  [ "$arg" = "Enter" ] && has_enter=true
done
if [ "$has_paste" = true ]; then : > "$BRIEF_PASTED"; fi
if [ "$has_enter" = true ] && [ -f "$BRIEF_PASTED" ]; then : > "$SUBMIT_MARKER"; fi
printf '%s\\n' "$*" >> "\$TMUX_LOG"
exec "\$real_tmux" "$@"
`)

// preflight は成功し、対話起動後は banner を出して brief を受ける fake CLI。
await writeFile(join(bin, 'claude'), `#!/bin/bash
printf '%s\\n' "$*" >> "\$CLAUDE_LOG"
for arg in "$@"; do
  [ "\$arg" = "-p" ] && { echo pong; exit 0; }
done
printf 'Channels (experimental) server:room\\n'
stty -echo
trap 'stty echo' EXIT
while [ ! -f "\$SUBMIT_MARKER" ]; do sleep 0.05; done
  printf 'esc to interrupt\\n'
  printf 'turn started\\n'
while :; do sleep 1; done
`)

// metadata の POST/GET だけを成立させる。room server そのものは対象外。
await writeFile(join(bin, 'curl'), `#!/bin/bash
case " \$* " in
  *" -X POST "*) exit 0 ;;
  *) printf '%s\\n' '{"members":[{"name":"fixture-seat","model":"opus","observe":{"tmux_target":"peer-fixture-seat"}}]}' ;;
esac
`)
await Promise.all(['tmux', 'claude', 'curl'].map((name) => chmod(join(bin, name), 0o755)))

const source = await readFile(LAUNCH, 'utf8')
await writeFile(fixedLaunch, source)
await chmod(fixedLaunch, 0o755)
// 欠陥版の brief block を明示的に再構成する。修正版の負例が将来の HEAD に依存しない。
const legacyBrief = `if [ -n "$brief" ]; then
  sleep 2
  tmux -S "$sock" send-keys -t "$sess" "$brief"
  sleep 1
  tmux -S "$sock" send-keys -t "$sess" Enter
  echo "briefed: $sess"
fi`
const currentBrief = `if [ -n "$brief" ]; then`
const currentBriefStart = source.indexOf(currentBrief, source.indexOf('ensure-bridge'))
assert.notEqual(currentBriefStart, -1, '修正版の brief block が見つかる')
const briefEndMarker = '  echo "briefed: $sess"\nfi'
const legacyEnd = source.indexOf(briefEndMarker, currentBriefStart) + briefEndMarker.length
assert.ok(legacyEnd > currentBriefStart, '修正版の brief block 終端が見つかる')
await writeFile(legacyLaunch, source.slice(0, currentBriefStart) + legacyBrief + source.slice(legacyEnd))
await chmod(legacyLaunch, 0o755)

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_POST_TOKEN: 'test-token',
  PEERTABLE_TMUX_SOCKET: tmuxSocket,
  TMUX_LOG: tmuxLog,
  CLAUDE_LOG: claudeLog,
  BRIEF_PASTED: briefPasted,
  SUBMIT_MARKER: submitMarker,
  TMPDIR: root,
  NODE_DISABLE_COMPILE_CACHE: '1',
  HOME: root,
  ZDOTDIR: root,
}
const run = (script, brief = longBrief) => spawnSync(script,
  [project, 'fixture-seat', 'opus', 'claude', 'high', brief],
  { env, encoding: 'utf8', timeout: 60_000 })
const log = async () => (await readFile(tmuxLog, 'utf8')).trim().split('\n').filter(Boolean)
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }

try {
  // 1. 欠陥版は同じ長い brief を tmux へ渡せず、しかし着席副作用を残す。
  let result = run(legacyLaunch)
  check('欠陥版は長い brief の tmux 輸送で落ちる', () => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /command too long|LAUNCH_BRIEF_SEND_FAILED/)
  })
  const legacyCalls = await log()
  check('欠陥版は輸送失敗前に tmux 着席副作用を残す', () => {
    assert.ok(legacyCalls.some((line) => line.includes('new-session')))
  })

  // 次の試行の既存セッションを消し、修正版の測定を独立させる。
  spawnSync(realTmux, ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
  await writeFile(tmuxLog, '')

  // 2. 修正版は同じ長文を file buffer で送り、turn marker まで観測して完了する。
  result = run(fixedLaunch)
  const fixedCalls = await log()
  const fixedScreen = spawnSync(realTmux,
    ['-S', tmuxSocket, 'capture-pane', '-t', 'peer-fixture-seat', '-p'],
    { encoding: 'utf8' }).stdout
  check('修正版は同じ長い brief を受理して turn 開始まで観測する', () => {
    assert.equal(result.status, 0,
      result.stderr + '\nstdout=' + result.stdout + '\ncalls='
      + JSON.stringify(fixedCalls) + '\nscreen=' + fixedScreen)
    assert.match(result.stdout, /briefed: peer-fixture-seat/)
  })
  check('修正版は brief 本文を tmux の一引数へ載せない', () => {
    assert.ok(fixedCalls.some((line) => line.includes('load-buffer')))
    assert.ok(fixedCalls.some((line) => line.includes('paste-buffer')))
    assert.ok(!fixedCalls.some((line) => line.includes(longBrief)))
  })

  // 3. 上限超過は着席前に typed reject し、副作用をゼロにする。
  spawnSync(realTmux, ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
  await writeFile(tmuxLog, '')
  await writeFile(claudeLog, '')
  await rm(join(project, '.team/seats/fixture-seat.json'), { force: true })
  const tooLong = run(fixedLaunch, 'z'.repeat(65_537))
  const tooLongClaudeCalls = await readFile(claudeLog, 'utf8')
  check('上限超過の brief は副作用なしで typed reject する', () => {
    assert.equal(tooLong.status, 2,
      tooLong.stderr + '\nstdout=' + tooLong.stdout + '\nclaude=' + tooLongClaudeCalls)
    assert.match(tooLong.stderr, /LAUNCH_BRIEF_TOO_LONG/)
    assert.equal(existsSync(join(project, '.team/seats/fixture-seat.json')), false)
    assert.equal(tooLongClaudeCalls, '')
  })
  assert.equal((await log()).length, 0)

  console.log(`launch-brief repro: ${checks}/${checks} green`)
} finally {
  spawnSync(realTmux, ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
  await rm(root, { recursive: true, force: true })
}
