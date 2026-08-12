#!/usr/bin/env node
// 同じprojectへ wakeup-bridge を同時起動した時の競合を測る focused harness。
//
// 期待する連鎖: 同時起動 → 先発bridgeを正規停止 → 最終recordが一つ →
// room の1 DMが最終bridgeから一度だけwakeされる。
// 起動lockが無い版では両方が常駐し、同じDMを二重wakeする。
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'wakeup-bridge-competition-repro'
const SEAT = 'competition-codex'
const FROM = 'bell-competition'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 12_000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`${why}: timeout`)
    await sleep(80)
  }
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const root = await mkdtemp(join(tmpdir(), 'peertable-wakeup-competition-'))
const project = join(root, 'project')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
await mkdir(join(project, '.team'), { recursive: true })
await writeFile(capture, '')

let server = null
let streams = new Set()
let bridges = []
let tmuxReady = false
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  const messages = []
  let nextSeq = 1
  server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/members`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ members: [{
        name: SEAT,
        vendor: 'codex',
        observe: { tmux_socket: socket, tmux_target: `peer-${SEAT}` },
      }] }))
      return
    }
    if (req.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/messages`) {
      const since = Number(requestUrl.searchParams.get('since') ?? 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messages: messages.filter(message => message.seq > since) }))
      return
    }
    if (req.method === 'GET' && requestUrl.pathname === `/api/${ROOM}/events`) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'POST' && requestUrl.pathname === `/api/${ROOM}/messages`) {
      let body = ''
      for await (const chunk of req) body += chunk
      const input = JSON.parse(body)
      const message = { ...input, seq: nextSeq++, ts: new Date().toISOString() }
      messages.push(message)
      for (const stream of streams) {
        try { stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`) } catch {}
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(message))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: baseUrl,
  }) + '\n')

  execFileSync('tmux', [
    '-S', socket, 'new-session', '-d', '-s', `peer-${SEAT}`,
    '-x', '120', '-y', '30', `cat >> ${capture}`,
  ])
  tmuxReady = true

  const startBridge = label => {
    const logs = []
    const child = spawn(process.execPath, [BRIDGE, project, SEAT], {
      env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')))
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')))
    return { label, child, logs }
  }

  // 同じtickで2本を起こし、record/stopの競合を発生させる。
  bridges = [startBridge('first'), startBridge('second')]
  await waitFor(async () => {
    const live = bridges.filter(({ child }) => child.exitCode === null)
    return live.length === 1 && await (async () => {
      try {
        const record = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge.json'), 'utf8'))
        return Boolean(record.ready_at) && Number(record.pid) === live[0].child.pid
      } catch {
        return false
      }
    })()
  }, '同時起動後の単一ready bridge')

  const record = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge.json'), 'utf8'))
  check('同時起動後も最終recordが一つだけ残る', Number(record.pid) === bridges.find(({ child }) => child.exitCode === null)?.child.pid, JSON.stringify(record))
  check('先発または後発の一方が正規停止される', bridges.filter(({ child }) => child.exitCode !== null).length === 1, bridges.map(({ label, child }) => `${label}:${child.exitCode}`).join(', '))
  check('起動lockが最終ready後に残らない', !(await readFile(join(project, '.team', 'wakeup-bridge.json.lock'), 'utf8').catch(() => null)))

  const response = await fetch(`${baseUrl}/api/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: SEAT, body: '[competition] exactly once' }),
  })
  check('競合fixtureのDMがroomへ保存される', response.ok)
  const wakeText = `room に新着あり（${FROM} → ${SEAT}）`
  await waitFor(async () => (await readFile(capture, 'utf8')).includes(wakeText), '単一bridgeのwake')
  await sleep(500)
  const delivered = await readFile(capture, 'utf8')
  const wakeLines = delivered.split('\n').filter(line => line.includes(wakeText))
  check('最終bridgeがDMをwakeする', wakeLines.length >= 1, delivered.trim())
  check('競合しても一つのDMを一回だけwakeする', wakeLines.length === 1, JSON.stringify(wakeLines))
  const allLogs = bridges.flatMap(({ logs }) => logs).join('')
  check('bridgeログの配達も一回だけ', (allLogs.match(new RegExp(`起こした: ${SEAT} ← 1 件`, 'g')) ?? []).length === 1, allLogs.split('\n').filter(line => line.includes('起こした:')).join('\n'))
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  good = false
} finally {
  for (const { child } of bridges) await stop(child)
  if (tmuxReady) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server']) } catch {}
  }
  if (server) {
    for (const stream of streams) stream.end()
    await new Promise(resolve => server.close(resolve))
  }
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'wakeup bridge competition: green' : 'wakeup bridge competition: red')
process.exit(good ? 0 : 1)
