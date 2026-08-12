#!/usr/bin/env node
// k1 実席E2E: 正規 launch-seat.sh で立てた実Claude/Codex席の実turn終了から、
// bellだけへのmember_turn_completed、親wake、親read_unreadを測る。
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const ROOM_CLIENT = join(REPO, 'room', 'client.mjs')
const LAUNCH = join(REPO, 'skill', 'scripts', 'launch-seat.sh')
const TOKEN = 'member-turn-real-seat-repro-token'
const vendor = process.env.K1_REAL_VENDOR ?? 'claude'
if (!['claude', 'codex'].includes(vendor)) throw new Error(`unsupported K1_REAL_VENDOR: ${vendor}`)
const model = vendor === 'codex' ? 'gpt-5.6-luna' : 'sonnet'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(250)
  }
  throw new Error(`${why}: timeout`)
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1500)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')
  return port
}
const request = async (base, path, init = {}) => {
  const response = await fetch(`${base}/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN, ...(init.headers ?? {}) },
  })
  let data = null
  try { data = await response.json() } catch {}
  return { response, data }
}
const run = (file, args, env, timeout = 240_000) => new Promise(resolve => {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    resolve({ code, signal, stdout, stderr })
  })
})

const startClient = (port, room, member, credential) => {
  const child = spawn(process.execPath, [ROOM_CLIENT], {
    env: {
      ...process.env,
      PEERTABLE_URL: `http://127.0.0.1:${port}`,
      PEERTABLE_ROOM: room,
      PEERTABLE_MEMBER: member,
      PEERTABLE_CREDENTIAL_FILE: credential,
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
  const call = (method, params = {}) => {
    const id = nextId++
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { child, call, notify, stderr: () => stderr }
}

const root = await mkdtemp(join(tmpdir(), 'peertable-member-turn-real-'))
const data = join(root, 'room-data')
const tokenSource = join(root, 'token-source')
const socket = join(root, 'tmux.sock')
const project = join(root, 'project')
const room = `member-turn-real-${process.pid}`
const seat = `${vendor}-real-${process.pid}`
const parentName = 'bell'
const credential = join(project, '.team', 'credentials', `${seat}.token`)
let server = null
let parent = null
let launch = null
let serverOutput = ''
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  const port = await freePort()
  await mkdir(join(project, '.team'), { recursive: true })
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room, server_url: `http://127.0.0.1:${port}`, mode: 'standalone', plan_key: '', added_root_mcp: true,
  }) + '\n')
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { room: { command: process.execPath, args: [ROOM_CLIENT] } },
  }) + '\n')
  await writeFile(tokenSource, `PEERTABLE_POST_TOKEN=${TOKEN}\n`, { mode: 0o600 })

  server = spawn(process.execPath, [ROOM_SERVER], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: TOKEN, PEERTABLE_PARENT_NAME: parentName },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  server.stderr.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  await waitFor(() => serverOutput.includes(`on :${port}`), '実E2E room server', 20_000)
  const base = `http://127.0.0.1:${port}/api/${room}`
  await request(base, 'members', { method: 'POST', body: JSON.stringify({ name: parentName }) })

  parent = startClient(port, room, parentName, tokenSource)
  const initialized = await parent.call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'k1-real-parent', version: '1' },
  })
  parent.notify('notifications/initialized')
  check('実親room clientが起動する', Boolean(initialized.result))
  await sleep(250)

  const env = { ...process.env, PEERTABLE_TMUX_SOCKET: socket, PEERTABLE_TOKEN_SOURCE_FILE: tokenSource }
  const brief = 'この実席E2Eではコードを変更せず、短い完了文だけ返してください。marker: K1_MEMBER_TURN_COMPLETED_REAL'
  launch = await run(LAUNCH, [project, seat, model, vendor, 'high', brief], env)
  check(`${vendor}相当の実席が正規launch-seatで起動する`, launch.code === 0, (launch.stderr || launch.stdout).split('\n').slice(-8).join('\n'))

  const event = await (async () => {
    let result = null
    await waitFor(async () => {
      const messages = (await request(base, 'messages')).data.messages ?? []
      result = messages.find(message => message.type === 'member_turn_completed' && message.actor === seat)
      return Boolean(result)
    }, `実${vendor} turn完了DM`, 120_000)
    return result
  })()
  check(`実${vendor}の発言終了から親専用eventが発射される`, event?.to === parentName && !('to_names' in event), JSON.stringify(event))
  check(`実${vendor}の親DM本文はroom生成のtyped本文`, event?.body === `[メンバーturn完了] ${seat}`, event?.body)

  const unread = await parent.call('tools/call', { name: 'read_unread', arguments: {} })
  const text = unread.result?.content?.[0]?.text ?? ''
  check('実親read_unreadがmember turn本文を取得する', text.includes(`[メンバーturn完了] ${seat}`), text)
  const again = await parent.call('tools/call', { name: 'read_unread', arguments: {} })
  check('実親の既読後に同じDMを再取得しない', again.result?.content?.[0]?.text === '未読なし', again.result?.content?.[0]?.text)
} catch (error) {
  console.error(`REAL E2E ERROR: ${error.message}`)
  good = false
} finally {
  await stop(parent?.child)
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  await stop(server)
  if (serverOutput) console.error(serverOutput.split('\n').slice(-5).join('\n'))
  await rm(root, { recursive: true, force: true })
}

console.log(good ? `real ${vendor} member-turn completion: green` : `real ${vendor} member-turn completion: red`)
process.exit(good ? 0 : 1)
