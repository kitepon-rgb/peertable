#!/usr/bin/env node
// h3 focused harness: 無関係なMCP warningが表示されても、room MCPのmember登録と
// 実際のroom read/postが成立した席だけを成功として扱うことを測る。
// member登録が無い場合は、Codexのヘッダが出ていてもtyped failureとrollbackになる。
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH = join(REPO, 'skill/scripts/launch-seat.sh')
const SERVER = join(REPO, 'room/server.mjs')
const CLIENT = join(REPO, 'room/client.mjs')
const realTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim()
const TOKEN = 'H3_ROOM_FIXTURE_TOKEN_4d91'
const ROOM = 'h3-room-isolation'
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

const startMcpClient = env => {
  const child = spawn(process.execPath, [CLIENT], { env, stdio: ['pipe', 'pipe', 'pipe'] })
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
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  const call = (method, params = {}) => new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { child, call, stderr: () => stderr }
}

const root = await mkdtemp(join(tmpdir(), 'peertable-h3-room-'))
const home = join(root, 'home')
const project = join(root, 'project')
const data = join(root, 'data')
const bin = join(root, 'bin')
const shellRc = join(home, '.zshrc')
const socket = join(root, 'tmux.sock')
const argsLog = join(root, 'codex-args.log')
const credentialHelper = join(root, 'seat-credential.mjs')
const registerHelper = join(root, 'register-room-member.mjs')
const fixedLaunch = join(root, 'launch-seat-fixed.sh')
const notReadyLaunch = join(root, 'launch-seat-not-ready.sh')
const setupState = join(project, '.team', 'setup-state.json')
const credentialPath = (name) => join(project, '.team', 'credentials', `${ROOM}-${name}.token`)

await mkdir(join(project, '.team', 'seats'), { recursive: true })
await mkdir(join(project, '.team', 'credentials'), { recursive: true })
await mkdir(home, { recursive: true })
await mkdir(bin, { recursive: true })
await writeFile(join(root, 'tmux-socket.mjs'),
  "process.stdout.write(process.env.PEERTABLE_TMUX_SOCKET ?? '')\n")
await writeFile(join(root, 'ensure-bridge.sh'), '#!/bin/bash\nexit 0\n')
await chmod(join(root, 'ensure-bridge.sh'), 0o755)

await writeFile(credentialHelper, `#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const token = ${JSON.stringify(TOKEN)}
const [action, ...args] = process.argv.slice(2)
const credential = (project, room, name) => join(project, '.team', 'credentials', \`${'${room}-${name}'}\`.concat('.token'))
if (action === 'prepare') {
  const [project, room, name] = args
  const path = credential(project, room, name)
  mkdirSync(join(project, '.team', 'credentials'), { recursive: true, mode: 0o700 })
  writeFileSync(path, token + '\\n', { mode: 0o600 })
  console.log(path)
} else if (action === 'remove') {
  rmSync(args[1], { force: true })
} else if (action === 'request') {
  const [path, method, url, body] = args
  const init = { method, headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': readFileSync(path, 'utf8').trim() } }
  if (body) init.body = body
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) { process.stderr.write(text); process.exit(1) }
  process.stdout.write(text)
} else process.exit(2)
`)
await chmod(credentialHelper, 0o755)

await writeFile(registerHelper, `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const [url, room, name, credential] = process.argv.slice(2)
const token = readFileSync(credential, 'utf8').trim()
const response = await fetch(\`${'${url}'}/api/${'${room}'}/members\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token },
  body: JSON.stringify({ name }),
})
if (!response.ok) { process.stderr.write(await response.text()); process.exit(1) }
`)
await chmod(registerHelper, 0o755)

// preflightは成功し、対話起動時は無関係warningを表示するfake Codex。
// ROOM_REGISTER=1 の時だけroom member登録を行うため、同じ起動経路で成功／失敗を比較できる。
await writeFile(join(bin, 'codex'), `#!/bin/bash
if [ "\$1" = exec ]; then echo pong; exit 0; fi
printf '%s\\n' "\$*" >> "\$CODEX_ARGS_LOG"
printf 'OpenAI Codex (v0.147.0)\\n'
printf 'MCP warning: X-HERMES-MCP startup interrupted\\n'
if [ "\${ROOM_REGISTER:-0}" = 1 ]; then
  node "\$ROOM_REGISTER_HELPER" "\$PEERTABLE_URL" "\$PEERTABLE_ROOM" "\$PEERTABLE_MEMBER" "\$PEERTABLE_CREDENTIAL_FILE"
fi
printf 'gpt-5.6-luna high · ~/project\\n'
printf '›\\n'
while :; do sleep 1; done
`)
await chmod(join(bin, 'codex'), 0o755)

