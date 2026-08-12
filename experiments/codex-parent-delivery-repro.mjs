#!/usr/bin/env node
// Codex親は通常席bridgeや外部resumeへ流さず、親内background taskが読む
// parent-watch eventだけを配送契約にするfocused fixture。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'peertable-codex-parent-'))
const project = join(root, 'project')
const data = join(root, 'data')
const token = 'codex-parent-fixture-token'
const roomName = 'codex-parent-delivery'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let room = null
let bridge = null
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}
const freePort = async () => {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  socket.close()
  await once(socket, 'close')
  return port
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
const run = (script, args, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('close', status => resolve({ status, stdout, stderr }))
})

try {
  await mkdir(join(project, '.team'), { recursive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const api = `${base}/api/${roomName}`
  await writeFile(join(project, '.team/setup-state.json'), `${JSON.stringify({ room: roomName, server_url: base })}\n`)
  room = spawn(process.execPath, [join(repo, 'room/server.mjs')], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: token },
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${api}/summary`)).ok) break } catch {}
    await sleep(50)
  }
  const headers = { 'content-type': 'application/json', 'X-Peertable-Token': token }
  await fetch(`${api}/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'bell', vendor: 'codex', observe: null, delivery: { kind: 'parent_watch', host: 'codex' } }),
  })
  const watcher = join(repo, 'skill/scripts/parent-watch.mjs')
  const prime = await run(watcher, [project, 'bell', '--prime'])
  check('Codex親watch cursorをprime', prime.status === 0, prime.stderr)

  bridge = spawn(process.execPath, [join(repo, 'skill/scripts/wakeup-bridge.mjs'), project], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bridgeOutput = ''
  bridge.stdout.on('data', chunk => { bridgeOutput += chunk })
  bridge.stderr.on('data', chunk => { bridgeOutput += chunk })
  for (let i = 0; i < 50 && !bridgeOutput.includes('頭出し:'); i += 1) await sleep(50)

  const next = run(watcher, [project, 'bell', '--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '3000' })
  await sleep(100)
  await fetch(`${api}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ from: 'hinata', to: 'departed-seat', body: '退席済み宛は起床不能なので履歴だけ残す' }),
  })
  const body = '[メンバーturn完了] hinata'
  const posted = await (await fetch(`${api}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ from: 'hinata', to: 'bell', body }),
  })).json()
  const delivered = await next
  const event = JSON.parse(delivered.stdout.trim())
  check('Codex親background taskへDM本文を構造化出力', delivered.status === 0
    && event.type === 'parent_dm' && event.seq === posted.seq && event.body === body, delivered.stdout || delivered.stderr)

  await sleep(500)
  const bridgeState = JSON.parse(await readFile(join(project, '.team/wakeup-bridge-delivery.json'), 'utf8'))
  check('通常席wakeup-bridgeはparent_watchを配送対象にしない',
    !bridgeOutput.includes('WAKEUP_BRIDGE_DELIVERY_FAILURE')
    && !bridgeOutput.includes('Codex親taskを起こした'), bridgeOutput)
  check('退席済み宛DMで通常席cursorを永久に塞がない', bridgeState.last_seq === posted.seq,
    JSON.stringify(bridgeState))
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack}`)
  good = false
} finally {
  await stop(bridge)
  await stop(room)
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'codex parent delivery: green' : 'codex parent delivery: red')
process.exit(good ? 0 : 1)
