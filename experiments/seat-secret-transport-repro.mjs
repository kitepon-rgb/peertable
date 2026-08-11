#!/usr/bin/env node
// k2 focused harness: 席別credential fileとclientの非env輸送を実プロセスで測る。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPER = join(REPO, 'skill/scripts/seat-credential.mjs')
const MCP_HELPER = join(REPO, 'skill/scripts/ensure-room-mcp.mjs')
const SERVER = join(REPO, 'room/server.mjs')
const CLIENT = join(REPO, 'room/client.mjs')
const LEAVE = join(REPO, 'skill/scripts/leave-seat.sh')
const TOKEN = 'K2_SENTINEL_TOKEN_7f17c12a'
const ROOM = 'k2-secret-transport'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  await Promise.race([once(child, 'exit'), wait(1000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const run = (command, args, env) => new Promise(resolve => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('exit', code => resolve({ code, stdout, stderr }))
})

const startMcpClient = env => {
  const child = spawn(process.execPath, [CLIENT], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''; let stderr = ''; let nextId = 1
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) { pending.delete(message.id); resolve(message) }
    }
  })
  const call = (method, params = {}) => new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { child, call, stderr: () => stderr }
}

const root = mkdtempSync(join(tmpdir(), 'peertable-k2-'))
const home = join(root, 'home')
const project = join(root, 'project')
const data = join(root, 'data')
mkdirSync(join(home, '.config'), { recursive: true })
mkdirSync(join(project, '.team'), { recursive: true })
writeFileSync(join(home, '.config', 'peertable.env'), `export PEERTABLE_POST_TOKEN=${TOKEN}\n`, { mode: 0o600 })
const cleanEnv = { ...process.env, HOME: home }
delete cleanEnv.PEERTABLE_POST_TOKEN

