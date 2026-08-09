#!/usr/bin/env node
// 席の稼働状態ブリッジ（決定61 候補・t15）。tmux の pane を読んで busy/idle/dead を判定し、room サーバーへ送る。
// usage: seat-status-bridge.mjs <project_dir> [--interval <sec>] [--once]
//        seat-status-bridge.mjs <project_dir> --stop
//
// AI は使わない。読むのは `tmux capture-pane -p` の末尾だけで、席へは1バイトも送らない。
//
// 判定（2026-08-08 実測。**推測でパターンを書かない**）:
//   busy = pane の末尾に `esc to interrupt` が在る。Claude 席のステータス行にも Codex 席の `Working (…)` にも
//          同じ文字列が入るので **vendor 分岐が要らない**。実行中の動名詞（Cogitating/Coalescing/Effecting/
//          Gallivanting/Fermenting/Symbioting…）は**毎回変わる**ので判定に使わない——語で照合すると全席を
//          idle と誤判定して、画面が嘘をつく
//   dead = tmux セッションが無い／`pane_dead=1`
//   idle = 生きていて busy でない
//
// 送信は「変化した時」＋「変化が無くても心拍」の2本立て。変化時だけだと、**bridge が死んだのか状態が
// 変わっていないのかを server が区別できない**（決定58 の liveness と cursor の分離と同じ形）。
// server 側は最終受信からの経過で `unknown` へ落とす——古い状態を出し続けるのが最悪だから。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { parsePaneTokenHint, supportsMemberObservation } from './seat-usage.mjs'

const args = process.argv.slice(2)
const proj = args[0]
if (!proj) { console.error('usage: seat-status-bridge.mjs <project_dir> [--interval <sec>] [--once] | --stop'); process.exit(1) }
const stop = args.includes('--stop')
const once = args.includes('--once')
const interval = Number(args[args.indexOf('--interval') + 1]) || 8
const HEARTBEAT_MS = 30_000 // 変化が無くても最低この間隔で送る（server 側の減衰より短いこと）

const stateDir = join(proj, '.team')
const pidPath = join(stateDir, 'seat-status-bridge.json')
const setupPath = join(stateDir, 'setup-state.json')

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// ADR 0157 の作法: pid を記録し、起動時に死んだ記録を掃除し、--stop で明示停止する
if (stop) {
  if (!existsSync(pidPath)) { console.error('seat-status-bridge: 起動記録が無い（既に停止）'); process.exit(0) }
  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8'))
  if (alive(pid)) {
    // SIGTERM 5秒 → SIGKILL 3秒（wakeup-bridge.mjs と同じ形）。**昇格が無いと、SIGTERM を無視する
    // 常駐が居た時に teardown が `set -e` の2段目で即死して、[未実施] も [手当] も要約も出ない**
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 50 && alive(pid); i++) execFileSync('sleep', ['0.1'])
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
      for (let i = 0; i < 30 && alive(pid); i++) execFileSync('sleep', ['0.1'])
    }
    if (alive(pid)) { console.error(`SEAT_STATUS_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`); process.exit(1) }
  }
  // 止めた側の SIGTERM handler が先に消していることがある。生の traceback を出さない（それ自体が
  // 「何が起きたか分からない失敗」になる——今日 teardown で同じ形を叩いたばかり）
  try { unlinkSync(pidPath) } catch { /* 既に消えている＝目的は達成されている */ }
  console.error(`seat-status-bridge: 停止した（pid ${pid}）`)
  process.exit(0)
}

if (existsSync(pidPath)) {
  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8'))
  if (alive(pid)) { console.error(`seat-status-bridge: 既に動いている（pid ${pid}）`); process.exit(1) }
  unlinkSync(pidPath) // 死んだ記録は掃除する
}

