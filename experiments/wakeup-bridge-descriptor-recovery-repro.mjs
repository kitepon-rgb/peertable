#!/usr/bin/env node
// k1 focused harness:
//   current member name -> observe descriptor のみを配送経路にすること、
//   descriptor/注入失敗を pending と cursor に保持して復旧後一度だけ届けること、
//   parent-join 経由の Bell 外部席を実席で起こせることを測る。
//
// 修正前は次のどれかで RED になる。
//   - 起動引数に無い Claude 席を Codex 限定の reconcile が落とす
//   - descriptor の無い Bell を static seat + 既定 socket へ送る
//   - 注入失敗後に pending と lastSeq を先に確定し、descriptor 復旧後に再送しない
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const PARENT_JOIN = join(REPO, 'skill', 'scripts', 'parent-join.sh')
const ROOM = 'wakeup-bridge-descriptor-recovery'
const STATIC_SEAT = 'old-codex'
const ADDED_SEAT = 'added-claude'
const BELL = 'bell'
const FAILED_SEAT = 'recover-seat'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise(resolve => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const waitFor = async (predicate, timeout = 12_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(80)
  }
  return false
}
const stop = async child => {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const root = await mkdtemp(join(tmpdir(), 'peertable-wakeup-descriptor-recovery-'))
const project = join(root, 'project')
const data = join(root, 'room-data')
const socket = join(root, 'tmux.sock')
const capture = join(root, 'wake.txt')
const adapterDir = join(root, 'external-adapter')
const adapterParentJoin = join(adapterDir, 'parent-join.sh')
const adapterEnsure = join(adapterDir, 'ensure-bridge.sh')
const ensureLog = join(root, 'ensure.log')
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const base = `${baseUrl}/api/${ROOM}`

let server = null
let bridge = null
let parentSessionReady = false
let serverError = ''
const bridgeLog = []
let good = true
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) good = false
}
const request = async (path, init = {}) => {
  const response = await fetch(`${base}/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  let data = null
  try { data = await response.json() } catch {}
  return { response, data }
}
const member = (name, metadata = {}) => request('members', {
  method: 'POST',
  body: JSON.stringify({ name, ...metadata }),
})
const message = (from, to, body) => request('messages', {
  method: 'POST',
  body: JSON.stringify({ from, to, body }),
})
const readCapture = async () => (await readFile(capture, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const linesFor = async text => (await readCapture()).filter(line => line.includes(text))
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim()
const startPane = (session, command = `cat >> ${shellQuote(capture)}`) => {
  tmux('new-session', '-d', '-s', session, '-x', '120', '-y', '30', command)
}
const killPane = session => { try { tmux('kill-session', '-t', session) } catch {} }
const descriptor = target => ({ tmux_socket: socket, tmux_target: target })

try {
  await mkdir(join(project, '.team'), { recursive: true })
  await mkdir(adapterDir, { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(capture, '')
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: baseUrl,
    mode: 'standalone',
  }) + '\n')

  // parent-join の本体はそのまま使う。capacity の副作用だけは fixture の薄い stub へ隔離する。
  await copyFile(PARENT_JOIN, adapterParentJoin)
  await writeFile(ensureLog, '')
  await writeFile(adapterEnsure, `#!/bin/bash
printf '%s\\n' "$*" >> ${shellQuote(ensureLog)}
`)
  await chmod(adapterParentJoin, 0o755)
  await chmod(adapterEnsure, 0o755)

  server = spawn(process.execPath, [ROOM_SERVER], {
    env: { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', chunk => { serverError += chunk.toString('utf8') })
  const roomReady = await waitFor(async () => {
    try { return (await request('members')).response.ok } catch { return false }
  }, 8_000)
  check('fixture room server が起動する', roomReady, serverError.trim().slice(-300))
  if (!roomReady) throw new Error('fixture room server がlistenしない')

  startPane(`peer-${STATIC_SEAT}`)
  await member(STATIC_SEAT, { vendor: 'codex', observe: descriptor(`peer-${STATIC_SEAT}`) })

  bridge = spawn(process.execPath, [BRIDGE, project, STATIC_SEAT, BELL, FAILED_SEAT], {
    env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stdout.on('data', chunk => bridgeLog.push(chunk.toString('utf8')))
  bridge.stderr.on('data', chunk => bridgeLog.push(chunk.toString('utf8')))
  check('bridge が current members を正本として ready になる', await waitFor(async () => {
    try { return Boolean(JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge.json'), 'utf8')).ready_at) } catch { return false }
  }), bridgeLog.join('').slice(-400))
  await sleep(2_500)
  await writeFile(capture, '')

  // 1. 起動後追加の非Codex席。修正前は vendor=claude を reconcile から落とす。
  startPane(`peer-${ADDED_SEAT}`)
  await member(ADDED_SEAT, { vendor: 'claude', observe: descriptor(`peer-${ADDED_SEAT}`) })
  await sleep(2_500)
  await writeFile(capture, '')
  await message('bell', ADDED_SEAT, 'added Claude seat')
  const addedWake = `[Peertable DM #`
  check('追加Claude席へ current descriptor 経由で一度だけwakeする', await waitFor(async () => (await linesFor(addedWake)).length >= 1), bridgeLog.join('').slice(-500))
  check('wakeだけで本文が届く', (await linesFor('added Claude seat')).length === 1, JSON.stringify(await linesFor('added Claude seat')))
  await sleep(2_500)
  check('追加Claude席のwakeが重複しない', (await linesFor(addedWake)).length === 1, JSON.stringify(await linesFor(addedWake)))

  // 2. static引数と既定socketだけではBellを起こさない。descriptor無しのままは失敗を保持する。
  startPane(`peer-${BELL}`)
  await member(BELL)
  await sleep(2_500)
  await writeFile(capture, '')
  await message('asahi', BELL, 'bell waits for external descriptor')
  const bellWake = `asahi → ${BELL}`
  await sleep(2_500)
  check('Bell descriptor不在ではstatic seat/legacy socketへ送らない', (await linesFor(bellWake)).length === 0, JSON.stringify(await linesFor(bellWake)))
  check('Bell descriptor不在がtyped failureとして記録される', bridgeLog.join('').includes('WAKEUP_BRIDGE_DELIVERY_FAILURE') && bridgeLog.join('').includes('DESCRIPTOR_MISSING'), bridgeLog.join('').slice(-800))

  // parent-join.sh を実際のtmux外部席で実行し、同じBell identityへdescriptorを登録する。
  // 親paneはjoin後も cat で生かし、bridgeのsend-keysを実際に受ける。
  const parentCommand = `${adapterParentJoin} ${project} ${BELL} '' '' claude; exec cat >> ${capture}`
  tmux('new-session', '-d', '-s', 'bell-external', '-x', '120', '-y', '30', `bash -lc ${shellQuote(parentCommand)}`)
  parentSessionReady = true
  check('Bell external adapter が同じnameへlive descriptorを登録する', await waitFor(async () => {
    const members = (await request('members')).data?.members ?? []
    return members.some(item => item.name === BELL && item.observe?.tmux_target)
  }), bridgeLog.join('').slice(-600))
  const ensureOrderReady = await waitFor(async () => {
    const calls = (await readFile(ensureLog, 'utf8')).split(/\r?\n/).filter(Boolean)
    return calls.length >= 2
  })
  const ensureCalls = (await readFile(ensureLog, 'utf8')).split(/\r?\n/).filter(Boolean)
  check('Bell external adapter はwakeup ready後にcapacityを登録する', ensureOrderReady && ensureCalls[0]?.endsWith(`wakeup ${BELL}`) && ensureCalls[1]?.endsWith('capacity'), JSON.stringify(ensureCalls))
  check('Bell descriptor復旧後、保留DMを一度だけwakeする', await waitFor(async () => (await linesFor(bellWake)).length === 1), bridgeLog.join('').slice(-900))

  await message('asahi', BELL, 'bell external descriptor live')
  check('Bell external adapterへの新規DMも同じdescriptor経路で届く', await waitFor(async () => (await linesFor(bellWake)).length === 2), bridgeLog.join('').slice(-900))
  await sleep(2_500)
  check('Bell external adapterへのDMがexactly-once', (await linesFor(bellWake)).length === 2, JSON.stringify(await linesFor(bellWake)))

  // 3. 注入先が死んでいる間にcursorを進めず、descriptor/PTY復旧後に同じseqを一度だけ再送する。
  await member(FAILED_SEAT, { vendor: 'codex', observe: descriptor(`peer-${FAILED_SEAT}`) })
  await sleep(2_500)
  await writeFile(capture, '')
  const failedDelivery = await message('bell', FAILED_SEAT, 'descriptor recovers after injection failure')
  const failedSeq = failedDelivery.data?.seq
  const failedWake = `bell → ${FAILED_SEAT}`
  await sleep(2_500)
  check('注入先が死んでいる間は成功扱いにしない', (await linesFor(failedWake)).length === 0, bridgeLog.join('').slice(-900))
  const failedState = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('注入失敗後にlastSeqを前進させない', Number.isSafeInteger(failedSeq) && failedState.last_seq < failedSeq, JSON.stringify({ failedSeq, last_seq: failedState.last_seq }))
  startPane(`peer-${FAILED_SEAT}`)
  await member(FAILED_SEAT, { vendor: 'codex', observe: descriptor(`peer-${FAILED_SEAT}`) })
  check('descriptor/PTY復旧後に失敗DMを一度だけ再送する', await waitFor(async () => (await linesFor(failedWake)).length === 1), bridgeLog.join('').slice(-1200))
  await sleep(3_000)
  check('失敗復旧後の再送がexactly-once', (await linesFor(failedWake)).length === 1, JSON.stringify(await linesFor(failedWake)))
  const recoveredState = JSON.parse(await readFile(join(project, '.team', 'wakeup-bridge-delivery.json'), 'utf8'))
  check('復旧後だけ宛先receiptとlastSeqを確定する', recoveredState.delivered.includes(`${failedSeq}:${FAILED_SEAT}`) && recoveredState.last_seq >= failedSeq, JSON.stringify({ failedSeq, last_seq: recoveredState.last_seq }))
} catch (error) {
  console.error(`HARNESS ERROR: ${error.stack ?? error.message}\nserver stderr: ${serverError}`)
  good = false
} finally {
  await stop(bridge)
  killPane(`peer-${STATIC_SEAT}`)
  killPane(`peer-${ADDED_SEAT}`)
  killPane(`peer-${BELL}`)
  killPane(`peer-${FAILED_SEAT}`)
  if (parentSessionReady) killPane('bell-external')
  await stop(server)
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'wakeup bridge descriptor recovery: green' : 'wakeup bridge descriptor recovery: RED')
process.exit(good ? 0 : 1)
