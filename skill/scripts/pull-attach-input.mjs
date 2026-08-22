#!/usr/bin/env node
// attach 入力は席 file だけから作る。呼び出し側の pid 推定を受け付けない。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(2)
}

const [seatFile, maybePid] = process.argv.slice(2)
if (!seatFile) fail('ATTACH_INPUT_ARGS', 'usage: pull-attach-input.mjs <seat.json> [refusedPid]')

let raw
try {
  raw = JSON.parse(readFileSync(resolve(seatFile), 'utf8'))
} catch (error) {
  fail('ATTACH_INPUT_UNREADABLE', error.message)
}

const pid = raw.pid
if (!Number.isSafeInteger(pid) || pid < 1) fail('ATTACH_INPUT_NO_PID', '席 file に pid が無い')
if (maybePid !== undefined) {
  const injected = Number(maybePid)
  if (injected !== pid) {
    fail(
      'WORKER_IDENTITY_MISMATCH',
      `invented pid ${injected} is not the seat file pid ${pid}（実行層死亡ではない）`,
    )
  }
}

const input = {
  schema: 'lattice.pull_worker_attach_input.v1',
  name: raw.name,
  session: raw.session,
  pid,
  started_identity: raw.started_identity,
  argv_digest: raw.argv_digest,
  recorded_at: raw.recorded_at,
}
process.stdout.write(`${JSON.stringify(input)}\n`)
