#!/usr/bin/env node
// bridge 起動後に追加された Codex 席への DM 配達を測る focused harness。
//
// 期待する連鎖: room へ明示 DM を保存 → 新席を一度だけ wake →
// その席の room client が read_unread で同じ DM を取得する。
// 現行版では bridge の固定 args 外へ配達されないため、この harness は修正前に非ゼロで落ちる。
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const CLIENT = join(REPO, 'room', 'client.mjs')
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'dm-delivery-repro'
const TOKEN = 'dm-delivery-repro-token'
const OLD_SEAT = 'old-codex'
const NEW_SEAT = 'added-codex'
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

const request = async (base, path, init = {}) => {
  const response = await fetch(`${base}/${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'X-Peertable-Token': TOKEN,
      ...(init.headers ?? {}),
    },
  })
  let data = null
  try { data = await response.json() } catch {}
  return { response, data }
}

const waitFor = async (predicate, why, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`${why}: timeout`)
    await sleep(100)
  }
}

function startClient(baseUrl, project, clientPath = CLIENT) {
  const clientEnv = {
    ...process.env,
    PEERTABLE_URL: baseUrl,
    PEERTABLE_ROOM: ROOM,
    PEERTABLE_MEMBER: NEW_SEAT,
    PEERTABLE_CREDENTIAL_FILE: join(project, '.team', 'post-token'),
    PEERTABLE_POST_TOKEN: TOKEN,
    PEERTABLE_VENDOR: 'codex',
    PEERTABLE_MODEL: 'focused-harness',
    PEERTABLE_PROJECT: project,
  }
  // harnessの親shellの席を、追加Codex席のobserve先として登録しない。
  delete clientEnv.TMUX
  delete clientEnv.TMUX_PANE
  const child = spawn(process.execPath, [clientPath], {
    env: clientEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()
  let clientFailure = null
  const rejectPending = error => {
    if (clientFailure) return
    clientFailure = error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
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
  child.once('error', error => rejectPending(error))
  child.once('exit', (code, signal) =>
    rejectPending(new Error(`room client exited${signal ? ` by ${signal}` : ` with code ${code}`}`)))
  const call = (method, params = {}) => {
    const id = nextId++
    if (clientFailure) return Promise.reject(clientFailure)
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return result
  }
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { child, call, notify, stderr: () => stderr }
}

const root = await mkdtemp(join(tmpdir(), 'peertable-dm-delivery-repro-'))
const data = join(root, 'room-data')
const project = join(root, 'project')
const credential = join(project, '.team', 'post-token')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
await mkdir(join(project, '.team'), { recursive: true })
await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
  room: ROOM,
  server_url: 'pending',
}) + '\n')
await writeFile(credential, `${TOKEN}\n`, { mode: 0o600 })
await writeFile(capture, '')

let room = null
let bridge = null
let client = null
let brokenClient = null
let tmuxReady = false
let ok = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) ok = false
}

try {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const base = `${baseUrl}/api/${ROOM}`
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: baseUrl,
  }) + '\n')

  room = spawn(process.execPath, [ROOM_SERVER], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: data,
      PEERTABLE_POST_TOKEN: TOKEN,
      PEERTABLE_PARENT_NAME: 'bell',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let roomError = ''
  room.stderr.on('data', chunk => { roomError += chunk.toString('utf8') })
  await waitFor(async () => {
    try { return (await request(base, 'members')).response.ok } catch { return false }
  }, 'room server')

  const member = async (name, metadata = {}) => request(base, 'members', {
    method: 'POST',
    body: JSON.stringify({ name, ...metadata }),
  })
  const message = async (from, to, body) => request(base, 'messages', {
    method: 'POST',
    body: JSON.stringify({ from, to, body }),
  })

  brokenClient = startClient(baseUrl, project, join(root, 'missing-room-client.mjs'))
  const failureStartedAt = Date.now()
  let failure = null
  try {
    await Promise.race([
      brokenClient.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'broken-delivery-fixture', version: '1' },
      }),
      sleep(2_000).then(() => { throw new Error('client failure probe timeout') }),
    ])
  } catch (error) {
    failure = error
  }
  check('client起動失敗でpending RPCをbounded reject', failure !== null
    && Date.now() - failureStartedAt < 2_000
    && /room client exited|spawn .*ENOENT/u.test(failure.message), failure?.message)
  await stop(brokenClient.child)
  brokenClient = null

  await member(OLD_SEAT, { vendor: 'codex', model: 'old', observe: { tmux_socket: socket, tmux_target: `peer-${OLD_SEAT}` } })
  const bridgeOutput = []
  bridge = spawn(process.execPath, [BRIDGE, project, OLD_SEAT], {
    env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket, PEERTABLE_POST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.on('data', chunk => bridgeOutput.push(chunk.toString('utf8')))
  bridge.stderr.on('data', chunk => bridgeOutput.push(chunk.toString('utf8')))
  await waitFor(() => bridgeOutput.join('').includes('頭出し:'), 'bridge 初回頭出し')
  check('bridge が旧固定席argsで起動する', bridgeOutput.join('').includes(`seats=${OLD_SEAT}`))

  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', `peer-${NEW_SEAT}`, '-x', '120', '-y', '30', `cat >> ${capture}`])
  tmuxReady = true
  // bridge 起動後に新席を登録する。これは固定argsには存在しない席。
  const added = await member(NEW_SEAT, {
    vendor: 'codex',
    model: 'new',
    observe: { tmux_socket: socket, tmux_target: `peer-${NEW_SEAT}` },
  })
  check('bridge起動後のCodex席をroomへ追加できる', added.response.ok)
  // 新規参加のsystem DMが測定対象へ混ざらないよう、登録後の初回wakeを捨てる。
  await sleep(2_500)
  await writeFile(capture, '')

  client = startClient(baseUrl, project)
  await client.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dm-delivery-focused-harness', version: '1' },
  })
  client.notify('notifications/initialized')
  await client.call('tools/list')
  await sleep(300)

  const body = '[dm-delivery-focused] added seat must wake exactly once'
  const sent = await message('bell', NEW_SEAT, body)
  check('DMがroomへ保存される', sent.response.ok && sent.data?.to === NEW_SEAT)

  const wakeText = `room に新着あり（bell → ${NEW_SEAT}）`
  await waitFor(async () => (await readFile(capture, 'utf8')).includes(wakeText), '追加席へのwake', 12_000)
  const wakeLines = (await readFile(capture, 'utf8')).split('\n').filter(Boolean)
  check('固定args外の追加Codex席がwakeされる', wakeLines.some(line => line.includes(wakeText)), (await readFile(capture, 'utf8')).trim())
  check('一つのDMが一回だけwakeされる', wakeLines.filter(line => line.includes(wakeText)).length === 1, JSON.stringify(wakeLines))

  const unread = await client.call('tools/call', { name: 'read_unread', arguments: {} })
  const unreadText = unread.result?.content?.[0]?.text ?? ''
  check('追加席のroom clientがread_unreadでDMを取得する', unreadText.includes(body), unreadText)
  const clientError = client.stderr().split('\n')
    .filter(line => line && !line.includes('observe unavailable: TMUX 不在')).join('\n')
  check('room client側に実行エラーがない（観測先なし警告は許容）', !clientError, clientError || client.stderr().trim())
  if (roomError) console.error(`room stderr: ${roomError.trim()}`)
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  ok = false
} finally {
  await stop(client?.child)
  await stop(brokenClient?.child)
  await stop(bridge)
  await stop(room)
  if (tmuxReady) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  }
  await rm(root, { recursive: true, force: true })
}

console.log(ok ? 'focused DM delivery: green' : 'focused DM delivery: red')
process.exit(ok ? 0 : 1)
