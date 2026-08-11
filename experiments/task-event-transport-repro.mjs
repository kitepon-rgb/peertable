#!/usr/bin/env node
// a1 focused harness: typed task event の保存・recipient生成・冪等性と MCP client tool を測る。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'task-event-transport-repro-token'
const ROOM = 'task-event-transport-repro'
const PLAN = 'peertable-task-announcements-20260811'
const root = mkdtempSync(join(tmpdir(), 'peertable-task-event-'))

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, timeout = 6000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await predicate()) return
    await wait(50)
  }
  throw new Error('timeout')
}

const checks = []
const check = (label, condition, detail = '') => {
  checks.push(condition)
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), wait(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const startRoom = async port => {
  let output = ''
  const child = spawn(process.execPath, [join(REPO, 'room/server.mjs')], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: root,
      PEERTABLE_POST_TOKEN: TOKEN,
      PEERTABLE_PARENT_NAME: 'parent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await waitUntil(() => output.includes(`on :${port}`))
  return { child, output: () => output }
}

const request = async (base, path, init = {}) => {
  const response = await fetch(`${base}/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Peertable-Token': TOKEN,
      ...(init.headers ?? {}),
    },
  })
  let data = null
  try { data = await response.json() } catch {}
  return { response, data }
}

const messagesAt = async base => (await request(base, 'messages')).data.messages

function startClient(port) {
  const child = spawn(process.execPath, [join(REPO, 'room/client.mjs')], {
    env: {
      ...process.env,
      PEERTABLE_URL: `http://127.0.0.1:${port}`,
      PEERTABLE_ROOM: ROOM,
      PEERTABLE_MEMBER: 'sender',
      PEERTABLE_POST_TOKEN: TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch (error) {
        pending.get(-1)?.reject(new Error(`invalid MCP output: ${error.message}`))
        continue
      }
      if (message.id === undefined) continue
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        waiter.resolve(message)
      }
    }
  })
  const call = (method, params = {}) => {
    const id = nextId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { child, call, notify, stderr: () => stderr }
}

