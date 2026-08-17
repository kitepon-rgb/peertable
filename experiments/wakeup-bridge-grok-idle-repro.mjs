#!/usr/bin/env node
// Grok席が busy のあいだは wakeup をキューへ積まず、idle になってから一度だけ送る。
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'wakeup-bridge-grok-idle'
const SEAT = 'nagi'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise(resolve => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const waitFor = async (predicate, timeout = 12_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(80)
  }
  return false
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const root = await mkdtemp(join(tmpdir(), 'peertable-wakeup-grok-idle-'))
const project = join(root, 'project')
const data = join(root, 'room-data')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const base = `${baseUrl}/api/${ROOM}`

let server = null
let bridge = null
let serverError = ''
const bridgeLog = []
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}
const request = async (path, init = {}) => {
  const response = await fetch(`${base}/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  let body = null
  try { body = await response.json() } catch {}
  return { response, data: body }
}
const member = (name, metadata = {}) => request('members', {
  method: 'POST',
  body: JSON.stringify({ name, ...metadata }),
})
const message = (from, to, body) => request('messages', {
  method: 'POST',
  body: JSON.stringify({ from, to, body }),
})
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim()
const readCapture = async () => readFile(capture, 'utf8').catch(() => '')

try {
  await mkdir(join(project, '.team'), { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(capture, '')
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: baseUrl,
    mode: 'standalone',
  }) + '\n')

  const serverEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data }
  delete serverEnv.PEERTABLE_POST_TOKEN
  server = spawn(process.execPath, [ROOM_SERVER], {
    env: serverEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', chunk => { serverError += chunk.toString('utf8') })
  const roomReady = await waitFor(async () => {
    try { return (await request('members')).response.ok } catch { return false }
  }, 8_000)
  check('fixture room server が起動する', roomReady, serverError.trim().slice(-300))
  if (!roomReady) throw new Error('fixture room server がlistenしない')

  tmux('new-session', '-d', '-s', `peer-${SEAT}`, '-x', '120', '-y', '30',
    `printf '\\n%.0s' $(seq 1 45); printf 'Working (1m · esc to interrupt)\\n'; sleep 600`)
  await member(SEAT, {
    vendor: 'grok',
    observe: { tmux_socket: socket, tmux_target: `peer-${SEAT}` },
  })

  bridge = spawn(process.execPath, [BRIDGE, project], {
    env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.on('data', chunk => bridgeLog.push(chunk.toString('utf8')))
  bridge.stderr.on('data', chunk => bridgeLog.push(chunk.toString('utf8')))
  check('bridge が ready になる', await waitFor(async () => {
    try { return Boolean(JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge.json'), 'utf8')).ready_at) } catch { return false }
  }), bridgeLog.join('').slice(-400))

  const posted = await message('sora', SEAT, '役割逸脱: 作業者は done.sh を打たない')
  const seq = posted.data?.seq
  await sleep(3_000)
  check('busy 中は送らない', !(await readCapture()).includes('役割逸脱'), await readCapture())
  check('idle待ちを一度記録する', bridgeLog.join('').includes('Grok席が実行中なのでidleまで待つ'), bridgeLog.join('').slice(-500))
  const busyState = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('busy 中は last_seq を進めない', Number.isSafeInteger(seq) && busyState.last_seq < seq, JSON.stringify({ seq, last_seq: busyState.last_seq }))

  tmux('kill-session', '-t', `peer-${SEAT}`)
  tmux('new-session', '-d', '-s', `peer-${SEAT}`, '-x', '120', '-y', '30', `cat >> ${shellQuote(capture)}`)
  check('idle 後に一度だけ届く', await waitFor(async () => (await readCapture()).includes('役割逸脱')), bridgeLog.join('').slice(-800))
  await sleep(2_500)
  check('idle 後の再送が exactly-once', ((await readCapture()).match(/役割逸脱/gu) ?? []).length === 1, await readCapture())
  const idleState = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('idle 後に last_seq が進む', idleState.last_seq >= seq && idleState.delivered.includes(`${seq}:${SEAT}`), JSON.stringify(idleState))
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack ?? error.message}\nserver stderr: ${serverError}`)
  good = false
} finally {
  await stop(bridge)
  try { tmux('kill-server') } catch {}
  await stop(server)
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'wakeup bridge grok idle: green' : 'wakeup bridge grok idle: RED')
process.exit(good ? 0 : 1)
