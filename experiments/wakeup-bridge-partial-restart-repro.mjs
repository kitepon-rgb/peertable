#!/usr/bin/env node
// k1/h9 seam harness:
// 同一DMを正常descriptor席と失敗descriptor席へ送り、正常席のreceiptを保存したまま
// bridgeを再起動する。再起動後に失敗席だけをdescriptor復旧し、正常席を二度起こさず
// 失敗席へ一度だけ届けることを測る。
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'wakeup-bridge-partial-restart'
const GOOD = 'good-seat'
const BAD = 'recover-seat'
const SENDER = 'partial-sender'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(80)
  }
  throw new Error(`${why}: timeout`)
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const root = await mkdtemp(join(tmpdir(), 'peertable-wakeup-partial-restart-'))
const project = join(root, 'project')
const socket = join(root, 'tmux.sock')
const goodCapture = join(root, 'good.txt')
const badCapture = join(root, 'bad.txt')
const messages = []
const streams = new Set()
let members = []
let bridge = null
let server = null
let tmuxReady = false
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}
const descriptor = target => ({ tmux_socket: socket, tmux_target: target })
const captureLines = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim()
const startPane = (session, capture) => tmux('new-session', '-d', '-s', session, '-x', '120', '-y', '30', `cat >> '${capture}'`)
const killPane = session => { try { tmux('kill-session', '-t', session) } catch {} }
const emit = message => {
  for (const stream of streams) {
    try {
      stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
      stream.write(`event: ping\ndata: ${message.seq}\n\n`)
    } catch {}
  }
}

try {
  await mkdir(join(project, '.team'), { recursive: true })
  await writeFile(goodCapture, '')
  await writeFile(badCapture, '')
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/members`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ members }))
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/messages`) {
      const since = Number(requestUrl.searchParams.get('since') ?? 0)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ messages: messages.filter(message => message.seq > since) }))
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      response.write(': connected\n\n')
      streams.add(response)
      request.on('close', () => streams.delete(response))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: ROOM, server_url: url }) + '\n')

  startPane(`peer-${GOOD}`, goodCapture)
  tmuxReady = true
  members = [
    { name: GOOD, vendor: 'codex', observe: descriptor(`peer-${GOOD}`) },
    { name: BAD, vendor: 'codex', observe: descriptor(`peer-${BAD}`) },
  ]

  const logs = []
  const startBridge = () => {
    bridge = spawn(process.execPath, [BRIDGE, project, GOOD, BAD], {
      env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    bridge.stdout.on('data', chunk => logs.push(chunk.toString('utf8')))
    bridge.stderr.on('data', chunk => logs.push(chunk.toString('utf8')))
  }
  startBridge()
  await waitFor(() => logs.join('').includes('頭出し:'), '初回頭出し')

  const dm = { seq: 1, ts: new Date().toISOString(), from: SENDER, to_names: [GOOD, BAD], body: 'partial success' }
  messages.push(dm)
  emit(dm)
  const wakeText = `room に新着あり（${SENDER} → ${GOOD}, ${BAD}）`
  await waitFor(async () => (await captureLines(goodCapture)).some(line => line.includes(wakeText)), '正常席の初回wake')
  await sleep(2_500)
  check('partial-successの正常席は一度wakeする', (await captureLines(goodCapture)).filter(line => line.includes(wakeText)).length === 1)
  check('partial-successの失敗席はまだwakeしない', (await captureLines(badCapture)).filter(line => line.includes(wakeText)).length === 0)
  const beforeRestart = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('先行失敗があっても成功宛先receiptをdurable保存する', beforeRestart.delivered.includes(`1:${GOOD}`) && beforeRestart.last_seq === 0, JSON.stringify(beforeRestart))

  await stop(bridge)
  startBridge()
  await waitFor(() => logs.join('').includes('SSE 接続') && logs.join('').includes('取りこぼし確認'), 'bridge再起動後の回収')
  await sleep(2_500)
  check('bridge再起動後に成功済み席を重複wakeしない', (await captureLines(goodCapture)).filter(line => line.includes(wakeText)).length === 1)
  check('bridge再起動後も失敗席は保留される', (await captureLines(badCapture)).filter(line => line.includes(wakeText)).length === 0)

  startPane(`peer-${BAD}`, badCapture)
  members = [
    { name: GOOD, vendor: 'codex', observe: descriptor(`peer-${GOOD}`) },
    { name: BAD, vendor: 'codex', observe: descriptor(`peer-${BAD}`) },
  ]
  await waitFor(async () => (await captureLines(badCapture)).some(line => line.includes(wakeText)), '失敗席のdescriptor復旧')
  await sleep(2_500)
  check('失敗席のdescriptor復旧後は一度だけwakeする', (await captureLines(badCapture)).filter(line => line.includes(wakeText)).length === 1)
  const afterRecovery = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('partial-success復旧後に両宛先receiptとcursorが確定する', afterRecovery.delivered.includes(`1:${GOOD}`) && afterRecovery.delivered.includes(`1:${BAD}`) && afterRecovery.last_seq === 1, JSON.stringify(afterRecovery))
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack ?? error.message}`)
  good = false
} finally {
  await stop(bridge)
  if (tmuxReady) {
    killPane(`peer-${GOOD}`)
    killPane(`peer-${BAD}`)
  }
  for (const stream of streams) stream.end()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'wakeup bridge partial restart: green' : 'wakeup bridge partial restart: RED')
process.exit(good ? 0 : 1)
