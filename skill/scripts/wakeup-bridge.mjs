#!/usr/bin/env node
// Codex 席の起床ブリッジ。room の SSE を購読し、明示的にその席宛の新着が来たら
// tmux の席へ素送信して起こす。Claude 席は channels が同じ役をするので対象外。
//
// usage: wakeup-bridge.mjs <project_dir> <seat> [seat...]     起動（前面。nohup で常駐させる）
//        wakeup-bridge.mjs <project_dir> --stop               停止
//
// 生死の作法は Lattice ADR 0157 に倣う: 自分の pid を記録に置き、起動時に前の記録を掃除し、
// 止まらなければ黙って諦めず typed error で落ちる。
//
// 実測（2026-08-08・Codex CLI v0.146.0）: Codex は**ターン実行中でも素送信を受け付ける**。
// 送った文言はそのターンの中で読まれ、指示どおりに動いた（steering が効く）。したがって
// idle 待ちの経路は持たない——待ちを入れると、混んでいる席ほど起床が遅れる。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveSeatObservation, resolveTmuxSocket } from './seat-usage.mjs'

const run = promisify(execFile)
const [proj, ...rest] = process.argv.slice(2)
if (!proj || rest.length === 0) {
  console.error('usage: wakeup-bridge.mjs <project_dir> <seat> [seat...] | <project_dir> --stop')
  process.exit(1)
}

const record = join(proj, '.team', 'wakeup-bridge.json')
const socketResult = resolveTmuxSocket(process.env)
const sock = socketResult.socket
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = line => console.log(`[${new Date().toISOString()}] ${line}`)

async function stopRecorded() {
  if (!existsSync(record)) return
  const { pid } = JSON.parse(readFileSync(record, 'utf8'))
  if (!alive(pid)) { unlinkSync(record); log(`死んだ記録を掃除した（pid ${pid}）`); return }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(200)
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200)
  }
  if (alive(pid)) {
    console.error(`WAKEUP_BRIDGE_STOP_FAILED: pid ${pid} が SIGKILL でも止まらない`)
    process.exit(1)
  }
  if (existsSync(record)) unlinkSync(record)
  log(`前のブリッジを停止した（pid ${pid}）`)
}

await stopRecorded()
if (rest[0] === '--stop') process.exit(0)

const seats = rest
const state = JSON.parse(readFileSync(join(proj, '.team', 'setup-state.json'), 'utf8'))
const { room, server_url: url } = state
writeFileSync(record, JSON.stringify({
  pid: process.pid, room, server_url: url, seats, started_at: new Date().toISOString(),
}) + '\n')

const cleanup = () => { if (existsSync(record)) unlinkSync(record); process.exit(0) }
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

// 席ごとに未配達を溜めて、2秒ごとにまとめて1回起こす（連投で席を何度も起こさない）
const pending = new Map(seats.map(s => [s, []]))
let members = new Map()
async function refreshMembers() {
  try {
    const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
    if (!res.ok) throw new Error(`members ${res.status}`)
    const body = await res.json()
    members = new Map(body.members.map(member => [member.name, member]))
    return true
  } catch (error) {
    // 記述子の更新が読めないことは起床停止の理由にしない。直前の map を保ち、
    // 未登録席は wake() の legacy target へ戻す。縮退を必ずログに残す。
    log(`member 記述子を更新できないので直前の観測先で続ける: ${error.message}`)
    return false
  }
}
await refreshMembers()
function markReady() {
  const next = { ...JSON.parse(readFileSync(record, 'utf8')), ready_at: new Date().toISOString() }
  const temp = `${record}.tmp`
  writeFileSync(temp, JSON.stringify(next) + '\n')
  renameSync(temp, record)
}

async function wake(seat, msgs) {
  const last = msgs[msgs.length - 1]
  const audience = Array.isArray(last.to_names) ? last.to_names.join(', ') : last.to
  const text = msgs.length === 1
    ? `room に新着あり（${last.from} → ${audience}）。read_unread で読むこと。`
    : `room に新着 ${msgs.length} 件（最新: ${last.from} → ${audience}）。read_unread で読むこと。`
  try {
    // bridge 起動後の着席も次の配達で取り直す。初回だけの snapshot にすると
    // 新席を「member 不明」として永久に起こせず、旧 peer- 互換より後退する。
    await refreshMembers()
    const observation = resolveSeatObservation(members.get(seat) ?? { name: seat }, sock)
    if (observation === null) throw new Error(`観測記述子も既定 socket も無い: ${seat}`)
    await run('tmux', ['-S', observation.socket, 'send-keys', '-t', observation.target, text])
    await sleep(400)
    await run('tmux', ['-S', observation.socket, 'send-keys', '-t', observation.target, 'Enter'])
    log(`起こした: ${seat} ← ${msgs.length} 件（最新 seq ${last.seq}）`)
  } catch (error) {
    // 席が畳まれていれば tmux が落ちる。黙って飲まず、毎回出す（何件落としたかも出す）
    log(`起こせなかった: ${seat} ← ${msgs.length} 件（最新 seq ${last.seq}）: ${error.message.split('\n')[0]}`)
  }
}

setInterval(async () => {
  for (const [seat, msgs] of pending) {
    if (msgs.length === 0) continue
    pending.set(seat, [])
    await wake(seat, msgs)
  }
}, 2000)

