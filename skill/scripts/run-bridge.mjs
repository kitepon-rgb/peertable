#!/usr/bin/env node
// Lattice の managed run と円卓の席をつなぐ配車ブリッジ。**AI ではない常駐**で、席へ1バイトも
// 送らない（room 経由で配車する）。
//
// usage: run-bridge.mjs <project_dir> <spool_dir> <seat> [seat...]   起動（前面。nohup で常駐させる）
//        run-bridge.mjs <project_dir> --stop                         停止
//
// 役割は4つだけ:
//   1. `<spool>/orders/<packet_digest>.json`（Lattice が書く）を見張る
//   2. 空いている席を選び、その席宛に work order を room へ投稿する（`[配車]`）
//   3. 席の `[受諾]` / `[辞退]` / `[完了]` を room の SSE で拾う
//   4. `<spool>/reports/<packet_digest>.json`（bridge が書く）へ state を書く
//
// **席は spool に触れない。** 席が読むのは room、書くのは worktree だけである（席の作法の正本は
// templates/member.md の「配車で来た仕事」節）。report を書けるのは bridge だけで、Lattice は
// report を「状態遷移の合図」としてしか使わない——diff は Lattice が worktree から独立に撮る。
//
// **worker_pid は受諾した席の process group leader である。** tmux の `pane_pid` は pane の shell で、
// 席本体とは別 process group に居る（実測: Claude 席 `claude`(pid=pgid) の親は `-zsh` で別 pgid、
// Codex 席も `node …/codex`(pid=pgid) が leader）。shell の pid を渡すと Lattice の直接 OS 観測が
// `worker process groupを無関係processと共有している` で正しく落ちる。
//
// 生死の作法は Lattice ADR 0157 に倣う: 自分の pid を記録に置き、起動時に前の記録を掃除し、
// 止まらなければ黙って諦めず typed error で落ちる。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const [proj, ...rest] = process.argv.slice(2)
if (!proj || rest.length === 0) {
  console.error('usage: run-bridge.mjs <project_dir> <spool_dir> <seat> [seat...] | <project_dir> --stop')
  process.exit(1)
}

const record = join(proj, '.team', 'run-bridge.json')
const sock = process.env.PEERTABLE_TMUX_SOCKET ?? `${process.env.TMPDIR}claude-tmux-sockets/claude.sock`
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = line => console.log(`[${new Date().toISOString()}] ${line}`)

// pid だけを頼りに signal を送らない（ADR 0157）。**pid は再利用される**ので、記録した
// 起動時刻（ps の lstart）と command line を照合し、通った相手にだけ送る。照合が合わない記録は
// 「自分の常駐ではない誰か」なので、掃除はしても**殺さない**。
async function processFacts(pid) {
  let stdout
  try { ({ stdout } = await run('/bin/ps', ['-o', 'lstart=,command=', '-p', String(pid)])) }
  catch { return null }
  const line = stdout.split('\n')[0]?.trim() ?? ''
  if (line.length === 0) return null
  // lstart は固定幅の `Sun Aug  9 08:11:02 2026`（5 token）。残りが command line
  const parts = line.split(/\s+/)
  return { startIdentity: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') }
}

async function stopRecorded({ strict = false } = {}) {
  if (!existsSync(record)) return
  const stored = JSON.parse(readFileSync(record, 'utf8'))
  const { pid } = stored
  const facts = await processFacts(pid)
  if (facts === null || !alive(pid)) {
    unlinkSync(record); log(`死んだ記録を掃除した（pid ${pid}）`); return
  }
  const sameProcess = stored.start_identity === undefined
    ? false   // 旧形式の記録は再認証できない＝殺さない
    : facts.startIdentity === stored.start_identity
      && facts.command.includes('run-bridge.mjs')
      && facts.command.includes(proj)
  if (!sameProcess) {
    unlinkSync(record)
    const detail = `pid ${pid} は記録した常駐ではない（観測: ${facts.startIdentity} / ${facts.command.slice(0, 120)}）`
    if (strict) {
      console.error(`RUN_BRIDGE_RECORD_STALE: ${detail}。**signal は送っていない**——`
        + '本物の常駐が別 pid で生きている可能性があるので、`ps` で確認して手で止めること')
      process.exit(1)
    }
    log(`RUN_BRIDGE_RECORD_STALE: ${detail}。signal を送らずに記録だけ掃除した`)
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(200)
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200)
  }
  if (alive(pid)) {
    console.error(`RUN_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`)
    process.exit(1)
  }
  if (existsSync(record)) unlinkSync(record)
  log(`前のブリッジを停止した（pid ${pid}）`)
}

