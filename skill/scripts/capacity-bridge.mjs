#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  createCapacityTracker,
  readLatticeCapacityStatus,
  standaloneTodoStatus,
} from './capacity-advisor.mjs'
import { resolvePostToken } from './seat-usage.mjs'

const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const [project, option, ...extra] = process.argv.slice(2)
if (!project || extra.length > 0 || (option && !['--once', '--stop'].includes(option))) {
  console.error('usage: capacity-bridge.mjs <project_dir> [--once|--stop]')
  process.exit(1)
}

const recordPath = join(project, '.team', 'capacity-bridge.json')
const log = message => console.log(`[${new Date().toISOString()}] ${message}`)
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

async function processFacts(pid) {
  let stdout
  try { ({ stdout } = await run('/bin/ps', ['-o', 'lstart=,command=', '-p', String(pid)])) }
  catch { return null }
  const parts = stdout.trim().split(/\s+/u)
  if (parts.length < 6) return null
  return { startIdentity: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') }
}

async function stopRecorded() {
  if (!existsSync(recordPath)) return
  const stored = JSON.parse(readFileSync(recordPath, 'utf8'))
  const facts = await processFacts(stored.pid)
  if (facts === null || !alive(stored.pid)) {
    unlinkSync(recordPath)
    return
  }
  const sameProcess = stored.start_identity === facts.startIdentity
    && facts.command.includes('capacity-bridge.mjs') && facts.command.includes(project)
  if (!sameProcess) {
    console.error(`CAPACITY_BRIDGE_RECORD_STALE: pid ${stored.pid} は記録した常駐ではない。signalは送っていない`)
    process.exit(1)
  }
  process.kill(stored.pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(stored.pid); i++) await sleep(200)
  if (alive(stored.pid)) process.kill(stored.pid, 'SIGKILL')
  for (let i = 0; i < 15 && alive(stored.pid); i++) await sleep(200)
  if (alive(stored.pid)) {
    console.error(`CAPACITY_BRIDGE_STOP_FAILED: pid ${stored.pid} がSIGKILLでも止まらない`)
    process.exit(1)
  }
  if (existsSync(recordPath)) unlinkSync(recordPath)
}

if (option === '--stop') {
  await stopRecorded()
  process.exit(0)
}

if (existsSync(recordPath)) {
  const stored = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (alive(stored.pid)) {
    console.error(`CAPACITY_BRIDGE_ALREADY_RUNNING: pid ${stored.pid}`)
    process.exit(1)
  }
  unlinkSync(recordPath)
}

const setup = JSON.parse(readFileSync(join(project, '.team', 'setup-state.json'), 'utf8'))
const roomPath = encodeURIComponent(setup.room)
const token = resolvePostToken(process.env)
if (!token) {
  console.error('CAPACITY_BRIDGE_WRITE_TOKEN_MISSING: roomへtyped通知を送れないため常駐しない')
  process.exit(1)
}
const parentName = process.env.PEERTABLE_PARENT_NAME || 'bell'

const getJson = async path => {
  const response = await fetch(`${setup.server_url}${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}: GET ${path}`)
  return response.json()
}

const readMembers = async () => {
  const body = await getJson(`/api/${roomPath}/members`)
  if (!Array.isArray(body.members)) throw new Error('members response is not an array')
  return body.members
}

const readTodoStatus = setup.mode === 'lattice'
  ? () => readLatticeCapacityStatus(project, { latticeCli: setup.lattice_cli || 'lattice' })
  : async () => {
      const tasks = readFileSync(join(project, '.team', 'tasks.md'), 'utf8')
      const body = await getJson(`/api/${roomPath}/messages?since=0`)
      return standaloneTodoStatus(tasks, body.messages ?? [])
    }

const post = async message => {
  const response = await fetch(`${setup.server_url}/api/${roomPath}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Peertable-Token': token },
    body: JSON.stringify(message),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: capacity通知POST`)
  return response.json()
}

const tracker = createCapacityTracker({ project, readTodoStatus, readMembers, post, parentName })
const tick = async () => {
  const result = await tracker.tick()
  const detail = result.event === null
    ? `capacity不変 target=${result.state.target} delta=${result.state.delta}`
    : `${result.event.code} action=${result.event.action} target=${result.event.old_target}→${result.event.target}`
  log(detail)
  return result
}

if (option === '--once') {
  const result = await tick()
  console.log(JSON.stringify({ state: result.state, event: result.event }))
  process.exit(0)
}

const selfFacts = await processFacts(process.pid)
if (selfFacts === null) {
  console.error('CAPACITY_BRIDGE_SELF_UNOBSERVABLE: 自processを観測できない')
  process.exit(1)
}
writeFileSync(recordPath, `${JSON.stringify({
  pid: process.pid,
  start_identity: selfFacts.startIdentity,
  room: setup.room,
  started_at: new Date().toISOString(),
})}\n`, { mode: 0o600 })

let ownsRecord = true
const cleanup = () => {
  try {
    if (ownsRecord && existsSync(recordPath)) {
      const stored = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (stored.pid === process.pid) unlinkSync(recordPath)
    }
  } catch {}
  ownsRecord = false
  process.exit(0)
}
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
process.on('exit', () => {
  if (!ownsRecord) return
  try {
    const stored = JSON.parse(readFileSync(recordPath, 'utf8'))
    if (stored.pid === process.pid) unlinkSync(recordPath)
  } catch {}
})

let failures = 0
let ticking = false
async function guardedTick() {
  if (ticking) return
  ticking = true
  try {
    await tick()
    failures = 0
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    const temporary = `${recordPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...record, ready_at: new Date().toISOString() })}\n`, { mode: 0o600 })
    renameSync(temporary, recordPath)
  } catch (error) {
    failures++
    console.error(`CAPACITY_BRIDGE_TICK_FAILED: ${failures}/10: ${error.message}`)
    if (failures >= 10) {
      process.exit(1)
    }
  } finally {
    ticking = false
  }
}

await guardedTick()
if (!existsSync(recordPath) || !JSON.parse(readFileSync(recordPath, 'utf8')).ready_at) process.exit(1)
setInterval(guardedTick, 8_000)