function dispatch(msg) {
  for (const seat of seats) {
    if (msg.from === seat) continue
    if (Array.isArray(msg.to_names) ? !msg.to_names.includes(seat) : msg.to !== seat) continue
    pending.get(seat).push(msg)
  }
}

// 再接続で取りこぼさないために、配達済みの最大 seq を持つ。
// SSE は切れている間の発言を後から届けてくれないので、繋ぎ直したら必ず穴を埋める。
let lastSeq = 0
function dispatchNew(msg) {
  // seq の無いイベントで lastSeq を汚さない。`undefined <= 数値` は false なので、
  // 素通しにすると lastSeq が undefined に化け、以後の比較が全部 false になって
  // 「取りこぼし回収が毎回 since=undefined で 0 件」という静かな故障になる（実測で踏んだ）
  if (typeof msg.seq !== 'number') {
    log(`seq を持たないイベントを捨てた: ${JSON.stringify(msg).slice(0, 120)}`)
    return
  }
  if (msg.seq <= lastSeq) return
  lastSeq = msg.seq
  dispatch(msg)
}

// 繋がったまま黙って死ぬ接続を検出する。SSE は無音でも生きていられるので、
// 「切れた」ではなく「一定時間なにも届かない」を異常として扱い、自分から切って繋ぎ直す。
// 直後に since で追いつくので、無音が正常だった場合も取りこぼしは出ない。
// server の心拍が 25 秒周期（`room/server.mjs` の HEARTBEAT_MS）なので、その3倍を無音の閾値にする。
const IDLE_MS = 75_000

// 起動直後の1回だけは配達しない。既に流れ終わった過去ログで席を起こしても意味がなく、
// 卓が長いほど巨大な起床通知になる。初回は「ここまでは読んだこと」にして頭出しするだけ。
let primed = false
let catching = false
async function catchUp(reason) {
  // 再接続直後と心拍由来の回収が重なると二重に取りにいく。取りこぼし回収は1本だけ走らせる
  if (catching) return
  catching = true
  try {
    const res = await fetch(`${url}/api/${room}/messages?since=${lastSeq}`)
    if (!res.ok) throw new Error(`messages ${res.status}`)
    const { messages } = await res.json()
    if (!primed) {
      primed = true
      if (messages.length > 0) lastSeq = messages[messages.length - 1].seq
      log(`頭出し: seq ${lastSeq} まで既読として開始する`)
      return
    }
    log(`取りこぼし確認（${reason}・since ${lastSeq}）: ${messages.length} 件`)
    for (const msg of messages) dispatchNew(msg)
  } finally {
    catching = false
  }
}

// 心拍の data は room の最新 seq である（kotoha の `859bc21`）。これが自分の lastSeq より
// 進んでいたら「繋がったままなのに取りこぼしている」証拠になる。**watchdog はこの穴を原理的に
// 見つけられない**——心拍が届き続ける限り最終受信時刻は更新され続けるので、途絶判定に一生
// 引っかからない。だから常時流れてくる心拍そのものを取りこぼし検出に使う。
function onHeartbeat(dataLine) {
  const head = Number(dataLine)
  if (!Number.isFinite(head) || head <= lastSeq) return
  log(`心拍が示す最新 seq ${head} に追いついていない（手元 ${lastSeq}）`)
  catchUp('心拍の差分').catch(error => log(`心拍由来の回収に失敗: ${error.message}`))
}

let failures = 0
log(`bridge start: room=${room} seats=${seats.join(',')} pid=${process.pid}`)
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
      const res = await fetch(`${url}/api/${room}/events`, { signal: abort.signal })
      if (!res.ok) throw new Error(`events ${res.status}`)
      failures = 0
      log('SSE 接続')
      markReady()
      await catchUp('再接続')
      let buf = ''
      for await (const chunk of res.body) {
        lastByteAt = Date.now()
        buf += Buffer.from(chunk).toString('utf8')
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const part of parts) {
          const lines = part.split('\n')
          // SSE の1フレームは `event:` と `data:` の複数行で来る。名前付きイベント
          // （server の心拍 `event: ping` / `data: 1` 等）は発言ではないので配達しない。
          // `data:` だけ拾う実装だと心拍の `1` が発言として流れ込む（kotoha [106] の指摘）
          const name = lines.find(l => l.startsWith('event: '))?.slice(7).trim()
          const line = lines.find(l => l.startsWith('data: '))
          if (name === 'ping') { if (line) onHeartbeat(line.slice(6)); continue }
          if (name !== undefined && name !== 'message') continue
          if (line) dispatchNew(JSON.parse(line.slice(6)))
        }
      }
      log('SSE 切断（再接続する）')
    } finally {
      clearInterval(watchdog)
    }
  } catch (error) {
    // 自分で切った時（watchdog の abort）は失敗ではない——数えると健全な再接続で落ちてしまう
    if (error.name === 'AbortError') {
      log('再接続する')
    } else {
      failures++
      log(`SSE 失敗 ${failures} 回目: ${error.message}`)
      // 落ちっぱなしを黙って再試行し続けない。連続失敗が続いたら記録を外して落ちる
      if (failures >= 10) {
        console.error('WAKEUP_BRIDGE_UNREACHABLE: room の SSE へ10回連続で繋げない')
        if (existsSync(record)) unlinkSync(record)
        process.exit(1)
      }
    }
  }
  await sleep(2000)
}
