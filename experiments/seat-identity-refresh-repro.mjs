#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashArgv, refreshSeatRecord } from '../skill/scripts/refresh-seat-identity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const identSrc = readFileSync(join(root, 'skill/scripts/seat-identity.mjs'), 'utf8')
const refreshSrc = readFileSync(join(root, 'skill/scripts/refresh-seat-identity.mjs'), 'utf8')
const member = readFileSync(join(root, 'skill/templates/member.md'), 'utf8')

assert.match(identSrc, /'-o', 'command='/)
assert.doesNotMatch(identSrc, /'-o', 'args='/)
assert.match(refreshSrc, /'-o', 'command='/)
assert.match(member, /refresh-seat-identity\.mjs/)

const raw = {
  argv_digest: 'old',
  name: 'hinata',
  pid: 31866,
  recorded_at: '2026-08-22T05:43:18.000Z',
  session: 'hinata',
  started_identity: 'Sat Aug 22 14:42:46 2026',
}
const observed = {
  pid: 31866,
  started_identity: 'Sat Aug 22 14:42:46 2026',
  argv: 'node /bin/codex',
  argv_digest: hashArgv('node /bin/codex'),
}
const next = refreshSeatRecord(raw, observed, '2026-08-22T07:00:00.000Z')
assert.equal(next.argv_digest, observed.argv_digest)
assert.equal(next.pid, 31866)
assert.equal(next.started_identity, raw.started_identity)
assert.equal(next.recorded_at, '2026-08-22T07:00:00.000Z')

assert.throws(
  () => refreshSeatRecord(raw, { ...observed, pid: 1 }, 't'),
  (error) => error.code === 'SEAT_IDENTITY_PID_CHANGED',
)
assert.throws(
  () => refreshSeatRecord(raw, { ...observed, started_identity: 'other' }, 't'),
  (error) => error.code === 'SEAT_IDENTITY_LSTART_CHANGED',
)

console.log('seat identity refresh: green')