let server = null
let client = null
try {
  const port = await freePort()
  server = await startRoom(port)
  const base = `http://127.0.0.1:${port}/api/${ROOM}`

  for (const name of ['parent', 'alice', 'bob', 'sender'])
    await request(base, 'members', { method: 'POST', body: JSON.stringify({ name }) })

  const startedPayload = {
    kind: 'started', actor: 'sender', plan_key: PLAN, task_id: 'a1', title: 'typed transport', transition_id: 'start-1',
  }
  const started = await request(base, 'task-events', { method: 'POST', body: JSON.stringify(startedPayload) })
  check('startedをtyped eventとして保存', started.response.status === 200
    && started.data.type === 'task_event' && started.data.event_kind === 'started')
  check('started本文をroomが定型生成', started.data.body === '[工程着手] a1 typed transport — sender', started.data.body)
  check('startedの宛先が送信者を除く全席+親', JSON.stringify([...started.data.to_names].sort()) === JSON.stringify(['alice', 'bob', 'parent']))

  const countAfterStarted = (await messagesAt(base)).length
  const duplicate = await request(base, 'task-events', { method: 'POST', body: JSON.stringify(startedPayload) })
  check('同じtransitionは冪等再送', duplicate.response.status === 200 && duplicate.data.idempotent === true
    && (await messagesAt(base)).length === countAfterStarted)

  const conflict = await request(base, 'task-events', {
    method: 'POST', body: JSON.stringify({ ...startedPayload, title: '別本文' }),
  })
  check('同じtransitionの別内容をtyped reject', conflict.response.status === 409
    && conflict.data.code === 'TASK_EVENT_TRANSITION_CONFLICT')

  const turn = await request(base, 'task-events', {
    method: 'POST',
    body: JSON.stringify({ kind: 'member_turn_completed', actor: 'sender', transition_id: 'turn-1' }),
  })
  check('member_turn_completedをtyped DMとして保存', turn.response.status === 200
    && turn.data.type === 'member_turn_completed' && turn.data.event_kind === 'member_turn_completed')
  check('member_turn_completedの宛先が親だけ', turn.data.to === 'parent' && !('to_names' in turn.data))

  const beforeRejects = (await messagesAt(base)).length
  const recipientReject = await request(base, 'task-events', {
    method: 'POST', body: JSON.stringify({ ...startedPayload, transition_id: 'bad-recipient', to_names: ['alice'] }),
  })
  check('callerの宛先列挙をtyped reject', recipientReject.response.status === 400
    && recipientReject.data.code === 'TASK_EVENT_RECIPIENTS_FORBIDDEN'
    && (await messagesAt(base)).length === beforeRejects)

  const bodyReject = await request(base, 'task-events', {
    method: 'POST', body: JSON.stringify({ ...startedPayload, transition_id: 'bad-body', body: '自由本文' }),
  })
  check('callerの自由本文をtyped reject', bodyReject.response.status === 400
    && bodyReject.data.code === 'TASK_EVENT_BODY_FORBIDDEN')

  const kindReject = await request(base, 'task-events', {
    method: 'POST', body: JSON.stringify({ ...startedPayload, transition_id: 'bad-kind', kind: 'progress' }),
  })
  check('未知kindをtyped reject', kindReject.response.status === 400
    && kindReject.data.code === 'TASK_EVENT_KIND_INVALID')

  const broadcastReject = await request(base, 'messages', {
    method: 'POST', body: JSON.stringify({ from: 'sender', to: 'all', body: 'broadcast' }),
  })
  check('通常messageのbroadcast rejectを維持', broadcastReject.response.status === 400
    && broadcastReject.data.code === 'EXPLICIT_RECIPIENT_REQUIRED')

  const logged = (await messagesAt(base)).find(message => message.transition_id === 'start-1')
  check('room logのtyped fieldが通常発言と区別できる', logged?.type === 'task_event' && logged.event_kind === 'started')

  client = startClient(port)
  const initialized = await client.call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'focused-harness', version: '1' },
  })
  client.notify('notifications/initialized')
  const listed = await client.call('tools/list')
  const tool = listed.result?.tools?.find(candidate => candidate.name === 'task_event')
  check('MCP clientにtask_event toolがある', initialized.result && tool?.inputSchema?.properties?.kind?.enum?.includes('member_turn_completed'))
  // client は MCP connect の直後に自席登録と cursor 初期化を行う。そこを終えてからlive eventを送る。
  await wait(250)

  const completedCall = await client.call('tools/call', {
    name: 'task_event',
    arguments: { kind: 'completed', plan_key: PLAN, task_id: 'a1', title: 'typed transport', transition_id: 'complete-1' },
  })
  check('MCP task_event toolからcompletedを送れる', !completedCall.result?.isError
    && completedCall.result?.content?.[0]?.text?.includes('task_event'))
  const completed = (await messagesAt(base)).find(message => message.transition_id === 'complete-1')
  check('MCP completedも送信者を除く全席+親へ生成', completed?.type === 'task_event'
    && JSON.stringify([...completed.to_names].sort()) === JSON.stringify(['alice', 'bob', 'parent']))
  const senderNoSelfWake = await client.call('tools/call', { name: 'read_unread', arguments: {} })
  check('送信者自身のtyped eventをclientが再起床させない', senderNoSelfWake.result?.content?.[0]?.text === '未読なし')

  const memberTurnAfterClient = await request(base, 'task-events', {
    method: 'POST',
    body: JSON.stringify({ kind: 'member_turn_completed', actor: 'sender', transition_id: 'turn-2' }),
  })
  check('member_turn_completedの正例は親宛で保存', memberTurnAfterClient.response.status === 200
    && memberTurnAfterClient.data.to === 'parent')
  const senderNoLeak = await client.call('tools/call', { name: 'read_unread', arguments: {} })
  check('member_turn_completedが親以外のclientを起こさない', senderNoLeak.result?.content?.[0]?.text === '未読なし')

  const clientBodyReject = await client.call('tools/call', {
    name: 'task_event',
    arguments: { kind: 'started', plan_key: PLAN, task_id: 'a1', title: 'typed transport', transition_id: 'client-body', body: '自由本文' },
  })
  check('MCP経由の自由本文も成功扱いにしない', clientBodyReject.result?.isError === true)
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  if (server) console.error(server.output())
  if (client) console.error(client.stderr())
  checks.push(false)
} finally {
  await stop(client?.child)
  await stop(server?.child)
  rmSync(root, { recursive: true, force: true })
}

process.exit(checks.every(Boolean) ? 0 : 1)