await stopRecorded({ strict: rest[0] === '--stop' })
if (rest[0] === '--stop') process.exit(0)

// `--lattice <path>` は任意。既定は PATH 上の `lattice`。**release 前の source tree を実測する時**は
// ここで実物を指す（PATH の install は古い版で、新しい run store を `INVALID_RUN_STORE` と誤判定しうる）。
const latticeFlag = rest.indexOf('--lattice')
let latticeCli = 'lattice'
if (latticeFlag >= 0) {
  latticeCli = rest[latticeFlag + 1] ?? ''
  if (latticeCli.length === 0) {
    console.error('RUN_BRIDGE_ARGS_INVALID: --lattice には実行可能な path を渡すこと')
    process.exit(1)
  }
  rest.splice(latticeFlag, 2)
}

const [spool, ...seats] = rest
if (seats.length === 0) {
  console.error('RUN_BRIDGE_ARGS_INVALID: 席を1つ以上渡すこと')
  process.exit(1)
}
const ordersDir = join(spool, 'orders')
const reportsDir = join(spool, 'reports')
const state = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const { room, server_url: url } = state
const token = process.env.PEERTABLE_POST_TOKEN ?? ''
if (token.length === 0) {
  // 投稿できないブリッジは配車できない。起きてから黙って何もしない常駐を作らない
  console.error('RUN_BRIDGE_TOKEN_MISSING: PEERTABLE_POST_TOKEN が無い（export し忘れていないか）')
  process.exit(1)
}

// 記録には pid だけでなく**起動時刻と command line**を入れる。停止側はこれで再認証する
const selfFacts = await processFacts(process.pid)
if (selfFacts === null) {
  console.error('RUN_BRIDGE_SELF_UNOBSERVABLE: 自分の process を ps で観測できない')
  process.exit(1)
}
writeFileSync(record, JSON.stringify({
  pid: process.pid, start_identity: selfFacts.startIdentity, command: selfFacts.command,
  room, server_url: url, spool, seats, started_at: new Date().toISOString(),
}) + '\n')
const cleanup = () => { if (existsSync(record)) unlinkSync(record); process.exit(0) }
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

// ---- Lattice の canonical JSON（artifact-contracts.mjs と同じ形: key 辞書順・空白なし） ----
// **別 repo なので import できない。** 形が1バイトでも違うと controller が
// `work reportがpacketへexact bindしない` で落ちるので、ここは推測でなく実物と突き合わせる
// （検証: test/run-bridge-canonical.test.mjs 相当を Lattice 側の probe で実施・t4 証跡）。
function canonical(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('RUN_BRIDGE_CANONICAL_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  throw new TypeError('RUN_BRIDGE_CANONICAL_INVALID')
}

// ---- work order（Lattice が書く。bridge は読むだけ） ----
const ORDER_KEYS = ['schema', 'todo_id', 'worktree_path', 'base_sha', 'scope_writes',
  'verifier_refs', 'forbidden_operations', 'packet_digest', 'order_digest'].sort()

// **正本（Lattice の `validateRunWorkOrder`）と同じ強さで拒否する。** ここが緩いと、bridge が
// 不正な worktree path や scope を席へ配ってしまう——席は order を信じて worktree を触るので、
// 検査を Lattice 側だけに任せられない（Lattice は席が書いた後の diff しか見ない）。
const ID = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/
const SHA256 = /^[0-9a-f]{64}$/
const GIT_SHA1 = /^[0-9a-f]{40}$/
const MAX_ITEMS = 256

function safeWritePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === posix.normalize(value)
    && !posix.isAbsolute(value)
    && value !== '..'
    && !value.startsWith('../')
    && !value.includes('\\0')
    && !value.includes('\0')
    && !['.git', '.lattice'].includes(value.split('/')[0])
}

