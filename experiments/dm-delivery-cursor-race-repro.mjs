#!/usr/bin/env node
// member 登録後、初期 cursor 確定前に保存された DM を read_unread で失わないことを測る。
// 旧順序（登録 → cursor 初期化）ではこのfixtureが赤になり、
// 登録前に cursor を確定する最小seamでgreenになる。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(REPO, 'room', 'client.mjs')
const ROOM = 'dm-delivery-cursor-race-repro'
const MEMBER = 'cursor-race-codex'
const TOKEN = 'dm-delivery-cursor-race-token'
const BODY = '[dm-delivery-cursor-race] registration gap must remain unread'

const readBody = req => new Promise((resolve, reject) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { body += chunk })
  req.on('end', () => resolve(body))
  req.on('error', reject)
})

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const startClient = (baseUrl, credential) => {
  const child = spawn(process.execPath, [CLIENT], {
    env: {
      ...process.env,
      PEERTABLE_URL: baseUrl,
      PEERTABLE_ROOM: ROOM,
      PEERTABLE_MEMBER: MEMBER,
      PEERTABLE_CREDENTIAL_FILE: credential,
      PEERTABLE_VENDOR: 'codex',
      PEERTABLE_MODEL: 'cursor-race-fixture',
      PEERTABLE_PROJECT: REPO,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })
  child.once('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('room client exited'))
    pending.clear()
  })
  const call = (method, params = {}) => {
    const id = nextId++
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return result
  }
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { child, call, notify, stderr: () => stderr }
}

const root = await mkdtemp(join(tmpdir(), 'peertable-dm-cursor-race-'))
const credential = join(root, 'post-token')
await writeFile(credential, `${TOKEN}\n`, { mode: 0o600 })

const state = {
  memberRegistered: false,
  injected: false,
  messagesReads: 0,
  requests: [],
}
let seq = 0
let releaseCursorRead
const cursorReadReleased = new Promise(resolve => { releaseCursorRead = resolve })
let cursorReadDone = false
let server
let client
let ok = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) ok = false
}

try {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const prefix = `/api/${ROOM}`
    if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: 'not found' })
    const path = url.pathname.slice(prefix.length)
    state.requests.push(`${req.method} ${path}${url.search}`)
    if (path === '/members' && req.method === 'POST') {
      await readBody(req)
      state.memberRegistered = true
      seq += 1
      state.injected = true
      state.message = { seq, ts: new Date().toISOString(), from: 'bell', to: MEMBER, body: BODY }
      return json(res, 200, { ...state.member, name: MEMBER })
    }
    if (path === '/members' && req.method === 'GET') {
      return json(res, 200, { members: state.memberRegistered ? [{ name: MEMBER }] : [] })
    }
    if (path === '/messages' && req.method === 'GET') {
      state.messagesReads += 1
      const hasSince = url.searchParams.has('since')
      if (hasSince && !cursorReadDone) await cursorReadReleased
      const since = Number(url.searchParams.get('since') ?? 0)
      const messages = state.message && state.message.seq > since ? [state.message] : []
      if (!hasSince) {
        cursorReadDone = true
        releaseCursorRead()
      }
      return json(res, 200, { messages })
    }
    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      })
      res.write(': connected\n\n')
      return
    }
    return json(res, 404, { error: `unsupported ${req.method} ${path}` })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  client = startClient(`http://127.0.0.1:${port}`, credential)
  await client.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dm-delivery-cursor-race-fixture', version: '1' },
  })
  client.notify('notifications/initialized')
  await client.call('tools/list')
  while (state.messagesReads < 1) await new Promise(resolve => setTimeout(resolve, 10))
  await new Promise(resolve => setTimeout(resolve, 200))
  const unread = await client.call('tools/call', { name: 'read_unread', arguments: {} })
  const unreadText = unread.result?.content?.[0]?.text ?? ''
  check('DMをmember登録直後・初期cursor取得前の窓へ注入する', state.injected && state.memberRegistered)
  check('競合DMをread_unreadで取得する', unreadText.includes(BODY), unreadText)
  check('初期化中のmessages読取が実行される', state.messagesReads >= 2, `reads=${state.messagesReads}; ${state.requests.join(' | ')}`)
  const clientError = client.stderr().split('\n')
    .filter(line => line && !line.includes('observe unavailable: TMUX 不在')).join('\n')
  check('room client側に実行エラーがない', !clientError, clientError)
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  ok = false
} finally {
  await stop(client?.child)
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}

console.log(ok ? 'cursor race: green' : 'cursor race: red')
process.exit(ok ? 0 : 1)