let server = null
let client = null
try {
  const prepared = await run(process.execPath, [HELPER, 'prepare', project, ROOM, 'sender'], cleanEnv)
  assert.equal(prepared.code, 0, prepared.stderr)
  let credential = prepared.stdout.trim()
  assert.ok(credential.startsWith(join(project, '.team', 'credentials') + '/'))
  assert.equal(statSync(dirname(credential)).mode & 0o777, 0o700)
  assert.equal(statSync(credential).mode & 0o777, 0o600)
  assert.equal(readFileSync(credential, 'utf8').trim(), TOKEN)
  assert.ok(!prepared.stdout.includes(TOKEN) && !prepared.stderr.includes(TOKEN), 'helper outputへtokenが出た')

  const peerPrepared = await run(process.execPath, [HELPER, 'prepare', project, ROOM, 'peer'], cleanEnv)
  assert.equal(peerPrepared.code, 0, peerPrepared.stderr)
  const peerCredential = peerPrepared.stdout.trim()
  assert.notEqual(peerCredential, credential, '同じroomの別席がcredential fileを共有した')
  assert.equal(statSync(peerCredential).mode & 0o777, 0o600)

  const managedMcpProject = join(root, 'managed-mcp')
  mkdirSync(managedMcpProject)
  const managedMcp = join(managedMcpProject, '.mcp.json')
  writeFileSync(managedMcp, JSON.stringify({
    mcpServers: {
      room: { command: 'node', args: [CLIENT], env: { PEERTABLE_POST_TOKEN: TOKEN } },
      other: { command: 'other' },
    },
  }) + '\n')
  const syncedMcp = await run(process.execPath, [MCP_HELPER, managedMcpProject, REPO, 'managed'], cleanEnv)
  assert.equal(syncedMcp.code, 0, syncedMcp.stderr)
  const managedConfig = JSON.parse(readFileSync(managedMcp, 'utf8'))
  assert.deepEqual(managedConfig.mcpServers.room, { command: 'node', args: [CLIENT] })
  assert.equal(managedConfig.mcpServers.other.command, 'other', '管理下mcp同期が他serverを壊した')

  const preexistingMcpProject = join(root, 'preexisting-mcp')
  mkdirSync(preexistingMcpProject)
  const preexistingMcp = join(preexistingMcpProject, '.mcp.json')
  const staleMcp = `${JSON.stringify({
    mcpServers: { room: { command: 'node', args: [CLIENT], env: { PEERTABLE_POST_TOKEN: TOKEN } } },
  })}\n`
  writeFileSync(preexistingMcp, staleMcp)
  const refusedMcp = await run(process.execPath, [MCP_HELPER, preexistingMcpProject, REPO, 'preexisting'], cleanEnv)
  assert.notEqual(refusedMcp.code, 0, '既存mcpを無断更新した')
  assert.match(refusedMcp.stderr, /SEAT_ROOM_MCP_STALE/)
  assert.equal(readFileSync(preexistingMcp, 'utf8'), staleMcp)

  const second = await run(process.execPath, [HELPER, 'prepare', project, 'another-room', 'sender'], cleanEnv)
  assert.equal(second.code, 0, second.stderr)
  assert.notEqual(second.stdout.trim(), credential, '別roomがcredential fileを共有した')
  assert.throws(() => statSync(credential), /ENOENT/, 'room設定変更後に旧credentialが残った')
  const restored = await run(process.execPath, [HELPER, 'prepare', project, ROOM, 'sender'], cleanEnv)
  assert.equal(restored.code, 0, restored.stderr)
  credential = restored.stdout.trim()

  const port = await freePort()
  writeFileSync(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: `http://127.0.0.1:${port}`,
  }) + '\n')
  let serverOutput = ''
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data, PEERTABLE_POST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', chunk => { serverOutput += chunk })
  server.stderr.on('data', chunk => { serverOutput += chunk })
  for (let i = 0; i < 120 && !serverOutput.includes(`on :${port}`); i++) await wait(50)
  assert.ok(serverOutput.includes(`on :${port}`), serverOutput)

  const clientEnv = {
    ...cleanEnv,
    PEERTABLE_URL: `http://127.0.0.1:${port}`,
    PEERTABLE_ROOM: ROOM,
    PEERTABLE_MEMBER: 'sender',
    PEERTABLE_CREDENTIAL_FILE: credential,
  }
  client = startMcpClient(clientEnv)
  await client.call('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'k2-fixture', version: '1' },
  })
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await wait(200)

  const args = (await run('/bin/ps', ['-o', 'args=', '-p', String(client.child.pid)], cleanEnv)).stdout
  const environ = (await run('/bin/ps', ['eww', '-p', String(client.child.pid)], cleanEnv)).stdout
  assert.ok(!args.includes(TOKEN), 'client argvへtokenが出た')
  assert.ok(!environ.includes(TOKEN), 'client process envへtokenが出た')

  const posted = await client.call('tools/call', { name: 'post', arguments: { to: 'alice', message: 'fixture dm' } })
  assert.ok(posted.result?.content?.[0]?.text?.startsWith('sent ['), JSON.stringify(posted))
  await fetch(`http://127.0.0.1:${port}/api/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ from: 'alice', to: 'sender', body: 'fixture reply' }),
  })
  const unread = await client.call('tools/call', { name: 'read_unread', arguments: {} })
  assert.match(unread.result?.content?.[0]?.text ?? '', /fixture reply/)

  const leaver = await run(process.execPath, [HELPER, 'prepare', project, ROOM, 'leaver'], cleanEnv)
  assert.equal(leaver.code, 0, leaver.stderr)
  const leaverCredential = leaver.stdout.trim()
  await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ name: 'leaver' }),
  })
  mkdirSync(join(project, '.team', 'seats'), { recursive: true })
  const leaverIdentity = join(project, '.team', 'seats', 'leaver.json')
  writeFileSync(leaverIdentity, '{}\n', { mode: 0o600 })
  const fakeBin = join(root, 'bin')
  const tmuxMarker = join(root, 'tmux-killed')
  mkdirSync(fakeBin)
  const fakeTmux = join(fakeBin, 'tmux')
  writeFileSync(fakeTmux, `#!/bin/bash
if [ "\${TMUX_MODE:-}" = unreadable ]; then exit 1; fi
if [ "$3" = has-session ]; then [ ! -f "$TMUX_MARKER" ]; exit; fi
if [ "$3" = kill-session ]; then : > "$TMUX_MARKER"; exit 0; fi
exit 1
`)
  chmodSync(fakeTmux, 0o755)
  const left = await run('/bin/bash', [LEAVE, project, 'leaver'], {
    ...cleanEnv,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PEERTABLE_TMUX_SOCKET: join(root, 'tmux.sock'),
    TMUX_MARKER: tmuxMarker,
  })
  assert.equal(left.code, 0, left.stderr)
  assert.throws(() => statSync(leaverCredential), /ENOENT/, '通常退席後にcredentialが残った')
  assert.throws(() => statSync(leaverIdentity), /ENOENT/, '通常退席後にseat identityが残った')
  assert.equal(readFileSync(tmuxMarker, 'utf8'), '', '通常退席でsessionを畳んでいない')
  const membersAfterLeave = await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members`).then(r => r.json())
  assert.ok(!membersAfterLeave.members.some(member => member.name === 'leaver'), '通常退席後にroom memberが残った')

  const stuck = await run(process.execPath, [HELPER, 'prepare', project, ROOM, 'stuck'], cleanEnv)
  assert.equal(stuck.code, 0, stuck.stderr)
  const stuckCredential = stuck.stdout.trim()
  const stuckIdentity = join(project, '.team', 'seats', 'stuck.json')
  writeFileSync(stuckIdentity, '{}\n', { mode: 0o600 })
  const unreadableSocket = join(root, 'unreadable.sock')
  const refusedLeave = await run('/bin/bash', [LEAVE, project, 'stuck'], {
    ...cleanEnv,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PEERTABLE_TMUX_SOCKET: unreadableSocket,
    TMUX_MODE: 'unreadable',
  })
  assert.notEqual(refusedLeave.code, 0, 'session観測不能を退席成功に丸めた')
  assert.match(refusedLeave.stderr, /SEAT_LEAVE_SESSION_UNREADABLE/)
  assert.equal(statSync(stuckCredential).mode & 0o777, 0o600, 'session未停止なのにcredentialを先に消した')
  assert.equal(statSync(stuckIdentity).mode & 0o777, 0o600, 'session未停止なのにidentityを先に消した')
  const stuckRemoved = await run(process.execPath, [HELPER, 'remove', project, stuckCredential], cleanEnv)
  assert.equal(stuckRemoved.code, 0, stuckRemoved.stderr)
  rmSync(stuckIdentity)

  await stop(client.child)
  client = null
  const badEnv = {
    ...cleanEnv,
    PEERTABLE_URL: `http://127.0.0.1:${port}`,
    PEERTABLE_ROOM: ROOM,
    PEERTABLE_MEMBER: 'broken',
    PEERTABLE_CREDENTIAL_FILE: join(root, 'missing-token'),
    PEERTABLE_POST_TOKEN: TOKEN,
  }
  const bad = await run(process.execPath, [CLIENT], badEnv)
  assert.notEqual(bad.code, 0, '読めないcredential fileから平文envへfallbackした')
  assert.match(bad.stderr, /PEERTABLE_CREDENTIAL_(?:UNREADABLE|INVALID)/)
  assert.ok(!bad.stderr.includes(TOKEN), 'typed errorへtokenが出た')

  const missingPathEnv = { ...badEnv }
  delete missingPathEnv.PEERTABLE_CREDENTIAL_FILE
  const missingPath = await run(process.execPath, [CLIENT], missingPathEnv)
  assert.notEqual(missingPath.code, 0, 'credential path欠落時に平文envへfallbackした')
  assert.match(missingPath.stderr, /PEERTABLE_CREDENTIAL_MISSING/)
  assert.ok(!missingPath.stderr.includes(TOKEN), 'path欠落typed errorへtokenが出た')

  const removed = await run(process.execPath, [HELPER, 'remove', project, credential], cleanEnv)
  assert.equal(removed.code, 0, removed.stderr)
  assert.throws(() => statSync(credential), /ENOENT/)
  const peerRemoved = await run(process.execPath, [HELPER, 'remove', project, peerCredential], cleanEnv)
  assert.equal(peerRemoved.code, 0, peerRemoved.stderr)

  console.log('seat secret transport repro: green')
} finally {
  await stop(client?.child)
  await stop(server)
  rmSync(root, { recursive: true, force: true })
}