function stringArray(value, { min = 0, paths = false } = {}) {
  return Array.isArray(value) && value.length >= min && value.length <= MAX_ITEMS
    && value.every(entry => (paths ? safeWritePath(entry) : typeof entry === 'string'))
}

function selfDigestOf(value, field) {
  const projection = {}
  for (const key of Object.keys(value)) if (key !== field) projection[key] = value[key]
  return createHash('sha256').update(Buffer.from(canonical(projection), 'utf8')).digest('hex')
}

function validOrder(order) {
  return order !== null && typeof order === 'object' && !Array.isArray(order)
    && Object.keys(order).sort().join('\0') === ORDER_KEYS.join('\0')
    && order.schema === 'lattice.run_work_order.v1'
    && ID.test(order.todo_id ?? '')
    && typeof order.worktree_path === 'string' && posix.isAbsolute(order.worktree_path)
    && GIT_SHA1.test(order.base_sha ?? '')
    && stringArray(order.scope_writes, { paths: true })
    && stringArray(order.verifier_refs)
    && stringArray(order.forbidden_operations, { min: 1 })
    && SHA256.test(order.packet_digest ?? '')
    && SHA256.test(order.order_digest ?? '')
    && selfDigestOf(order, 'order_digest') === order.order_digest
}

// ---- report（bridge が書く。0600・canonical JSON+LF・temp→fsync→rename） ----
// controller は mode・realpath・byte 一致まで見る（0644 で書くと
// `work reportがprivate canonical regular fileでない` で落ちる・実測）。
async function writeReport(packetDigest, reportState, workerPid) {
  const report = {
    schema: 'lattice.run_work_report.v1',
    packet_digest: packetDigest,
    state: reportState,
    worker_pid: workerPid,
  }
  const target = join(reportsDir, `${packetDigest}.json`)
  const tmp = `${target}.bridge-tmp`
  await writeFile(tmp, `${canonical(report)}\n`, { mode: 0o600 })
  const handle = await open(tmp, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  await rename(tmp, target)
  log(`report: ${packetDigest.slice(0, 12)} state=${reportState} worker_pid=${workerPid}`)
}

async function readReport(packetDigest) {
  try { return JSON.parse(await readFile(join(reportsDir, `${packetDigest}.json`), 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

// ---- 席 ----
// 席本体は pane の shell ではなく、その子のうち process group leader（pid === pgid）である。
async function seatWorkerPid(seat) {
  const panes = await run('tmux', ['-S', sock, 'list-panes', '-t', `peer-${seat}`, '-F', '#{pane_pid}'])
  const panePid = Number(panes.stdout.trim().split('\n')[0])
  if (!Number.isSafeInteger(panePid) || panePid <= 0) {
    throw new TypeError(`RUN_BRIDGE_SEAT_UNRESOLVED: ${seat} の pane_pid を読めない`)
  }
  const ps = await run('/bin/ps', ['-Ao', 'pid=,ppid=,pgid='], { maxBuffer: 8 * 1024 * 1024 })
  const leaders = ps.stdout.split('\n').map(l => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, pgid]) => ppid === panePid && pid === pgid)
    .map(([pid]) => pid)
  if (leaders.length !== 1) {
    // 0件（席が落ちた・pane に別のものが居る）も複数件も、推測で1つ選ばない
    throw new TypeError(`RUN_BRIDGE_SEAT_UNRESOLVED: ${seat} の process group leader が ${leaders.length} 件`)
  }
  return leaders[0]
}

// 再起動後、working report が指す pid が今どの席のものかを引き当てる。
// 引き当てられなければ null（**推測で席を決めない**）。
async function seatOfWorkerPid(workerPid) {
  for (const seat of seats) {
    let pid = null
    try { pid = await seatWorkerPid(seat) } catch { continue }
    if (pid === workerPid) return seat
  }
  return null
}

async function post(to, body) {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-peertable-token': token },
    body: JSON.stringify({ from: 'run-bridge', to, body }),
  })
  if (!res.ok) throw new Error(`room post ${res.status}`)
}

function orderText(order) {
  return [
    `[work order] ${order.todo_id}`,
    `worktree: ${order.worktree_path}`,
    `base_sha: ${order.base_sha}`,
    `scope_writes: ${order.scope_writes.join(', ')}`,
    `verifier_refs: ${order.verifier_refs.join(' / ') || '(なし)'}`,
    `forbidden_operations: ${order.forbidden_operations.join(', ')}`,
    `packet_digest: ${order.packet_digest}`,
    '',
    `受諾なら「[受諾] ${order.todo_id}」、辞退なら「[辞退] ${order.todo_id} 理由」を独立した1発言で。`,
    `終わったら「[完了] ${order.todo_id}」を独立した1発言で。作法は member.md の「配車で来た仕事」節。`,
  ].join('\n')
}

// ---- 配車状態（記録は report が持つ。bridge 側の Map は再起動で作り直せるものだけ） ----
const dispatched = new Map()   // packet_digest -> { order, seat, workerPid, state, declined:Set }

// 席が手一杯かは pane の末尾に `esc to interrupt` が在るかで見る（seat-status-bridge と同じ判定）。
// **スピナーの語では判定しない**——Claude 席は動名詞を毎回変えるので語で照合すると全席 idle に見える。
// `esc to interrupt` は Claude 席のステータス行にも Codex 席の `Working (…)` にも入る共通marker。
// 読み取りだけなので席の作業を壊さない。
async function seatBusyState(seat) {
  const target = `peer-${seat}`
  let dead
  try { dead = (await run('tmux', ['-S', sock, 'list-panes', '-t', target, '-F', '#{pane_dead}'])).stdout }
  catch { return 'dead' }
  if (dead.trim().split('\n')[0] === '1') return 'dead'
  let pane
  try { pane = (await run('tmux', ['-S', sock, 'capture-pane', '-t', target, '-p'], { maxBuffer: 4 * 1024 * 1024 })).stdout }
  catch { return 'dead' }
  return pane.split('\n').slice(-14).join('\n').includes('esc to interrupt') ? 'busy' : 'idle'
}

async function dispatch(order) {
  const key = order.packet_digest
  const entry = dispatched.get(key) ?? { order, seat: null, workerPid: null, state: 'pending', declined: new Set() }
  dispatched.set(key, entry)
  const occupied = seat => [...dispatched.values()]
    .some(other => other !== entry && other.seat === seat && !TERMINAL_ENTRY_STATES.has(other.state))
  const eligible = seats.filter(seat => seat !== entry.seat && !entry.declined.has(seat) && !occupied(seat))
  // **idle を先に当てる。** busy な席へ配ると、その席が今のターンを終えるまで受諾が来ない——
  // 空いている席が居るのにわざわざ待たせる理由が無い。ただし busy でも配車自体は禁じない
  // （席の判断で辞退できるし、全席 busy の時に配車を止めると卓が進まなくなる）。
  const states = await Promise.all(eligible.map(async seat => [seat, await seatBusyState(seat)]))
  const idle = states.find(([, state]) => state === 'idle')?.[0]
  const busy = states.find(([, state]) => state === 'busy')?.[0]
  const candidate = idle ?? busy
  if (candidate === undefined) {
    const detail = states.map(([seat, state]) => `${seat}:${state}`).join(' ') || '候補なし'
    log(`配車できる席が無い: ${order.todo_id}（辞退 ${[...entry.declined].join(',') || 'なし'}・${detail}）`)
    entry.seat = null
    return
  }
  if (idle === undefined) log(`idle な席が無いので busy な席へ配車する: ${order.todo_id} → ${candidate}`)
  entry.seat = candidate
  entry.state = 'offered'
  await post(candidate, orderText(order))
  await post('all', `[配車] ${order.todo_id} → ${candidate}`)
  log(`配車: ${order.todo_id} → ${candidate}`)
}

async function scanOrders() {
  // **SSE の頭出しが済むまで配車しない。** 頭出しは「ここまでは既読」と決める操作なので、
  // 先に配車すると、その直後に返ってきた `[受諾]` が既読として捨てられる（実測で踏んだ順序）。
  if (!primed) return
  let names
  try { names = await readdir(ordersDir) }
  catch (error) {
    if (error?.code === 'ENOENT') { log(`orders directory がまだ無い: ${ordersDir}`); return }
    throw error
  }
  let fresh = 0
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const digest = name.slice(0, -'.json'.length)
    if (dispatched.has(digest)) continue
    let order
    try { order = JSON.parse(await readFile(join(ordersDir, name), 'utf8')) }
    catch (error) { log(`order を読めない（飛ばす）: ${name}: ${error.message}`); continue }
    if (!validOrder(order) || order.packet_digest !== digest) {
      // 契約違反は黙って飲まない。ただし他の order の配車は止めない
      log(`RUN_BRIDGE_ORDER_INVALID: ${name} が run_work_order.v1 契約を満たさない（飛ばす）`)
      dispatched.set(digest, { order: null, seat: null, workerPid: null, state: 'invalid', declined: new Set() })
      continue
    }
    // 再起動時、durable な状態は report が持つ。**working を fresh 扱いで配り直さない**——
    // 配り直すと worker_pid が変わり、controller が hard fail する（受諾後の pid は不変契約）。
    const existing = await readReport(digest)
    if (existing !== null && existing.state === 'done') {
      dispatched.set(digest, { order, seat: null, workerPid: existing.worker_pid, state: 'done', declined: new Set() })
      log(`済んだ order を引き継いだ: ${order.todo_id}`)
      continue
    }
    if (existing !== null && existing.state === 'working') {
      const owner = await seatOfWorkerPid(existing.worker_pid)
      if (owner === null) {
        // 復元できないなら**止まる**。別の席へ配り直すのは契約違反で、静かに壊れるより悪い
        dispatched.set(digest, { order, seat: null, workerPid: existing.worker_pid, state: 'unrecoverable', declined: new Set() })
        log(`RUN_BRIDGE_WORKING_UNRECOVERABLE: ${order.todo_id} の working report が指す pid `
          + `${existing.worker_pid} を持つ席が居ない。**再配車しない**（worker_pid 不変契約を破るため）。`
          + '席が落ちているなら run 側で hold/close して order を出し直すこと')
        continue
      }
      dispatched.set(digest, { order, seat: owner, workerPid: existing.worker_pid, state: 'working', declined: new Set() })
      log(`作業中の order を引き継いだ: ${order.todo_id} ← ${owner}（pid ${existing.worker_pid}）`)
      continue
    }
    fresh += 1
    await dispatch(order)
  }
  // 2秒ごとに全走査を喋ると1時間で1800行になる。**黙らせはしない**（沈黙を「異常なし」の
  // 証拠にしない）ので、変化が無い時も1分に1回は件数を出す
  scanTicks += 1
  if (fresh > 0 || scanTicks % 30 === 1) {
    log(`orders ${names.length} 件を見て ${fresh} 件を新規配車した`)
  }
}
let scanTicks = 0

