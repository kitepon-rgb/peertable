#!/usr/bin/env node
// 実Grok 4.6を使い捨てroomへ着席させ、room・起床・同一session設定変更を一周する手動smoke。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(new URL('..', import.meta.url).pathname)
// macOSのtmpdirは /var -> /private/var のsymlink。Grokのsession storeはcanonical cwdを使うため、
// Aitermへも同じcanonical project pathを渡して実運用の通常project rootと同じ条件にする。
const root = await realpath(await mkdtemp(join(tmpdir(), 'peertable-grok-live-')))
const project = join(root, 'project')
const team = join(project, '.team')
const data = join(root, 'data')
const socket = spawnSync(process.execPath, [join(repo, 'skill/scripts/tmux-socket.mjs')], { encoding: 'utf8' }).stdout.trim()
const helper = join(root, 'credential-helper.mjs')
const port = 20500 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const room = `grok-live-${process.pid}`
const member = 'grok-live'
const token = 'grok-live-token'

await Promise.all([mkdir(team, { recursive: true }), mkdir(data, { recursive: true })])
await writeFile(join(team, 'setup-state.json'), JSON.stringify({
  room, server_url: base, mode: 'standalone', plan_key: null, added_root_mcp: true,
}) + '\n')
await writeFile(join(project, '.mcp.json'), JSON.stringify({
  mcpServers: { room: { command: 'node', args: [join(repo, 'room/client.mjs')] } },
}, null, 2) + '\n')
const gitInit = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' })
assert.equal(gitInit.status, 0, gitInit.stderr)
await writeFile(helper, `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [action, ...args] = process.argv.slice(2)
const path = project => join(project, '.team', 'grok-live.token')
if (action === 'prepare') {
  mkdirSync(join(args[0], '.team'), { recursive: true })
  writeFileSync(path(args[0]), ${JSON.stringify(token)} + '\\n', { mode: 0o600 })
  process.stdout.write(path(args[0]) + '\\n')
} else if (action === 'path') process.stdout.write(path(args[0]) + '\\n')
else if (action === 'remove') rmSync(args[1], { force: true })
else if (action === 'request') {
  const credential = readFileSync(args[0], 'utf8').trim()
  const response = await fetch(args[2], { method: args[1], headers: { 'content-type': 'application/json', 'X-Peertable-Token': credential }, ...(args[3] ? { body: args[3] } : {}) })
  const body = await response.text()
  process.stdout.write(body)
  if (!response.ok) process.exit(1)
} else process.exit(2)
`)

const server = spawn(process.execPath, [join(repo, 'room/server.mjs')], {
  env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
  stdio: ['ignore', 'ignore', 'pipe'],
})
const env = {
  ...process.env,
  PEERTABLE_CREDENTIAL_HELPER: helper,
}
const inspect = spawnSync('grok', ['--cwd', project, 'inspect'], { env, encoding: 'utf8', timeout: 30_000 })
assert.equal(inspect.status, 0, inspect.stderr)
assert.match(inspect.stdout, /room\s+\(stdio\).*\.mcp\.json/, `Grokがproject room MCPを発見していない:\n${inspect.stdout}`)
const api = async (path, init) => {
  const response = await fetch(`${base}/api/${room}/${path}`, init)
  assert.ok(response.ok, `${path}: HTTP ${response.status}`)
  return response.json()
}
const waitFor = async (predicate, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${label}を待てなかった`)
}
const messages = async () => (await api('messages')).messages
const members = async () => (await api('members')).members

try {
  await waitFor(async () => {
    try { await api('members'); return true } catch { return false }
  }, 'room起動', 10_000)

  const launch = spawnSync(join(repo, 'skill/scripts/launch-seat.sh'), [
    project, member, '反証',
    'roomのpostツールでallへ「[grok-live] ready」と完全一致で投稿し、その後は待機してください。',
  ], { env, encoding: 'utf8', timeout: 180_000 })
  assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`)
  const initial = (await members()).find(item => item.name === member)
  assert.deepEqual(
    { vendor: initial?.vendor, model: initial?.model, effort: initial?.effort, session: initial?.aiterm_session_id },
    { vendor: 'grok', model: 'grok-4.6', effort: 'high', session: `peer-${member}` },
  )
  await waitFor(async () => (await messages()).some(item => item.from === member && item.body === '[grok-live] ready'), 'Grokのroom投稿')
  const initialDone = spawnSync('aiterm-wait', [
    '--session', `peer-${member}`, '--cursor', '0', '--timeout', '120',
  ], { env, encoding: 'utf8', timeout: 130_000 })
  assert.equal(initialDone.status, 0, `${initialDone.stdout}\n${initialDone.stderr}`)

  const change = model => spawnSync(join(repo, 'skill/scripts/change-seat.sh'), [
    project, member, '--model', model, '--effort', 'high', '--parent', 'bell', '--reason', 'Grok live smoke',
  ], { env, encoding: 'utf8', timeout: 90_000 })
  const seatScreen = () => spawnSync('tmux', [
    '-S', socket, 'capture-pane', '-S', '-120', '-t', `peer-${member}`, '-p',
  ], { encoding: 'utf8' }).stdout
  let changed = change('grok-4.5')
  assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}\n${seatScreen()}`)
  let current = (await members()).find(item => item.name === member)
  assert.deepEqual(
    { model: current?.model, session: current?.aiterm_session_id },
    { model: 'grok-4.5', session: `peer-${member}` },
  )
  changed = change('grok-4.6')
  assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}\n${seatScreen()}`)
  current = (await members()).find(item => item.name === member)
  assert.deepEqual(
    { model: current?.model, session: current?.aiterm_session_id },
    { model: 'grok-4.6', session: `peer-${member}` },
  )

  await api('messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
    body: JSON.stringify({ from: 'bell', to: member, body: 'roomのpostツールでallへ「[grok-live] woke」と完全一致で投稿してください。' }),
  })
  await waitFor(async () => (await messages()).some(item => item.from === member && item.body === '[grok-live] woke'), 'GrokのDM起床応答')

  console.log('grok live seat: launch / metadata / room / configure 4.6↔4.5 / wakeup green')
} finally {
  spawnSync(join(repo, 'skill/scripts/leave-seat.sh'), [project, member], { env, encoding: 'utf8', timeout: 30_000 })
  spawnSync(process.execPath, [join(repo, 'skill/scripts/wakeup-bridge.mjs'), project, '--stop'], { env, encoding: 'utf8', timeout: 30_000 })
  spawnSync(process.execPath, [join(repo, 'skill/scripts/seat-status-bridge.mjs'), project, '--stop'], { env, encoding: 'utf8', timeout: 30_000 })
  for (const session of [`peertable-wakeup-${room}`, `peertable-seat-status-${room}`])
    spawnSync('tmux', ['-S', socket, 'kill-session', '-t', session], { encoding: 'utf8' })
  server.kill('SIGTERM')
  await new Promise(resolve => server.once('exit', resolve))
  await rm(root, { recursive: true, force: true })
}
