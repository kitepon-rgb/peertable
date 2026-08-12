#!/usr/bin/env node
// 親セッション自身が所有するバックグラウンド通知用の room watcher。
// room/SSE の解釈はここへ集約し、Claude Monitor / Codex background task は
// この process が stdout へ出す構造化 event を親へ返すことだけを担う。
//
// usage: parent-watch.mjs <project_dir> [parent_name] --prime
//        parent-watch.mjs <project_dir> [parent_name] --poll
//        parent-watch.mjs <project_dir> [parent_name] --next
//        parent-watch.mjs <project_dir> [parent_name] --follow
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const project = args.shift()
let parent = 'bell'
if (args[0] && !args[0].startsWith('--')) parent = args.shift()
const mode = args.shift() ?? '--follow'
if (!project || !['--prime', '--poll', '--next', '--follow'].includes(mode) || args.length > 0) {
  console.error('usage: parent-watch.mjs <project_dir> [parent_name] <--prime|--poll|--next|--follow>')
  process.exit(2)
}

const team = join(project, '.team')
const setupPath = join(team, 'setup-state.json')
const statePath = join(team, 'parent-watch.json')
const lockPath = join(team, 'parent-watch.lock')
const setup = JSON.parse(readFileSync(setupPath, 'utf8'))
const room = setup.room
const serverUrl = setup.server_url.replace(/\/$/u, '')
const api = `${serverUrl}/api/${encodeURIComponent(room)}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const ROOM_UPDATE_BODY = 'room全体の状況が更新された。roomログを読み、状況を把握して次の行動を判断する。'

function loadState() {
  if (!existsSync(statePath)) return null
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    if (saved.room !== room || saved.server_url !== serverUrl || saved.parent !== parent) return null
    if (!Number.isSafeInteger(saved.last_seq) || saved.last_seq < 0) return null
    return saved
  } catch {
    return null
  }
}

function saveState(state) {
  const temp = `${statePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(temp, statePath)
}

async function readJson(path) {
  const response = await fetch(`${api}${path}`)
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  return response.json()
}

async function ensurePrimed() {
  const saved = loadState()
  if (saved) {
    const next = { ...saved, ready_at: now(), host: process.env.PEERTABLE_PARENT_HOST || saved.host || null }
    saveState(next)
    return next
  }
  const summary = await readJson('/summary')
  const state = {
    schema: 'peertable.parent-watch-state.v1',
    room,
    server_url: serverUrl,
    parent,
    last_seq: Number.isSafeInteger(summary.seq) ? summary.seq : 0,
    ready_at: now(),
    host: process.env.PEERTABLE_PARENT_HOST || null,
  }
  saveState(state)
  return state
}

let state = await ensurePrimed()
if (mode === '--prime') process.exit(0)

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
function acquireLock() {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner = null
    try { owner = Number(readFileSync(lockPath, 'utf8').trim()) } catch {}
    if (Number.isSafeInteger(owner) && !alive(owner)) {
      unlinkSync(lockPath)
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return
    }
    console.error(`PARENT_WATCH_ALREADY_RUNNING: pid ${Number.isSafeInteger(owner) ? owner : '不明'}`)
    process.exit(1)
  }
}
function releaseLock() {
  try {
    if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath)
  } catch {}
}
acquireLock()
process.on('exit', releaseLock)

const addressedToParent = message => message?.from !== parent
  && (message?.to === 'all' || message?.to === parent
    || (Array.isArray(message?.to_names) && message.to_names.includes(parent)))

async function writeEvent(event) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve())
  })
}

async function acceptMessage(message) {
  if (!Number.isSafeInteger(message?.seq) || message.seq <= state.last_seq) return false
  const matched = addressedToParent(message)
  if (matched) {
    const roomUpdate = message.to === 'all'
    await writeEvent({
      schema: 'peertable.parent-watch-event.v1',
      type: roomUpdate ? 'parent_room_update' : 'parent_dm',
      parent,
      seq: message.seq,
      from: message.from,
      to: message.to ?? null,
      to_names: message.to_names ?? null,
      body: roomUpdate ? ROOM_UPDATE_BODY : message.body,
      message: roomUpdate
        ? { seq: message.seq, ts: message.ts, from: message.from, to: message.to }
        : message,
    })
  }
  state = { ...state, last_seq: message.seq, last_event_at: now() }
  saveState(state)
  return matched
}

async function catchUp() {
  const body = await readJson(`/messages?since=${state.last_seq}`)
  for (const message of body.messages ?? []) {
    if (await acceptMessage(message) && mode === '--next') return true
  }
  return false
}

// Codex親のbackground task向け。HTTP catch-upを一度だけ行って即終了する。
// 長寿命なのはbackground taskのloopだけで、端末sessionやNode processは常駐させない。
if (mode === '--poll') {
  await catchUp()
  process.exit(0)
}

const nextWindowMs = Number(process.env.PEERTABLE_PARENT_WATCH_WINDOW_MS ?? 55_000)
if (mode === '--next' && (!Number.isFinite(nextWindowMs) || nextWindowMs < 100)) {
  console.error('PARENT_WATCH_WINDOW_INVALID')
  process.exit(2)
}

let consecutiveFailures = 0
for (;;) {
  const deadline = mode === '--next' ? Date.now() + nextWindowMs : Number.POSITIVE_INFINITY
  try {
    if (await catchUp()) process.exit(0)
    const controller = new AbortController()
    const remaining = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : null
    const timer = remaining === null ? null : setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(`${api}/events`, { signal: controller.signal })
      if (!response.ok) throw new Error(`events ${response.status}`)
      consecutiveFailures = 0
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        const frames = buffer.split('\n\n')
        buffer = frames.pop()
        for (const frame of frames) {
          const lines = frame.split('\n')
          const eventName = lines.find(line => line.startsWith('event: '))?.slice(7).trim()
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
          if (eventName === 'ping') {
            const head = Number(data)
            if (Number.isSafeInteger(head) && head > state.last_seq && await catchUp()) process.exit(0)
            continue
          }
          if (eventName !== undefined && eventName !== 'message') continue
          if (!data) continue
          if (await acceptMessage(JSON.parse(data)) && mode === '--next') process.exit(0)
        }
      }
      throw new Error('events disconnected')
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  } catch (error) {
    if (mode === '--next' && error.name === 'AbortError' && Date.now() >= deadline) process.exit(0)
    consecutiveFailures += 1
    if (consecutiveFailures >= 10) {
      await writeEvent({
        schema: 'peertable.parent-watch-event.v1',
        type: 'watch_error',
        parent,
        code: 'PARENT_WATCH_UNREACHABLE',
        detail: error.message,
      })
      process.exit(1)
    }
    if (mode === '--next' && Date.now() >= deadline) process.exit(0)
    await sleep(Math.min(2000, Math.max(1, deadline - Date.now())))
  }
}
