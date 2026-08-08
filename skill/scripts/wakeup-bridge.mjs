#!/usr/bin/env node
// Codex 席の起床ブリッジ。room の SSE を購読し、その席宛（または全員宛）の新着が来たら
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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const [proj, ...rest] = process.argv.slice(2)
if (!proj || rest.length === 0) {
  console.error('usage: wakeup-bridge.mjs <project_dir> <seat> [seat...] | <project_dir> --stop')
  process.exit(1)
}

const record = join(proj, '.team', 'wakeup-bridge.json')
const sock = process.env.PEERTABLE_TMUX_SOCKET ?? `${process.env.TMPDIR}claude-tmux-sockets/claude.sock`
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

async function wake(seat, msgs) {
  const last = msgs[msgs.length - 1]
  const text = msgs.length === 1
    ? `room に新着あり（${last.from} → ${last.to}）。read_unread で読むこと。`
    : `room に新着 ${msgs.length} 件（最新: ${last.from} → ${last.to}）。read_unread で読むこと。`
  try {
    await run('tmux', ['-S', sock, 'send-keys', '-t', `peer-${seat}`, text])
    await sleep(400)
    await run('tmux', ['-S', sock, 'send-keys', '-t', `peer-${seat}`, 'Enter'])
    log(`起こした: ${seat} ← ${msgs.length} 件（最新 seq ${last.seq}）`)
  } catch (error) {
    // 席が畳まれていれば tmux が落ちる。黙って飲まず、毎回出す
    log(`起こせなかった: ${seat}（${error.message.split('\n')[0]}）`)
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
    if (msg.to !== 'all' && msg.to !== seat) continue
    pending.get(seat).push(msg)
  }
}

let failures = 0
log(`bridge start: room=${room} seats=${seats.join(',')} pid=${process.pid}`)
for (;;) {
  try {
    const res = await fetch(`${url}/api/${room}/events`)
    if (!res.ok) throw new Error(`events ${res.status}`)
    failures = 0
    log('SSE 接続')
    let buf = ''
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '))
        if (line) dispatch(JSON.parse(line.slice(6)))
      }
    }
    log('SSE 切断（再接続する）')
  } catch (error) {
    failures++
    log(`SSE 失敗 ${failures} 回目: ${error.message}`)
    // 落ちっぱなしを黙って再試行し続けない。連続失敗が続いたら記録を外して落ちる
    if (failures >= 10) {
      console.error('WAKEUP_BRIDGE_UNREACHABLE: room の SSE へ10回連続で繋げない')
      if (existsSync(record)) unlinkSync(record)
      process.exit(1)
    }
  }
  await sleep(2000)
}