// ---- room の SSE（wakeup-bridge と同じ三段: 無音watchdog・再接続catch-up・心拍差分） ----
const IDLE_MS = 75_000
let lastSeq = 0
let primed = false
let catching = false

// 席の宣言は `tN` しか運ばないので、(席, todo_id) で配車記録を引く。**終端済みの記録は飛ばす**——
// 同じ todo_id を再 run すると、前回の `done` 記録が先に当たって新しい受諾が「重複」として捨てられる
// （2026-08-09 の t7 受入で実測。席から見ると「受諾したのに何も起きない」になる）。
const TERMINAL_ENTRY_STATES = new Set(['done', 'unrecoverable', 'invalid'])

function findEntry(seat, todoId) {
  for (const entry of dispatched.values()) {
    if (entry.seat !== seat || entry.order?.todo_id !== todoId) continue
    if (TERMINAL_ENTRY_STATES.has(entry.state)) continue
    return entry
  }
  return null
}

async function handleMessage(msg) {
  if (typeof msg.body !== 'string' || typeof msg.from !== 'string') return
  const match = msg.body.match(/^\[(受諾|辞退|完了)\]\s*(\S+)/u)
  if (match === null) return
  const [, verb, todoId] = match
  const entry = findEntry(msg.from, todoId)
  if (entry === null) {
    log(`宛先の無い宣言（無視）: ${msg.from} [${verb}] ${todoId}`)
    return
  }
  if (verb === '辞退') {
    log(`辞退: ${todoId} ← ${msg.from}`)
    entry.declined.add(msg.from)
    entry.state = 'pending'
    await dispatch(entry.order)
    return
  }
  if (verb === '受諾') {
    if (entry.state !== 'offered') { log(`重複した受諾（無視）: ${todoId} ← ${msg.from}`); return }
    // **ここで初めて report を書く。** pid は受諾した席のもので、以後不変（controller が
    // 途中変化を hard fail する）。だから辞退の受け直しは受諾より前にしか起きない
    entry.workerPid = await seatWorkerPid(msg.from)
    entry.state = 'working'
    await writeReport(entry.order.packet_digest, 'working', entry.workerPid)
    return
  }
  if (entry.state !== 'working') { log(`受諾前の完了宣言（無視）: ${todoId} ← ${msg.from}`); return }
  entry.state = 'done'
  await writeReport(entry.order.packet_digest, 'done', entry.workerPid)
  log(`完了: ${todoId} ← ${msg.from}`)
}

