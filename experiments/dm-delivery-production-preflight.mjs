#!/usr/bin/env node
// 本番配備前の配布物smoke。公開・deployはせず、npm packの実物を一時展開して測る。
//
// 検査順: tarball files → client diagnostics → 展開版room server →
// 展開版wakeup-bridgeでDM保存・一回wake。source treeだけのgreenを配布物greenと取り違えない。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = 'k1-production-preflight-token'
const ROOM = 'k1-production-preflight'
const SEAT = 'preflight-codex'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, why, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`${why}: timeout`)
    await sleep(100)
  }
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
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

const root = await mkdtemp(join(tmpdir(), 'peertable-dm-production-preflight-'))
const unpack = join(root, 'unpack')
const project = join(root, 'project')
const data = join(root, 'room-data')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
await mkdir(unpack, { recursive: true })
await mkdir(join(project, '.team'), { recursive: true })
await writeFile(capture, '')

let roomServer = null
let bridge = null
let tmuxReady = false
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}

try {
  const packOutput = execFileSync('npm', [
    'pack', '--ignore-scripts', '--pack-destination', root, '--json',
  ], { cwd: REPO, encoding: 'utf8' })
  const packResult = JSON.parse(packOutput)
  const files = packResult[0]?.files ?? []
  const paths = files.map(file => file.path)
  const required = [
    'room/server.mjs',
    'room/client.mjs',
    'skill/scripts/wakeup-bridge.mjs',
    'skill/scripts/ensure-bridge.sh',
    'skill/scripts/seat-usage.mjs',
  ]
  check('npm packの配布物へroom/bridge正本が入る', required.every(path => paths.includes(path)), required.filter(path => !paths.includes(path)).join(', '))
  check('npm packへ開発専用fixture/stateが混入しない', !paths.some(path => /^(package\/)?(?:experiments|\.lattice|\.team|evidence)\//u.test(path)), paths.filter(path => /(?:experiments|\.lattice|\.team|evidence)/u.test(path)).join(', '))

  const tarball = packResult[0]?.filename
  const tarballPath = tarball && (tarball.startsWith('/') ? tarball : join(root, tarball))
  execFileSync('tar', ['-xzf', tarballPath, '-C', unpack])
  const packaged = join(unpack, 'package')
  check('npm pack成果物を一時展開できる', Boolean(tarball) && Boolean(packaged))

  const diagnostics = spawnSync(process.execPath, [join(REPO, 'room', 'client.mjs'), 'diagnostics', '--json'], {
    env: { ...process.env, PEERTABLE_URL: '' },
    encoding: 'utf8',
  })
  let diagnosticsJson = null
  try { diagnosticsJson = JSON.parse(diagnostics.stdout.trim()) } catch {}
  check('source client diagnosticsが配備前green', diagnostics.status === 0 && diagnosticsJson?.overall === 'ready', diagnostics.stdout.trim() || diagnostics.stderr.trim())

  const port = await freePort()
  roomServer = spawn(process.execPath, [join(packaged, 'room', 'server.mjs')], {
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
  roomServer.stderr.on('data', chunk => { roomError += chunk.toString('utf8') })
  const serverUrl = `http://127.0.0.1:${port}`
  const base = `${serverUrl}/api/${ROOM}`
  await waitFor(async () => {
    try { return (await fetch(`${base}/members`)).ok } catch { return false }
  }, '展開版room server', 20_000)
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({ room: ROOM, server_url: serverUrl }) + '\n')
  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', `peer-${SEAT}`, '-x', '120', '-y', '30', `cat >> ${capture}`])
  tmuxReady = true

  const member = await fetch(`${base}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ name: SEAT, vendor: 'codex', observe: { tmux_socket: socket, tmux_target: `peer-${SEAT}` } }),
  })
  check('展開版roomへCodex観測席を登録できる', member.ok)

  const logs = []
  bridge = spawn(process.execPath, [join(packaged, 'skill', 'scripts', 'wakeup-bridge.mjs'), project, SEAT], {
    env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket, PEERTABLE_POST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.on('data', chunk => logs.push(chunk.toString('utf8')))
  bridge.stderr.on('data', chunk => logs.push(chunk.toString('utf8')))
  await waitFor(() => logs.join('').includes('頭出し:'), '展開版bridge初回頭出し')

  const body = '[k1-production-preflight] packaged bridge exactly once'
  const sent = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': TOKEN },
    body: JSON.stringify({ from: 'bell', to: SEAT, body }),
  })
  const saved = await sent.json()
  check('展開版roomへDMを保存できる', sent.ok && saved.seq > 0, JSON.stringify(saved))
  const wakeText = `room に新着あり（bell → ${SEAT}）`
  await waitFor(async () => (await readFile(capture, 'utf8')).includes(wakeText), '展開版bridge wake')
  const delivered = await readFile(capture, 'utf8')
  const wakeCount = delivered.split('\n').filter(line => line.includes(wakeText)).length
  check('展開版bridgeがDMを一回だけwakeする', wakeCount === 1, delivered.trim())
  if (roomError) console.error(`room stderr: ${roomError.trim().split('\n').slice(-3).join('\n')}`)
} catch (error) {
  console.error(`HARNESS ERROR: ${error.message}`)
  good = false
} finally {
  await stop(bridge)
  if (tmuxReady) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  }
  await stop(roomServer)
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'production preflight: green' : 'production preflight: red')
process.exit(good ? 0 : 1)
