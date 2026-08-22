#!/usr/bin/env node
// 席 file の argv_digest を、Lattice attach と同じ /bin/ps -o command= 観測へ揃える。
// pid / lstart が席 file と違うときは書き換えず終わる（pid 推定も再利用も禁止）。
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function hashArgv(argv) {
  return createHash('sha256').update(String(argv), 'utf8').digest('hex')
}

export function observePidCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    const error = new Error('pid が正整数でない')
    error.code = 'SEAT_IDENTITY_NO_PID'
    throw error
  }
  // locale で lstart 書式・非ASCII argv のエスケープが変わるため C に固定（Lattice 観測と同一規約）
  const psEnv = { ...process.env, LC_ALL: 'C' }
  const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: psEnv }).trim()
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: psEnv }).trim()
  if (!started || !argv) {
    const error = new Error('pid の lstart/command を観測できない')
    error.code = 'SEAT_IDENTITY_UNOBSERVABLE'
    throw error
  }
  return { pid, started_identity: started, argv, argv_digest: hashArgv(argv) }
}

export function refreshSeatRecord(raw, observed, recordedAt) {
  if (!Number.isSafeInteger(raw?.pid) || raw.pid < 1) {
    const error = new Error('席 file に pid が無い')
    error.code = 'SEAT_IDENTITY_NO_PID'
    throw error
  }
  if (observed.pid !== raw.pid) {
    const error = new Error(`live pid ${observed.pid} は席 file の pid ${raw.pid} と違う`)
    error.code = 'SEAT_IDENTITY_PID_CHANGED'
    throw error
  }
  if (observed.started_identity !== raw.started_identity) {
    const error = new Error('pid の lstart が席 file と一致しない')
    error.code = 'SEAT_IDENTITY_LSTART_CHANGED'
    throw error
  }
  return {
    argv_digest: observed.argv_digest,
    name: raw.name,
    pid: raw.pid,
    recorded_at: recordedAt,
    session: raw.session,
    started_identity: raw.started_identity,
  }
}

function atomicWrite(out, body) {
  const tmp = join(dirname(out), `.seat-${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    try { unlinkSync(tmp) } catch {}
    throw error
  }
  closeSync(fd)
  chmodSync(tmp, 0o600)
  renameSync(tmp, out)
}

function utcRecordedAt() {
  return execFileSync('date', ['-u', '+%Y-%m-%dT%H:%M:%S.000Z'], { encoding: 'utf8' }).trim()
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const [project, name] = process.argv.slice(2)
  if (!project || !name) {
    process.stderr.write('usage: refresh-seat-identity.mjs <project> <name>\n')
    process.exit(2)
  }
  const out = join(resolve(project), '.team', 'seats', `${name}.json`)
  let raw
  try {
    raw = JSON.parse(readFileSync(out, 'utf8'))
  } catch (error) {
    process.stderr.write(`SEAT_IDENTITY_UNREADABLE: ${error.message}\n`)
    process.exit(2)
  }
  let observed
  try {
    observed = observePidCommand(raw.pid)
  } catch (error) {
    process.stderr.write(`${error.code || 'SEAT_IDENTITY_UNOBSERVABLE'}: ${error.message}\n`)
    process.exit(2)
  }
  let next
  try {
    next = refreshSeatRecord(raw, observed, utcRecordedAt())
  } catch (error) {
    process.stderr.write(`${error.code}: ${error.message}\n`)
    process.exit(2)
  }
  if (next.argv_digest === raw.argv_digest) {
    process.stdout.write(`${JSON.stringify({ outcome: 'unchanged', name, pid: raw.pid, argv_digest: raw.argv_digest })}\n`)
    process.exit(0)
  }
  atomicWrite(out, `${JSON.stringify({
    argv_digest: next.argv_digest,
    name: next.name,
    pid: next.pid,
    recorded_at: next.recorded_at,
    session: next.session,
    started_identity: next.started_identity,
  })}\n`)
  process.stdout.write(`${JSON.stringify({
    outcome: 'updated',
    name,
    pid: next.pid,
    argv_digest: next.argv_digest,
    previous_argv_digest: raw.argv_digest,
  })}\n`)
}