async function catchUp(reason) {
  if (catching) return
  catching = true
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/messages?since=${lastSeq}`)
    if (!res.ok) throw new Error(`messages ${res.status}`)
    const { messages } = await res.json()
    if (!primed) {
      primed = true
      if (messages.length > 0) lastSeq = messages[messages.length - 1].seq
      log(`頭出し: seq ${lastSeq} まで既読として開始する`)
      return
    }
    log(`取りこぼし確認（${reason}・since ${lastSeq}）: ${messages.length} 件`)
    for (const msg of messages) await ingest(msg)
  } finally {
    catching = false
  }
}

async function ingest(msg) {
  if (typeof msg.seq !== 'number') { log(`seq を持たないイベントを捨てた`); return }
  if (msg.seq <= lastSeq) return
  lastSeq = msg.seq
  try { await handleMessage(msg) }
  catch (error) { log(`宣言の処理に失敗（続行する）: ${error.message}`) }
}

function onHeartbeat(dataLine) {
  const head = Number(dataLine)
  if (!Number.isFinite(head) || head <= lastSeq) return
  log(`心拍が示す最新 seq ${head} に追いついていない（手元 ${lastSeq}）`)
  catchUp('心拍の差分').catch(error => log(`心拍由来の回収に失敗: ${error.message}`))
}

// ---- run の進行を room へ返す（`lattice run observe` の read-only polling） ----
// **order から run を知る。** worktree_path は `<repo>/.lattice/runs/<run-id>/worktrees/…` なので、
// そこから run dir を切り出せる。別 config を増やさずに済み、複数 run が同時に走っても取り違えない。
function runDirOf(order) {
  const marker = `${sep}.lattice${sep}runs${sep}`
  const at = order.worktree_path.indexOf(marker)
  if (at < 0) return null
  const rest = order.worktree_path.slice(at + marker.length)
  const runId = rest.split(sep)[0]
  return runId ? order.worktree_path.slice(0, at + marker.length) + runId : null
}

const observedRuns = new Map()   // runDir -> 直近に投稿した要約

async function pollRuns() {
  const targets = new Set()
  for (const entry of dispatched.values()) {
    if (entry.order === null) continue
    const dir = runDirOf(entry.order)
    if (dir !== null) targets.add(dir)
  }
  for (const dir of [...targets].sort()) {
    let observation
    try {
      const { stdout } = await run(latticeCli, ['run', 'observe', '--run', dir], { maxBuffer: 4 * 1024 * 1024 })
      observation = JSON.parse(stdout)
    } catch (error) {
      // 観測できないことを黙らない。ただし1 run の失敗で他の run の報告を止めない
      const detail = String(error?.stderr ?? error?.message ?? error).split('\n')[0].slice(0, 200)
      const summary = `observe 失敗: ${detail}`
      if (observedRuns.get(dir) !== summary) { observedRuns.set(dir, summary); log(`${dir}: ${summary}`) }
      continue
    }
    const summary = `accepted=[${observation.accepted}] terminal=[${observation.terminal}]`
      + ` hold=${observation.hold_count} conflict=${observation.conflict_count} closed=${observation.closed}`
    if (observedRuns.get(dir) === summary) continue   // 変化が無い時は room を鳴らさない
    observedRuns.set(dir, summary)
    log(`run 進行: ${dir} ${summary}`)
    await post('all', `[run] ${dir.split(sep).pop()} ${summary}`)
  }
}

setInterval(() => { scanOrders().catch(error => log(`order 走査に失敗: ${error.message}`)) }, 2000)
setInterval(() => { pollRuns().catch(error => log(`run 観測に失敗: ${error.message}`)) }, 10_000)

let failures = 0
log(`bridge start: room=${room} spool=${spool} seats=${seats.join(',')} pid=${process.pid}`)
for (;;) {
  try {
    const abort = new AbortController()
    let lastByteAt = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > IDLE_MS) {
        log(`受信途絶 ${Math.round(IDLE_MS / 1000)} 秒。接続が黙って死んだとみなして繋ぎ直す`)
        abort.abort()
      }
    }, 5000)
    try {
      const res = await fetch(`${url}/api/${encodeURIComponent(room)}/events`, { signal: abort.signal })
      if (!res.ok) throw new Error(`events ${res.status}`)
      failures = 0
      log('SSE 接続')
      await catchUp('再接続')
      let buf = ''
      for await (const chunk of res.body) {
        lastByteAt = Date.now()
        buf += Buffer.from(chunk).toString('utf8')
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const part of parts) {
          const lines = part.split('\n')
          const name = lines.find(l => l.startsWith('event: '))?.slice(7).trim()
          const line = lines.find(l => l.startsWith('data: '))
          if (name === 'ping') { if (line) onHeartbeat(line.slice(6)); continue }
          if (name !== undefined && name !== 'message') continue
          if (line) await ingest(JSON.parse(line.slice(6)))
        }
      }
      log('SSE 切断（再接続する）')
    } finally {
      clearInterval(watchdog)
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      log('再接続する')
    } else {
      failures++
      log(`SSE 失敗 ${failures} 回目: ${error.message}`)
      if (failures >= 10) {
        console.error('RUN_BRIDGE_UNREACHABLE: room の SSE へ10回連続で繋げない')
        if (existsSync(record)) unlinkSync(record)
        process.exit(1)
      }
    }
  }
  await sleep(2000)
}
