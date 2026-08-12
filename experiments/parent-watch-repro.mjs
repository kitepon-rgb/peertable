#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const watcher = join(repo, 'skill/scripts/parent-watch.mjs')
const roomServer = join(repo, 'room/server.mjs')
const root = await mkdtemp(join(tmpdir(), 'peertable-parent-watch-'))
const project = join(root, 'project')
const data = join(root, 'data')
const room = 'parent-watch-fixture'
const parent = 'bell'
let server = null
let green = true
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) green = false
}
const freePort = async () => {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  socket.close()
  await once(socket, 'close')
  return port
}
const start = (extraArgs, env = {}) => {
  const child = spawn(process.execPath, [watcher, project, parent, ...extraArgs], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, result: new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr }))) }
}
const run = (extraArgs, env = {}) => start(extraArgs, env).result

try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const api = `${base}/api/${room}`
  await mkdir(join(project, '.team'), { recursive: true })
  await writeFile(join(project, '.team/setup-state.json'), `${JSON.stringify({ room, server_url: base })}\n`)
  const serverEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data }
  delete serverEnv.PEERTABLE_POST_TOKEN
  server = spawn(process.execPath, [roomServer], {
    env: serverEnv, stdio: 'ignore',
  })
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${api}/summary`)).ok) break } catch {}
    await sleep(50)
  }

  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'system', to: parent, body: 'prime以前の履歴' }),
  })
  const primed = await run(['--prime'])
  const stateAfterPrime = JSON.parse(await readFile(join(project, '.team/parent-watch.json'), 'utf8'))
  check('primeは親を起こさず現在headへカーソルを置く', primed.status === 0 && primed.stdout === '' && stateAfterPrime.last_seq === 1,
    `${primed.stderr} ${JSON.stringify(stateAfterPrime)}`)

  const live = run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '3000' })
  await sleep(150)
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'hinata', to: 'nagi', body: '親以外' }),
  })
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: parent, to: parent, body: '親自身' }),
  })
  const liveBody = 'いま届くべきDM'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'asahi', to: [parent, 'nagi'], body: liveBody }),
  })
  const liveResult = await live
  const liveEvents = liveResult.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  check('単独宛と複数宛を同じ構造化eventで親へ返す', liveResult.status === 0
    && liveEvents.length === 1
    && liveEvents[0].type === 'parent_dm'
    && liveEvents[0].from === 'asahi'
    && liveEvents[0].body === liveBody
    && liveEvents[0].to_names.includes(parent), liveResult.stdout || liveResult.stderr)
  check('親以外と親自身の発言では起こさない', !liveResult.stdout.includes('親以外') && !liveResult.stdout.includes('親自身'))

  const missedBody = 'watcher不在中のDM'
  await fetch(`${api}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'nagi', to: parent, body: missedBody }),
  })
  const caught = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '1000' })
  const caughtEvent = JSON.parse(caught.stdout.trim())
  check('watcher不在中のDMも永続cursorからcatch-upする', caught.status === 0
    && caughtEvent.body === missedBody && caughtEvent.from === 'nagi', caught.stdout || caught.stderr)

  const duplicate = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '250' })
  check('再起動しても配達済みDMを重複させない', duplicate.status === 0 && duplicate.stdout === '', duplicate.stdout || duplicate.stderr)

  for (const [from, body] of [['hinata', '常駐一件目'], ['asahi', '常駐二件目']]) {
    await fetch(`${api}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: parent, body }),
    })
  }
  const polled = await run(['--poll'])
  const polledEvents = polled.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  check('pollは未達DMをまとめて返して即終了する',
    polled.status === 0
    && polledEvents.length === 2
    && polledEvents[0].body === '常駐一件目'
    && polledEvents[1].body === '常駐二件目',
    polled.stdout || polled.stderr)
  check('poll終了後にNode processとlockを常駐させない', !existsSync(join(project, '.team/parent-watch.lock')))

  const held = start(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '1000' })
  await sleep(80)
  const competing = await run(['--next'], { PEERTABLE_PARENT_WATCH_WINDOW_MS: '200' })
  check('同じ親の番犬を二世代同時に起動しない', competing.status === 1
    && competing.stderr.includes('PARENT_WATCH_ALREADY_RUNNING'), competing.stderr)
  held.child.kill('SIGTERM')
  await held.result
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack}`)
  green = false
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([once(server, 'exit'), sleep(1000)])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  await rm(root, { recursive: true, force: true })
}

console.log(green ? 'parent watch: green' : 'parent watch: red')
process.exit(green ? 0 : 1)
