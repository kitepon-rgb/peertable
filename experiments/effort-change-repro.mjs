import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const root = await mkdtemp(join(tmpdir(), 'peertable-effort-change-'))
const project = join(root, 'project')
const scripts = join(root, 'scripts')
const bin = join(root, 'bin')
const data = join(root, 'data')
const screen = join(root, 'screen.txt')
const launchLog = join(root, 'launch.log')
const failOnce = join(root, 'fail-once')
const port = 19100 + Math.floor(Math.random() * 500)
const base = `http://127.0.0.1:${port}`
const token = 'test-token'

await Promise.all([mkdir(join(project, '.team'), { recursive: true }), mkdir(scripts), mkdir(bin), mkdir(data)])
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({ room: 'fixture', server_url: base }) + '\n')
await cp(join(REPO, 'skill/scripts/change-effort.sh'), join(scripts, 'change-effort.sh'))
await chmod(join(scripts, 'change-effort.sh'), 0o755)
await writeFile(screen, 'idle\n')

await writeFile(join(bin, 'tmux'), `#!/bin/bash
case " $* " in
  *" has-session "*) exit 0 ;;
  *" capture-pane "*) cat "$FAKE_SCREEN"; exit 0 ;;
esac
exit 1
`)
await writeFile(join(bin, 'codex'), `#!/bin/bash
if [ "$1 $2" = "debug models" ]; then
  printf '%s\n' '{"models":[{"slug":"gpt-5.6-sol","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"ultra"}]}]}'
  exit 0
fi
exit 1
`)
await writeFile(join(scripts, 'launch-seat.sh'), `#!/bin/bash
printf '%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$LAUNCH_LOG"
if [ -f "$FAIL_ONCE" ] && [ "$5" = "high" ]; then rm -f "$FAIL_ONCE"; exit 9; fi
payload=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"vendor":sys.argv[2],"model":sys.argv[3],"effort":sys.argv[4]}))' "$2" "$4" "$3" "$5")
curl -sf -o /dev/null -X POST "$PEERTABLE_URL/api/fixture/members" -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' -d "$payload"
`)
await Promise.all(['tmux', 'codex'].map(name => chmod(join(bin, name), 0o755)))
await chmod(join(scripts, 'launch-seat.sh'), 0o755)

const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: {
    ...process.env,
    PEERTABLE_PORT: String(port),
    PEERTABLE_DATA: data,
    PEERTABLE_POST_TOKEN: token,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_POST_TOKEN: token,
  PEERTABLE_URL: base,
  PEERTABLE_TMUX_SOCKET: join(root, 'tmux.sock'),
  FAKE_SCREEN: screen,
  LAUNCH_LOG: launchLog,
  FAIL_ONCE: failOnce,
}

const api = async (path, init) => {
  const res = await fetch(`${base}/api/fixture/${path}`, init)
  assert.ok(res.ok, `${path}: HTTP ${res.status}`)
  return res.json()
}
let ready = false
for (let i = 0; i < 50; i++) {
  try { await api('members'); ready = true; break } catch { await new Promise(r => setTimeout(r, 40)) }
}
assert.equal(ready, true, 'fixture room serverが起動する')
const member = body => api('members', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify({ name: 'koharu', ...body }),
})
const request = effort => api('messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify({ from: 'koharu', to: 'bell', body: `[effort変更依頼] ${effort}` }),
})
const run = effort => spawnSync(join(scripts, 'change-effort.sh'), [project, 'koharu', effort, 'bell'], {
  env, encoding: 'utf8', timeout: 20_000,
})
const launchLines = async () => {
  try { return (await readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean) } catch { return [] }
}

try {
  await member({ vendor: 'claude', model: 'opus', effort: 'high' })

  let result = run('max')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EFFORT_CHANGE_REQUEST_REQUIRED/)
  assert.equal((await launchLines()).length, 0)

  await request('max')
  result = run('max')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /EFFORT_CHANGE_OK: koharu high → max/)
  assert.equal((await launchLines()).length, 1)
  assert.match((await launchLines())[0], /\|koharu\|opus\|claude\|max\|/)
  assert.equal((await api('members')).members.find(x => x.name === 'koharu').effort, 'max')
  let rows = (await api('messages')).messages
  const changed = rows.find(x => x.from === 'bell' && x.to === 'koharu' && x.body.startsWith('[effort変更]'))
  assert.ok(changed)
  assert.match(changed.body, /high → max/)

  result = run('max')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EFFORT_CHANGE_REQUEST_REQUIRED/)
  assert.equal((await launchLines()).length, 1, '同じ依頼を再利用しない')

  await request('high')
  await writeFile(screen, 'Working… esc to interrupt\n')
  result = run('high')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EFFORT_CHANGE_SEAT_BUSY/)
  assert.equal((await launchLines()).length, 1)
  await writeFile(screen, 'idle\n')

  await request('ultra')
  result = run('ultra')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EFFORT_CHANGE_UNSUPPORTED: claude/)
  assert.equal((await launchLines()).length, 1)

  await writeFile(failOnce, 'yes\n')
  result = run('high')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EFFORT_CHANGE_RESTART_FAILED/)
  assert.match(result.stderr, /EFFORT_CHANGE_ROLLED_BACK/)
  assert.equal((await launchLines()).length, 3)
  assert.match((await launchLines())[1], /\|high\|/)
  assert.match((await launchLines())[2], /\|max\|/)
  assert.equal((await api('members')).members.find(x => x.name === 'koharu').effort, 'max')

  await member({ vendor: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  await request('ultra')
  result = run('ultra')
  assert.equal(result.status, 0, result.stderr)
  assert.match((await launchLines()).at(-1), /\|gpt-5\.6-sol\|codex\|ultra\|/)
  assert.equal((await api('members')).members.find(x => x.name === 'koharu').effort, 'ultra')

  const launchSource = await readFile(join(REPO, 'skill/scripts/launch-seat.sh'), 'utf8')
  assert.match(launchSource, /model_reasoning_effort=/)
  for (const ref of ['skill/SKILL.md', 'skill/templates/member.md', 'skill/templates/member-standalone.md']) {
    const source = await readFile(join(REPO, ref), 'utf8')
    assert.match(source, /\[effort変更依頼\] <level>/, `${ref}が本人要請protocolを持つ`)
    assert.match(source, /再起動/, `${ref}が再起動を明示する`)
  }
  console.log('effort-change repro: 8/8 green')
} finally {
  server.kill('SIGTERM')
  await new Promise(resolveDone => server.once('exit', resolveDone))
  await rm(root, { recursive: true, force: true })
}