const setup = JSON.parse(readFileSync(setupPath, 'utf8'))
const url = setup.server_url
const room = setup.room
const token = process.env.PEERTABLE_POST_TOKEN ?? ''
writeFileSync(pidPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n')

const tmux = (...a) => { try { return execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null } }

// 監視するのは room の members に居る席だけ。tmux の `peer-*` を全部拾うと、同じマシンで走る別の卓を晒す
async function seats() {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  const { members } = await res.json()
  return members.map(m => m.name)
}

function readSeat(name, previous, observedAt) {
  const target = `peer-${name}`
  const dead = tmux('list-panes', '-t', target, '-F', '#{pane_dead}')
  if (dead === null) return { status: 'dead', busySince: null, paneTokenHint: null }
  if (dead.trim().split('\n')[0] === '1') {
    return { status: 'dead', busySince: null, paneTokenHint: null }
  }
  const pane = tmux('capture-pane', '-t', target, '-p')
  if (pane === null) return { status: 'dead', busySince: null, paneTokenHint: null }
  const tail = pane.split('\n').slice(-14).join('\n')
  const status = tail.includes('esc to interrupt') ? 'busy' : 'idle'
  const busySince = status === 'busy'
    ? (previous?.status === 'busy' && previous.busySince ? previous.busySince : observedAt)
    : null
  return { status, busySince, paneTokenHint: parsePaneTokenHint(tail) }
}

async function send(name, observation, observedAt) {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Peertable-Token': token } : {}) },
    body: JSON.stringify({
      name,
      status: observation.status,
      status_at: observedAt,
      busy_since: observation.busySince,
      pane_token_hint: observation.paneTokenHint,
      usage_source: 'pane_status',
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// 200 を保存の証拠にしない（haruka の t14 と同じ判断）。現行 server は知らない欄を黙って捨てて 200 を返すので、
// 読み返して実際に載ったかを見る。載らない版なら、そう言って**黙って成功したふりをしない**
async function serverKeepsStatus() {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  return supportsMemberObservation(await res.json())
}

const last = new Map()   // name -> { status, at }
let supported = null     // server が status を保持する版か（未判定は null）
const tokenBucket = value => value === null ? null : Math.floor(value / 1_000)

async function tick() {
  let names
  try { names = await seats() } catch (e) { console.error(`seat-status-bridge: members を読めない: ${e.message}`); return }
  // **送る前に、server が status を持つ版かを確かめる。**
  // 現行の `POST /members` は、既存メンバーでも `<名前> が参加した` を必ず room へ流す（`post()` が
  // `if (!members.has(name))` の外にある）。status を保持しない版へ投げると、**保存されないうえに
  // 席全員を起こす system 発言を撒く**——2026-08-08 に私がこれで6件撒いて全席を1ターン起こした。
  // 保持する版かどうかは GET で分かるので、**分かるまで投げない**。
  if (supported === null) {
    try { supported = await serverKeepsStatus() } catch { return }   // 判定できない間は送らない
    if (!supported) console.error('seat-status-bridge: この room サーバーは稼働状態を保持しない版（GET /members に status が無い）。送信すると保存されないうえに system 発言を撒くので、送信しない')
  }
  if (!supported) { console.error(`seat-status-bridge: ${names.length} 席を見たが、server が未対応なので送っていない`); return }
  const now = Date.now()
  const observedAt = new Date(now).toISOString()
  let sent = 0
  for (const name of names) {
    const prev = last.get(name)
    const observation = readSeat(name, prev, observedAt)
    const changed = !prev || prev.status !== observation.status
      || prev.busySince !== observation.busySince
      // token表示は実行中に細かく増える。1k未満の差で8秒ごとにPOSTせず、表示精度に合う粒度で送る。
      || tokenBucket(prev.paneTokenHint) !== tokenBucket(observation.paneTokenHint)
    const stale = prev && now - prev.at >= HEARTBEAT_MS
    if (!changed && !stale) continue
    try {
      await send(name, observation, observedAt)
      last.set(name, { ...observation, at: now })
      sent++
      if (changed) console.error(`seat-status-bridge: ${name} → ${observation.status}${prev ? `（${prev.status} から）` : ''}`)
    } catch (e) {
      console.error(`seat-status-bridge: ${name} の送信に失敗: ${e.message}`)
    }
  }
  // 0件でも0件と言う（条件付きログにしない。沈黙する失敗を作らない・決定58）
  console.error(`seat-status-bridge: ${names.length} 席を見て ${sent} 件送った`)
}

process.on('SIGTERM', () => { try { unlinkSync(pidPath) } catch {} process.exit(0) })
process.on('SIGINT', () => { try { unlinkSync(pidPath) } catch {} process.exit(0) })

await tick()
if (!once) setInterval(tick, interval * 1000)
