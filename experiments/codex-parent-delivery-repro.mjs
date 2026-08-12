#!/usr/bin/env node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'peertable-codex-parent-'))
const project = join(root, 'project')
const data = join(root, 'data')
const token = 'codex-parent-fixture-token'
const roomName = 'codex-parent-delivery'
const calls = join(root, 'calls.jsonl')
const fakeCodex = join(root, 'codex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let room, bridge
let ok = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) ok = false
}
const freePort = async () => {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r))
  const p = s.address().port; s.close(); await once(s, 'close'); return p
}
const waitFor = async (fn, timeout = 12_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await sleep(100) }
  return false
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

try {
  await mkdir(join(project, '.team'), { recursive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: roomName, server_url: base }) + '\n')
  await writeFile(join(project, '.team', 'post-token'), `${token}\n`, { mode: 0o600 })
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync('${calls}', JSON.stringify(process.argv.slice(2)) + '\\n')\nconsole.log('{"type":"thread.started"}')\nconsole.log('{"type":"turn.completed"}')\n`)
  await chmod(fakeCodex, 0o755)
  room = spawn(process.execPath, [join(REPO, 'room/server.mjs')], { env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token }, stdio: 'ignore' })
  check('room起動', await waitFor(async () => { try { return (await fetch(`${base}/api/${roomName}/members`)).ok } catch { return false } }))
  const headers = { 'content-type': 'application/json', 'X-Peertable-Token': token }
  const threadId = '019fef48-49b0-7190-a4cc-6ca657000c48'
  await fetch(`${base}/api/${roomName}/members`, { method: 'POST', headers, body: JSON.stringify({ name: 'bell', delivery: { kind: 'codex_thread', thread_id: threadId } }) })
  bridge = spawn(process.execPath, [join(REPO, 'skill/scripts/wakeup-bridge.mjs'), project, 'bell'], { env: { ...process.env, PEERTABLE_POST_TOKEN: token, PEERTABLE_CODEX_BIN: fakeCodex }, stdio: 'ignore' })
  await sleep(700)
  await fetch(`${base}/api/${roomName}/messages`, { method: 'POST', headers, body: JSON.stringify({ from: 'hinata', to: 'bell', body: '[メンバーturn完了] hinata' }) })
  check('Codex親task配送を一度だけ実行', await waitFor(async () => (await readFile(calls, 'utf8').catch(() => '')).includes(threadId)))
  const lines = (await readFile(calls, 'utf8')).trim().split('\n')
  const args = JSON.parse(lines[0])
  check('同じDMを重複配送しない', lines.length === 1, JSON.stringify(lines))
  check('resumeへ正しいthread IDとDM本文を渡す', args[0] === 'exec'
    && args[1] === 'resume'
    && args[2] === threadId
    && args[3]?.includes('hinata → bell')
    && args[3]?.includes('[メンバーturn完了] hinata'), JSON.stringify(args))
  const state = JSON.parse(await readFile(join(project, '.team/wakeup-bridge-delivery.json'), 'utf8'))
  check('turn完了後だけreceiptを確定', state.delivered?.includes('2:bell') === true, JSON.stringify(state))
} finally {
  await stop(bridge); await stop(room); await rm(root, { recursive: true, force: true })
}
console.log(ok ? 'codex parent delivery: green' : 'codex parent delivery: red')
process.exit(ok ? 0 : 1)
