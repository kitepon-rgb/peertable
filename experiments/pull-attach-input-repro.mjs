#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = resolve(fileURLToPath(new URL('../skill/scripts/pull-attach-input.mjs', import.meta.url)))
const dir = mkdtempSync(join(tmpdir(), 'peertable-attach-'))
const seat = join(dir, 'hinata.json')
writeFileSync(seat, JSON.stringify({
  name: 'hinata',
  session: 'hinata',
  pid: 31866,
  started_identity: 'Sat Aug 22 14:42:46 2026',
  argv_digest: 'abc',
  recorded_at: '2026-08-22T05:43:18.000Z',
}))

try {
  const ok = JSON.parse(execFileSync(process.execPath, [helper, seat], { encoding: 'utf8' }))
  assert.equal(ok.schema, 'lattice.pull_worker_attach_input.v1')
  assert.equal(ok.pid, 31866)

  const matched = JSON.parse(execFileSync(process.execPath, [helper, seat, '31866'], { encoding: 'utf8' }))
  assert.equal(matched.pid, 31866)

  let mismatch = ''
  try {
    execFileSync(process.execPath, [helper, seat, '45907'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    mismatch = `${error.stderr}${error.stdout}`
    assert.equal(error.status, 2)
  }
  assert.match(mismatch, /WORKER_IDENTITY_MISMATCH/)
  assert.match(mismatch, /45907/)
  assert.doesNotMatch(mismatch, /runtime down|実行層の死亡|可視性を復旧/)
  assert.match(mismatch, /実行層死亡ではない/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('pull attach input: green')
