#!/bin/bash
# 卓の健全性を機械判定して表示し、--repair 指定時だけ死んでいるブリッジを立て直す。
# usage: doctor.sh <project_dir> [--repair]
#
# 判定するのは5点だけ:
#   1. room サーバー到達性（GET /api/<room>/summary）
#   2. room members と .team/seats/*.json の突合
#   3. 各席の tmux セッション（peer-<name>）の存在と、席file の pid+lstart による本人性
#   4. 2ブリッジ（wakeup / seat-status）の record 生存と、record にある識別情報だけで
#      判定できる範囲の本人性・鮮度（判定できないものは「判定不能」と正直に出す。偽の生存判定を作らない）
#   5. Lattice 併用モード（mode=lattice）なら `lattice status --json` の state / active_runs
#
# 各行は OK / NG / REPAIRED / 判定不能 のいずれかで始まる。--repair は NG のブリッジだけ
# ensure-bridge.sh で立て直す。**席の再起動はしない**——席は人の判断が要るので、NG 表示に
# launch-seat.sh を促す一言を添えるだけに留める。
#
# 終了コード: 全 OK（判定不能を含む）= 0、NG が1件でもあれば 1（--repair で全部直れば 0）。
set -euo pipefail

proj="${1:-}"
repair=false
if [ "${2:-}" = "--repair" ]; then repair=true; fi
if [ -z "$proj" ]; then
  echo "usage: doctor.sh <project_dir> [--repair]" >&2
  exit 1
fi
proj=$(cd "$proj" && pwd)
script_dir=$(cd "$(dirname "$0")" && pwd)
setup="$proj/.team/setup-state.json"
if [ ! -f "$setup" ]; then
  echo "NG .team/setup-state.json が無い（${proj} は peertable setup 済みか確認せよ）" >&2
  exit 1
fi

DOCTOR_PROJ="$proj" DOCTOR_SCRIPT_DIR="$script_dir" DOCTOR_REPAIR="$repair" \
  node --input-type=module <<'NODE'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const proj = process.env.DOCTOR_PROJ
const scriptDir = process.env.DOCTOR_SCRIPT_DIR
const repair = process.env.DOCTOR_REPAIR === 'true'
const team = join(proj, '.team')

const { bridgeRecordLive } = await import(pathToFileURL(join(scriptDir, 'bridge-record-live.mjs')))
const { observePidCommand } = await import(pathToFileURL(join(scriptDir, 'refresh-seat-identity.mjs')))
const { resolveTmuxSocket, tmuxArgv } = await import(pathToFileURL(join(scriptDir, 'seat-usage.mjs')))

let ng = 0
function line(level, text) {
  console.log(`${level} ${text}`)
  if (level === 'NG') ng = 1
}

const setup = JSON.parse(readFileSync(join(team, 'setup-state.json'), 'utf8'))
const { room, server_url: url, mode } = setup

// 1. room サーバー到達性
let summary = null
try {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/summary`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  summary = await res.json()
  line('OK', `room 到達: ${url} room=${room} seq=${summary.seq} member_count=${summary.member_count}`)
} catch (error) {
  line('NG', `room 到達不可: ${url} room=${room}（${error.message}）`)
}

// members は以降の突合・席チェックにも使う
let members = []
let membersOk = false
try {
  const res = await fetch(`${url}/api/${encodeURIComponent(room)}/members`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  members = Array.isArray(body.members) ? body.members : []
  membersOk = true
} catch (error) {
  line('NG', `room members を取得できない（${error.message}）`)
}

// 2. room members と .team/seats/*.json の突合。tmux 席を持たない member（親など）は対象外
function hasDescriptor(member) {
  return Boolean(member?.observe && typeof member.observe === 'object'
    && typeof member.observe.tmux_target === 'string' && member.observe.tmux_target.length > 0)
}
const seatsDir = join(team, 'seats')
const seatFiles = new Map()
if (existsSync(seatsDir)) {
  for (const entry of readdirSync(seatsDir)) {
    if (!entry.endsWith('.json')) continue
    const name = entry.slice(0, -'.json'.length)
    try { seatFiles.set(name, JSON.parse(readFileSync(join(seatsDir, entry), 'utf8'))) } catch { /* 個別席の解析失敗は3.で拾う */ }
  }
}
if (membersOk) {
  const seatedMembers = members.filter(hasDescriptor).map(m => m.name)
  const missingSeatFile = seatedMembers.filter(name => !seatFiles.has(name))
  const orphanSeatFile = [...seatFiles.keys()].filter(name => !seatedMembers.includes(name))
  if (missingSeatFile.length === 0 && orphanSeatFile.length === 0) {
    line('OK', `room members と .team/seats/*.json が一致（${seatedMembers.length} 席）`)
  } else {
    const detail = []
    if (missingSeatFile.length) detail.push(`席fileが無い member: ${missingSeatFile.join(',')}`)
    if (orphanSeatFile.length) detail.push(`member に居ない席file: ${orphanSeatFile.join(',')}`)
    line('NG', `room members と .team/seats/*.json が不一致（${detail.join(' / ')}）`)
  }
}

// 3. 各席の tmux セッション（peer-<name>）の存在と、席file の pid+lstart による本人性
for (const [name, seat] of seatFiles) {
  const member = members.find(m => m.name === name)
  const socket = member?.observe?.tmux_socket || resolveTmuxSocket(process.env).socket
  const target = member?.observe?.tmux_target || `peer-${name}`
  let sessionExists = false
  try {
    execFileSync('tmux', tmuxArgv(['has-session', '-t', target], { socket }), { stdio: 'ignore' })
    sessionExists = true
  } catch { /* has-session は非ゼロ終了で無しを表す */ }
  if (!sessionExists) {
    line('NG', `席 ${name}: tmux セッション ${target} が無い（launch-seat.sh で立て直す）`)
    continue
  }
  let identity = null
  let identityError = null
  try { identity = observePidCommand(seat.pid) } catch (error) { identityError = error }
  if (identityError) {
    line('NG', `席 ${name}: pid ${seat.pid} を観測できない（${identityError.message}）（launch-seat.sh で立て直す）`)
    continue
  }
  if (identity.started_identity !== seat.started_identity) {
    line('NG', `席 ${name}: pid ${seat.pid} は再利用されている（lstart不一致・本人ではない）（launch-seat.sh で立て直す）`)
    continue
  }
  line('OK', `席 ${name}: tmux ${target} 生存・pid ${seat.pid} 本人性確認`)
}