const source = await readFile(LAUNCH, 'utf8')
const boundSource = source.replace(
  'peertable_repo=$(cd "$(dirname "$0")/../.." && pwd -P)',
  `peertable_repo=${JSON.stringify(REPO)}`,
)
assert.notEqual(boundSource, source, 'fixtureが実client pathへ束縛できる')
await writeFile(fixedLaunch, boundSource)
await chmod(fixedLaunch, 0o755)
const shortRoomWait = boundSource.replace(
  'room_ready_deadline=$((SECONDS + 30))',
  'room_ready_deadline=$((SECONDS + 2))',
)
assert.notEqual(shortRoomWait, boundSource, '失敗側のroom待機を短縮できる')
await writeFile(notReadyLaunch, shortRoomWait)
await chmod(notReadyLaunch, 0o755)

const port = await freePort()
await writeFile(setupState, JSON.stringify({
  room: ROOM,
  server_url: `http://127.0.0.1:${port}`,
  mode: 'team',
  plan_key: null,
}) + '\n')

let server = null
let serverOutput = ''
let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok: ${label}`) }
const baseEnv = {
  ...process.env,
  HOME: home,
  ZDOTDIR: home,
  TMPDIR: root,
  PATH: `${bin}:${process.env.PATH}`,
  PEERTABLE_TMUX_SOCKET: socket,
  PEERTABLE_CREDENTIAL_HELPER: credentialHelper,
  ROOM_REGISTER_HELPER: registerHelper,
  CODEX_ARGS_LOG: argsLog,
  NODE_DISABLE_COMPILE_CACHE: '1',
}
const run = (script, name, register) => {
  // tmuxのzshはserver環境だけでなくZDOTDIRのrcも読む。fixture commandと登録条件を
  // そこへ明示して、親shellの実Codex／既存PATHへ黙って逸れないようにする。
  writeFileSync(shellRc, [
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export ROOM_REGISTER=${register ? '1' : '0'}`,
    `export ROOM_REGISTER_HELPER=${JSON.stringify(registerHelper)}`,
    `export CODEX_ARGS_LOG=${JSON.stringify(argsLog)}`,
    '',
  ].join('\n'))
  return spawnSync('/bin/bash',
    [...(process.env.H3_TRACE === '1' ? ['-x'] : []), script, project, name, 'gpt-5.6-luna', 'codex', 'high', ''],
    { env: { ...baseEnv, ROOM_REGISTER: register ? '1' : '0' }, encoding: 'utf8', timeout: 60_000 })
}
const readRoomMembers = async () => {
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members`)
      return await response.json()
    } catch (error) {
      lastError = error
      await wait(100)
    }
  }
  throw new Error(`room members read failed after retry: ${lastError?.message}; server=${server?.exitCode}; output=${serverOutput}`)
}

try {
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: data,
      PEERTABLE_POST_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  server.stderr.on('data', chunk => { serverOutput += chunk.toString('utf8') })
  for (let i = 0; i < 120 && !serverOutput.includes(`on :${port}`); i++) await wait(50)
  assert.match(serverOutput, new RegExp(`on :${port}`), serverOutput)

  const probeCodex = spawnSync('which', ['codex'], { env: baseEnv, encoding: 'utf8' })
  const probeSocket = spawnSync(process.execPath, [join(root, 'tmux-socket.mjs')], { env: baseEnv, encoding: 'utf8' })
  if (probeCodex.status !== 0 || probeSocket.stdout.trim() !== socket) {
    throw new Error(`h3 fixture preflight probe failed: which=${probeCodex.stdout}/${probeCodex.stderr} socket=${probeSocket.stdout}/${probeSocket.stderr}`)
  }

  // 1. warningが表示されても、room member登録を待ってから成功する。
  const success = run(fixedLaunch, 'fixture-seat', true)
  if (success.status === null) {
    const diagnosticArgs = existsSync(argsLog) ? readFileSync(argsLog, 'utf8') : '(引数ログなし)'
    const diagnosticTmux = spawnSync(realTmux,
      ['-S', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    console.error('h3 fixture launcher timeout:', success.error?.message ?? 'unknown')
    console.error('launcher stdout:', success.stdout)
    console.error('launcher stderr:', success.stderr)
    console.error('fake Codex args:', diagnosticArgs)
    console.error('tmux sessions:', diagnosticTmux.stdout, diagnosticTmux.stderr)
  }
  const successScreen = spawnSync(realTmux,
    ['-S', socket, 'capture-pane', '-t', 'peer-fixture-seat', '-p'], { encoding: 'utf8' }).stdout
  check('無関係MCP warningとroom着席を分離して成功する', () => {
    assert.equal(success.status, 0,
      success.stderr + '\nstdout=' + success.stdout + '\nscreen=' + successScreen)
    assert.match(success.stdout, /room ready: h3-room-isolation\/fixture-seat/)
    assert.match(successScreen, /MCP warning: X-HERMES-MCP startup interrupted/)
  })
  const args = readFileSync(argsLog, 'utf8')
  check('Codexへ必須room MCPのcommand・args・envを明示する', () => {
    assert.match(args, /mcp_servers\.room\.command/)
    assert.match(args, /mcp_servers\.room\.args/)
    assert.match(args, /mcp_servers\.room\.env/)
    assert.match(args, new RegExp(`mcp_servers\\.room\\.args=\\["${REPO.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\/room\\/client\\.mjs"\\]`))
  })

  // 2. launcherで使った本物のroom clientを同じroomへ接続し、read/postを実測する。
  const smokeCredential = spawnSync(process.execPath,
    [credentialHelper, 'prepare', project, ROOM, 'fixture-smoke'],
    { env: baseEnv, encoding: 'utf8' }).stdout.trim()
  const client = startMcpClient({
    ...baseEnv,
    PEERTABLE_URL: `http://127.0.0.1:${port}`,
    PEERTABLE_ROOM: ROOM,
    PEERTABLE_MEMBER: 'fixture-smoke',
    PEERTABLE_CREDENTIAL_FILE: smokeCredential,
  })
  try {
    const initialized = await client.call('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'h3-fixture', version: '1' },
    })
    assert.ok(initialized.result, JSON.stringify(initialized))
    client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await wait(100)
    const read = await client.call('tools/call', { name: 'read_log', arguments: { count: 20 } })
    const body = 'h3 room MCP read/post smoke'
    const posted = await client.call('tools/call', { name: 'post', arguments: { to: 'fixture-seat', message: body } })
    const messages = await fetch(`http://127.0.0.1:${port}/api/${ROOM}/messages`).then(response => response.json())
    check('実clientのroom read/postが成立する', () => {
      assert.ok(read.result?.content?.[0]?.text, JSON.stringify(read))
      assert.match(posted.result?.content?.[0]?.text ?? '', /^sent \[/, JSON.stringify(posted))
      assert.ok(messages.messages.some(message => message.body === body))
    })
  } finally {
    await stop(client.child)
    await rm(smokeCredential, { force: true })
  }

  const membersAfterSuccess = await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members`).then(response => response.json())
  check('room serverのmember登録を読み返せる', () => {
    assert.ok(membersAfterSuccess.members.some(member => member.name === 'fixture-seat'))
    assert.ok(membersAfterSuccess.members.some(member => member.name === 'fixture-smoke'))
  })
  const observed = [success.stdout, success.stderr, successScreen, args].join('\n')
  check('credentialの実値をlauncher出力・pane・Codex引数へ出さない', () => {
    assert.doesNotMatch(observed, new RegExp(TOKEN))
  })

  // 成功席を片付け、失敗側を同じ実serverへ独立に投入する。
  for (const name of ['fixture-seat', 'fixture-smoke']) {
    await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members/${name}`, {
      method: 'DELETE', headers: { 'X-Peertable-Token': TOKEN },
    })
  }
  spawnSync(realTmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' })

  // 3. ヘッダとwarningだけでroom未成立を成功扱いにしない。rollback後に痕跡が無い。
  // 旧席の同名memberが残っていても、起動前resetがそれをready証拠にさせない。
  await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ name: 'fixture-fail', vendor: 'old-seat', observe: { tmux_target: 'old-seat' } }),
  })
  const staleFailure = run(notReadyLaunch, 'fixture-fail', false)
  const staleMembers = await readRoomMembers()
  check('stale同名memberはready証拠にせず着席前conflictにする', () => {
    assert.notEqual(staleFailure.status, 0,
      staleFailure.stderr + '\nstdout=' + staleFailure.stdout)
    assert.match(staleFailure.stderr, /SEAT_ROOM_MEMBER_CONFLICT/)
    assert.doesNotMatch(staleFailure.stdout, /room ready/)
    assert.ok(staleMembers.members.some(member => member.name === 'fixture-fail'))
    assert.equal(existsSync(credentialPath('fixture-fail')), false)
    const session = spawnSync(realTmux, ['-S', socket, 'has-session', '-t', 'peer-fixture-fail'])
    assert.notEqual(session.status, 0)
  })
  await fetch(`http://127.0.0.1:${port}/api/${ROOM}/members/fixture-fail`, {
    method: 'DELETE', headers: { 'X-Peertable-Token': TOKEN },
  })

  // 同名conflictを解消した後、member未登録の新席はreadyにならずrollbackする。
  const failure = run(notReadyLaunch, 'fixture-fail', false)
  const failMembers = await readRoomMembers()
  check('room未着席はtyped failureでrollbackする', () => {
    assert.notEqual(failure.status, 0,
      failure.stderr + '\nstdout=' + failure.stdout)
    assert.match(failure.stderr, /SEAT_ROOM_MCP_NOT_READY/)
    assert.match(failure.stderr, /LAUNCH_BRIEF_ROLLED_BACK/)
    assert.ok(!failMembers.members.some(member => member.name === 'fixture-fail'))
    assert.equal(existsSync(credentialPath('fixture-fail')), false)
    const session = spawnSync(realTmux, ['-S', socket, 'has-session', '-t', 'peer-fixture-fail'])
    assert.notEqual(session.status, 0)
  })

  console.log(`mcp-room-isolation repro: ${checks}/${checks} green`)
} finally {
  spawnSync(realTmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' })
  await stop(server)
  await rm(root, { recursive: true, force: true })
}
