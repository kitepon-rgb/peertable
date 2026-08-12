#!/usr/bin/env node
// k1 focused harness: agent Stop hook -> parent-only member_turn_completed ->
// parent SSE wake -> parent client read_unread を、全体 completed と分けて測る。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const HELPER = join(REPO, 'skill', 'scripts', 'member-turn-completed.mjs')
const LAUNCH = join(REPO, 'skill', 'scripts', 'launch-seat.sh')
const TOKEN = 'member-turn-completion-repro-token'
const ROOM = `member-turn-completion-${process.pid}`
const root = mkdtempSync(join(tmpdir(), 'peertable-member-turn-'))
const credential = join(root, 'client.token')
const transcript = join(root, 'asahi-transcript.jsonl')
writeFileSync(credential, `${TOKEN}\n`, { mode: 0o600 })
writeFileSync(transcript, '{"role":"user","content":"finish"}\n{"role":"assistant","content":"done"}\n')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, timeout = 6000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error('timeout')
}

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
  await Promise.race([once(child, 'exit'), sleep(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const checks = []
const check = (label, condition, detail = '') => {
  checks.push(condition)
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
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

const startClient = (port, member) => {
  const child = spawn(process.execPath, [join(REPO, 'room/client.mjs')], {
    env: {
      ...process.env,
      PEERTABLE_URL: `http://127.0.0.1:${port}`,
      PEERTABLE_ROOM: ROOM,
      PEERTABLE_MEMBER: member,
      PEERTABLE_CREDENTIAL_FILE: credential,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let nextId = 1
  let stderr = ''
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
  const call = (method, params = {}) => {
    const id = nextId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { child, call, notify, stderr: () => stderr }
}

const runHook = (payload, url) => new Promise(resolve => {
  const child = spawn(process.execPath, [HELPER], {
    env: {
      ...process.env,
      PEERTABLE_URL: url,
      PEERTABLE_ROOM: ROOM,
      PEERTABLE_MEMBER: 'asahi',
      PEERTABLE_CREDENTIAL_FILE: credential,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  child.on('close', code => resolve({ code, stdout, stderr }))
  child.stdin.end(JSON.stringify(payload))
})

const parentWake = async (base, signal) => {
  const response = await fetch(`${base}/events`, { signal: signal.controller.signal })
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const line = frame.split('\n').find(item => item.startsWith('data: '))
      if (!line) continue
      let message
      try { message = JSON.parse(line.slice(6)) } catch { continue }
      if (message.from === 'asahi' && message.to === 'bell') {
        signal.resolve(message)
        return
      }
    }
  }
}

let server = null
let parent = null
let wakeResolve
const wakeSignal = {
  controller: new AbortController(),
  promise: new Promise(resolve => { wakeResolve = resolve }),
  resolve: value => wakeResolve(value),
}

try {
  const source = readFileSync(LAUNCH, 'utf8')
  check('launch-seatがClaude Stop hookへhelperを束縛する', source.includes('member-turn-completed.mjs') && source.includes('--settings'))
  check('launch-seatがCodex Stop hookをinline設定へ追加する', source.includes('hooks.Stop=') && source.includes('--dangerously-bypass-hook-trust'))

  const port = await freePort()
  const data = join(root, 'room-data')
  server = spawn(process.execPath, [ROOM_SERVER], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: data,
      PEERTABLE_POST_TOKEN: TOKEN,
      PEERTABLE_PARENT_NAME: 'bell',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  server.stdout.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  server.stderr.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  await waitUntil(() => serverOutput.includes(`on :${port}`))
  const base = `http://127.0.0.1:${port}/api/${ROOM}`
  for (const name of ['bell', 'asahi']) await request(base, 'members', { method: 'POST', body: JSON.stringify({ name }) })

  parent = startClient(port, 'bell')
  const initialized = await parent.call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'k1-focused', version: '1' },
  })
  parent.notify('notifications/initialized')
  check('親room clientが起動する', Boolean(initialized.result))
  await sleep(250)

  parentWake(base, wakeSignal).catch(() => {})
  const payload = {
    hook_event_name: 'Stop',
    session_id: 'asahi-session',
    turn_id: 'turn-1',
    transcript_path: transcript,
    last_assistant_message: 'asahiの発言終了',
    stop_hook_active: false,
  }
  const first = await runHook(payload, `http://127.0.0.1:${port}`)
  check('Stop hookが親DM発射を成功扱いにする', first.code === 0, first.stderr || first.stdout)

  const event = await Promise.race([wakeSignal.promise, sleep(6000).then(() => null)])
  check('親だけへmember_turn_completedがSSE wakeされる', event?.type === 'member_turn_completed' && event?.to === 'bell' && !('to_names' in event), JSON.stringify(event))

  const unread = await parent.call('tools/call', { name: 'read_unread', arguments: {} })
  const unreadText = unread.result?.content?.[0]?.text ?? ''
  check('親read_unreadが生成本文を受け取る', unreadText.includes('[メンバーturn完了] asahi'), unreadText)

  const messagesBeforeRetry = (await request(base, 'messages')).data.messages
  const retry = await runHook(payload, `http://127.0.0.1:${port}`)
  const messagesAfterRetry = (await request(base, 'messages')).data.messages
  check('同じagent turnのStop再送が冪等', retry.code === 0 && `${retry.stdout}${retry.stderr}`.includes('already sent') && messagesAfterRetry.length === messagesBeforeRetry.length, retry.stderr || retry.stdout)
  const afterRetry = await parent.call('tools/call', { name: 'read_unread', arguments: {} })
  check('冪等再送で親を二度起こさない', afterRetry.result?.content?.[0]?.text === '未読なし', afterRetry.result?.content?.[0]?.text)
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  checks.push(false)
} finally {
  wakeSignal.controller.abort()
  await stop(parent?.child)
  await stop(server)
  rmSync(root, { recursive: true, force: true })
}

process.exit(checks.every(Boolean) ? 0 : 1)
