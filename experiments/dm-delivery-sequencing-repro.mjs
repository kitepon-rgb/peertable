#!/usr/bin/env node
// 同じDMがSSE本文とheartbeat catch-upへ同時に現れる境界の focused harness。
// 旧版は二つのdispatchが同じpendingへ入り「新着2件」として注入する。
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'dm-delivery-sequencing-repro'
const SEAT = 'sequencing-codex'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 10_000) => {
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

const root = await mkdtemp(join(tmpdir(), 'peertable-dm-sequencing-'))
const project = join(root, 'project')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
await mkdir(join(project, '.team'), { recursive: true })
await writeFile(capture, '')

let server = null
let bridge = null
let tmuxReady = false
let streams = new Set()
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  const serverMessages = []
  let head = 0
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === `/api/${ROOM}/members`) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ members: [{
          name: SEAT,
          vendor: 'codex',
          observe: { tmux_socket: socket, tmux_target: `peer-${SEAT}` },
        }] }))
      }, 80)
      return
    }
    if (req.method === 'GET' && url.pathname === `/api/${ROOM}/messages`) {
      const since = Number(url.searchParams.get('since') ?? 0)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ messages: serverMessages.filter(message => message.seq > since) }))
      }, 80)
      return
    }
    if (req.method === 'GET' && url.pathname === `/api/${ROOM}/events`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      res.write(': connected\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: ROOM, server_url: url }) + '\n')

  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' })
  tmux('new-session', '-d', '-s', `peer-${SEAT}`, '-x', '120', '-y', '30', `cat >> ${capture}`)
  tmuxReady = true

  const logs = []
  bridge = spawn(process.execPath, [BRIDGE, project, SEAT], {
    env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.on('data', chunk => logs.push(chunk.toString('utf8')))
  bridge.stderr.on('data', chunk => logs.push(chunk.toString('utf8')))
  await waitFor(() => logs.join('').includes('頭出し:'), 'bridge 初回頭出し')

  const message = {
    seq: 1,
    ts: new Date().toISOString(),
    from: 'bell-sequencing',
    to: SEAT,
    body: '[sequencing] exactly once',
  }
  serverMessages.push(message)
  head = message.seq
  // pingがcatch-upを起こした直後に、同じseqのSSE本文も送る。
  for (const stream of streams) {
    stream.write(`event: ping\ndata: ${head}\n\n`)
    stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
  }

  await waitFor(async () => (await readFile(capture, 'utf8')).includes('[Peertable DM #1]'), 'wake')
  const delivered = await readFile(capture, 'utf8')
  check('SSE本文とcatch-upが同時でもwakeする', delivered.includes('[Peertable DM #1]'))
  check('同じDMを二重dispatchしない', (delivered.match(/\[Peertable DM #1\]/gu) ?? []).length === 1, delivered.trim())
  check('wakeだけで本文が届く', delivered.includes('[sequencing] exactly once'), delivered.trim())
  check('bridgeログも1件配達を記録する', logs.join('').includes('起こした: ' + SEAT + ' ← 1 件'), logs.join('').split('\n').slice(-8).join('\n'))

  const broadcast = {
    seq: 2,
    ts: new Date().toISOString(),
    from: 'bell-sequencing',
    to: 'all',
    body: '[broadcast body must stay in room]',
  }
  serverMessages.push(broadcast)
  head = broadcast.seq
  for (const stream of streams) {
    stream.write(`event: message\ndata: ${JSON.stringify(broadcast)}\n\n`)
  }
  await waitFor(async () => (await readFile(capture, 'utf8')).includes('[Peertable #2] room全体の状況が更新された'), 'all wake')
  const afterBroadcast = await readFile(capture, 'utf8')
  check('allは本文を注入せずroomの再読だけを促す', !afterBroadcast.includes(broadcast.body)
    && afterBroadcast.includes('room.read_logで部屋を読み、状況を把握して次の行動を判断する。'), afterBroadcast.trim())
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  good = false
} finally {
  await stop(bridge)
  if (tmuxReady) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  }
  if (server) {
    for (const stream of streams) stream.end()
    await new Promise(resolve => server.close(resolve))
  }
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'sequencing DM delivery: green' : 'sequencing DM delivery: red')
process.exit(good ? 0 : 1)
