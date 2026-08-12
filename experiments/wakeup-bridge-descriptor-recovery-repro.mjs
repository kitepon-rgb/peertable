#!/usr/bin/env node
// k1 focused harness:
//   current member name -> observe descriptor のみを配送経路にすること、
//   descriptor/注入失敗を pending と cursor に保持して復旧後一度だけ届けること、
//   descriptor欠損と注入失敗を、通常席のcurrent descriptor復旧後に一度だけ届けることを測る。
//
// 修正前は次のどれかで RED になる。
//   - 起動引数に無い Claude 席を Codex 限定の reconcile が落とす
//   - descriptor の無い通常席を static seat + 既定 socket へ送る
//   - 注入失敗後に pending と lastSeq を先に確定し、descriptor 復旧後に再送しない
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOM_SERVER = join(REPO, 'room', 'server.mjs')
const BRIDGE = join(REPO, 'skill', 'scripts', 'wakeup-bridge.mjs')
const ROOM = 'wakeup-bridge-descriptor-recovery'
const STATIC_SEAT = 'old-codex'
const ADDED_SEAT = 'added-claude'
const MISSING_DESCRIPTOR_SEAT = 'missing-descriptor-seat'
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
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const base = `${baseUrl}/api/${ROOM}`

let server = null
let bridge = null
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
  await mkdir(data, { recursive: true })
  await writeFile(capture, '')
  await writeFile(join(project, '.team', 'setup-state.json'), JSON.stringify({
    room: ROOM,
    server_url: baseUrl,
    mode: 'standalone',
  }) + '\n')

  const serverEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data }
  delete serverEnv.PEERTABLE_POST_TOKEN
  server = spawn(process.execPath, [ROOM_SERVER], {
    env: serverEnv,
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

  bridge = spawn(process.execPath, [BRIDGE, project, STATIC_SEAT, MISSING_DESCRIPTOR_SEAT, FAILED_SEAT], {
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

  // 2. static引数と既定socketだけでは通常席を起こさない。descriptor無しのままは失敗を保持する。
  startPane(`peer-${MISSING_DESCRIPTOR_SEAT}`)
  await member(MISSING_DESCRIPTOR_SEAT, { vendor: 'codex' })
  await sleep(2_500)
  await writeFile(capture, '')
  await message('asahi', MISSING_DESCRIPTOR_SEAT, 'seat waits for current descriptor')
  const missingDescriptorWake = `asahi → ${MISSING_DESCRIPTOR_SEAT}`
  await sleep(2_500)
  check('descriptor不在ではstatic seat/legacy socketへ送らない', (await linesFor(missingDescriptorWake)).length === 0, JSON.stringify(await linesFor(missingDescriptorWake)))
  check('descriptor不在がtyped failureとして記録される', bridgeLog.join('').includes('WAKEUP_BRIDGE_DELIVERY_FAILURE') && bridgeLog.join('').includes('DESCRIPTOR_MISSING'), bridgeLog.join('').slice(-800))

  await member(MISSING_DESCRIPTOR_SEAT, { vendor: 'codex', observe: descriptor(`peer-${MISSING_DESCRIPTOR_SEAT}`) })
  check('current descriptor復旧後、保留DMを一度だけwakeする', await waitFor(async () => (await linesFor(missingDescriptorWake)).length === 1), bridgeLog.join('').slice(-900))

  await message('asahi', MISSING_DESCRIPTOR_SEAT, 'current descriptor live')
  check('復旧後の新規DMも同じdescriptor経路で届く', await waitFor(async () => (await linesFor(missingDescriptorWake)).length === 2), bridgeLog.join('').slice(-900))
  await sleep(2_500)
  check('descriptor復旧後のDMがexactly-once', (await linesFor(missingDescriptorWake)).length === 2, JSON.stringify(await linesFor(missingDescriptorWake)))

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
  killPane(`peer-${MISSING_DESCRIPTOR_SEAT}`)
  killPane(`peer-${FAILED_SEAT}`)
  await stop(server)
  await rm(root, { recursive: true, force: true })
}

console.log(good ? 'wakeup bridge descriptor recovery: green' : 'wakeup bridge descriptor recovery: RED')
process.exit(good ? 0 : 1)