// 4. 2ブリッジ（run-bridge は 2026-08-22 退役）。record の形式が違うので判定できる範囲だけ判定する
function judgeWakeup() {
  const path = join(team, 'wakeup-bridge.json')
  if (!existsSync(path)) return { level: 'NG', text: 'wakeup-bridge: record が無い（起動していない）' }
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (bridgeRecordLive(record)) {
    const age = Math.round((Date.now() - Date.parse(record.last_progress_at)) / 1000)
    return { level: 'OK', text: `wakeup-bridge: 生存 pid=${record.pid} last_progress ${age}秒前` }
  }
  return { level: 'NG', text: `wakeup-bridge: pid=${record.pid} が死んでいるか last_progress_at が古い` }
}

function judgeSeatStatusBridge() {
  const path = join(team, 'seat-status-bridge.json')
  if (!existsSync(path)) return { level: 'NG', text: 'seat-status-bridge: record が無い（起動していない）' }
  const record = JSON.parse(readFileSync(path, 'utf8'))
  let alive = false
  try { process.kill(record.pid, 0); alive = true } catch { /* 死んでいる */ }
  if (!alive) return { level: 'NG', text: `seat-status-bridge: pid=${record.pid} が死んでいる` }
  return { level: '判定不能', text: `seat-status-bridge: pid=${record.pid} は生存しているが record に lstart が無く本人性を確認できない` }
}

for (const [name, judge] of [['wakeup', judgeWakeup], ['seat-status', judgeSeatStatusBridge]]) {
  let result = judge()
  if (result.level === 'NG' && repair) {
    const res = spawnSync(join(scriptDir, 'ensure-bridge.sh'), [proj, name], { encoding: 'utf8' })
    if (res.status === 0) {
      const after = judge()
      if (after.level !== 'NG') { line('REPAIRED', `${name}-bridge: 立て直した（${after.text}）`); continue }
      line('NG', `${name}-bridge: 立て直したが依然として不健全（${after.text}）`)
      continue
    }
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' / ')
    line('NG', `${name}-bridge: 立て直しに失敗（${detail || `exit ${res.status}`}）`)
    continue
  }
  line(result.level, result.text)
}

// 5. Lattice 併用モードの工程正本
if (mode === 'lattice') {
  const latticeCli = process.env.LATTICE_CLI || (typeof setup.lattice_cli === 'string' && setup.lattice_cli) || 'lattice'
  try {
    const command = process.platform === 'win32' && !/\.(cmd|bat|exe)$/i.test(latticeCli) && existsSync(`${latticeCli}.cmd`)
      ? `${latticeCli}.cmd`
      : latticeCli
    const out = execFileSync(command, ['status', '--json'], { cwd: proj, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const status = JSON.parse(out)
    line('OK', `Lattice: state=${status.state} active_runs=${(status.active_runs ?? []).length}`)
  } catch (error) {
    line('NG', `Lattice status を取得できない（${String(error.message ?? error).split('\n')[0]}）`)
  }
}

process.exit(ng)
NODE
