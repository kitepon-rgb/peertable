#!/usr/bin/env node
// Claude 席の起床は notifications/claude/channel。SSE 発言が MCP 通知になることを測る。
// 8/12 に送信ループを削るとこの harness は timeout で落ちる。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const CLIENT = join(REPO, 'room', 'client.mjs')
const ROOM = 'channel-notify-repro'
const TOKEN = 'channel-notify-repro-token'
const ME = 'sakura'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}

const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const root = await mkdtemp(join(tmpdir(), 'peertable-channel-notify-'))
const project = join(root, 'project')
const data = join(root, 'room-data')
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
let server = null
let client = null
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  await mkdir(join(project, '.team'), { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(join(project, '.team', 'post-token'), TOKEN)

  server = spawn(process.execPath, [ROOM_SERVER], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: data,
      PEERTABLE_POST_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitHttp(`${baseUrl}/api/${ROOM}/members`)

  const credential = join(project, '.team', 'post-token')
  const notifications = []
  client = spawn(process.execPath, [CLIENT], {
    env: {
      ...process.env,
      PEERTABLE_URL: baseUrl,
      PEERTABLE_ROOM: ROOM,
      PEERTABLE_MEMBER: ME,
      PEERTABLE_CREDENTIAL_FILE: credential,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  client.stdout.on('data', chunk => {
    buf += chunk.toString('utf8')
    let end
    while ((end = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, end).trim()
      buf = buf.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.method === 'notifications/claude/channel') notifications.push(message)
    }
  })

  client.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'repro', version: '0' } },
  })}\n`)
  client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  await sleep(400)

  const posted = await fetch(`${baseUrl}/api/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ from: 'hinata', to: ME, body: 'sakura さん、タスクYお願い' }),
  })
  check('post 200', posted.ok, `status=${posted.status}`)

  const deadline = Date.now() + 8_000
  while (notifications.length === 0 && Date.now() < deadline) await sleep(80)
  check('channel 通知が1件以上', notifications.length >= 1, `count=${notifications.length}`)
  const content = notifications[0]?.params?.content ?? ''
  check('本文に差出人と宛先', content.includes('hinata') && content.includes(ME), content.slice(0, 80))
  check('read_unread の合図', content.includes('read_unread'), content.slice(0, 80))
} finally {
  await stop(client)
  await stop(server)
  await rm(root, { recursive: true, force: true })
}

if (!good) process.exit(1)
console.log('channel-notify-repro: green')

async function waitHttp(url) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return
    } catch {}
    await sleep(80)
  }
  throw new Error(`server not up: ${url}`)
}
