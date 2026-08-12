// effort 専用入口（配布済み change-effort.sh）の退行ハーネス。
//
// **この file が止めているのは1つの退行だけである**: 「本人→親の単独DMが
// `[effort変更依頼] <level>` と完全一致すること」を script が再検証する形が戻ってくること。
// 2026-08-11 実測では、意味の一意な自然文依頼（「effort を max に上げてほしい」）が
// EFFORT_CHANGE_REQUEST_REQUIRED で拒否され、同じ文面の再送を人へ要求していた。
// 依頼の意味判断は親（AI）が行い、script は確定した target だけを受ける（計画 §2.1）。
//
// model / effort 変更そのものの契約は experiments/seat-change-repro.mjs が測る。
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
const credentialHelper = join(root, 'seat-credential.mjs')
const port = 19700 + Math.floor(Math.random() * 300)
const base = `http://127.0.0.1:${port}`
const token = 'test-token'

await Promise.all([mkdir(join(project, '.team'), { recursive: true }), mkdir(scripts), mkdir(bin), mkdir(data)])
await writeFile(join(project, '.team/setup-state.json'), JSON.stringify({ room: 'fixture', server_url: base }) + '\n')
for (const script of ['change-seat.sh', 'change-effort.sh']) {
  await cp(join(REPO, 'skill/scripts', script), join(scripts, script))
  await chmod(join(scripts, script), 0o755)
}
await writeFile(screen, 'idle\n')
await writeFile(join(bin, 'tmux'), `#!/bin/bash
case " $* " in
  *" has-session "*) exit 0 ;;
  *" capture-pane "*) cat "$FAKE_SCREEN"; exit 0 ;;
esac
exit 1
`)
await writeFile(join(bin, 'claude'), `#!/bin/bash
if [ "$1" = "--help" ]; then
  printf '%s\\n' '  --effort <level>                      Effort level for the current session'
  printf '%s\\n' '                                        (low, medium, high, xhigh, max)'
  exit 0
fi
exit 1
`)
await writeFile(join(scripts, 'launch-seat.sh'), `#!/bin/bash
printf '%s|%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$LAUNCH_LOG"
payload=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"vendor":sys.argv[2],"model":sys.argv[3],"effort":sys.argv[4]}))' "$2" "$4" "$3" "$5")
curl -sf -o /dev/null -X POST "$PEERTABLE_URL/api/fixture/members" -H "X-Peertable-Token: ${token}" -H 'content-type: application/json' -d "$payload"
`)
await writeFile(join(scripts, 'leave-seat.sh'), `#!/bin/bash
name="$2"
curl -sf -X DELETE "$PEERTABLE_URL/api/fixture/members/$name" -H "X-Peertable-Token: ${token}" >/dev/null
`)
await writeFile(credentialHelper, `#!/usr/bin/env node
const [action, ...args] = process.argv.slice(2)
if (action === 'path') process.stdout.write(args[0] + '/.team/fixture.token\\n')
else if (action === 'request') {
  const response = await fetch(args[2], { method: args[1], headers: { 'content-type': 'application/json', 'X-Peertable-Token': ${JSON.stringify(token)} }, ...(args[3] ? { body: args[3] } : {}) })
  if (!response.ok) process.exit(1)
} else process.exit(2)
`)
await Promise.all(['tmux', 'claude'].map(name => chmod(join(bin, name), 0o755)))
await Promise.all(['launch-seat.sh', 'leave-seat.sh'].map(name => chmod(join(scripts, name), 0o755)) )

const server = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_POST_TOKEN: token,
  PEERTABLE_CREDENTIAL_HELPER: credentialHelper,
  PEERTABLE_URL: base,
  PEERTABLE_TMUX_SOCKET: join(root, 'tmux.sock'),
  FAKE_SCREEN: screen,
  LAUNCH_LOG: launchLog,
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
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify(body),
})
const run = effort => spawnSync(join(scripts, 'change-effort.sh'), [project, 'koharu', effort, 'bell'], {
  env, encoding: 'utf8', timeout: 20_000,
})
const launchLines = async () => {
  try { return (await readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean) } catch { return [] }
}

try {
  await post('members', { name: 'koharu', vendor: 'claude', model: 'opus', effort: 'high' })
  // room に在るのは自然文の依頼だけ。`[effort変更依頼] max` の完全一致DMは**置かない**
  await post('messages', { from: 'koharu', to: 'bell', body: 'ベル、この工程は判断が重いので effort を max に上げてほしい。今 idle です' })

  let result = run('max')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SEAT_CHANGE_OK: koharu effort high → max/)
  assert.doesNotMatch(result.stderr, /REQUEST_REQUIRED/)
  assert.equal((await launchLines()).length, 1)
  assert.equal((await api('members')).members.find(x => x.name === 'koharu').effort, 'max')

  // 依頼DMの「消費」状態も持たない: 親が続けて別のtargetを確定できる
  result = run('low')
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await launchLines()).length, 2)
  assert.equal((await api('members')).members.find(x => x.name === 'koharu').effort, 'low')

  // 引数の形（配布済み入口）が保たれている
  result = spawnSync(join(scripts, 'change-effort.sh'), [project, 'koharu'], { env, encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: change-effort\.sh <project_dir> <member> <effort> \[parent_name\]/)

  // script 側に room メッセージの再解釈が戻っていない
  for (const script of ['change-effort.sh', 'change-seat.sh']) {
    const source = await readFile(join(REPO, 'skill/scripts', script), 'utf8')
    // コメントは「昔こうだった」を書き残す面なので除く。見るのは実際に走る行だけ
    const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
    // 履歴の POST は残す。禁じているのは**読み直して依頼を再検証する**形（GET /messages）だけ
    assert.doesNotMatch(code, /curl -sf "\$url\/api\/\$room\/messages"/, `${script} が room の発言を読み直さない`)
    assert.doesNotMatch(code, /effort変更依頼/, `${script} が依頼文面の完全一致を検査しない`)
  }
  console.log('effort-change repro: 5/5 green（自然文依頼を拒否しない）')
} finally {
  server.kill('SIGTERM')
  await new Promise(done => server.once('exit', done))
  await rm(root, { recursive: true, force: true })
}
